// H.264 encoder loop on a dedicated OS thread. openh264's Encoder is !Send, so it can
// NOT live on the async runtime (can't be held across an .await). It receives JPEG
// frames, decodes to RGB, encodes to Annex-B H.264, and hands samples to an async
// writer that fans them onto the shared WebRTC track.
//
// Two properties matter for a SHARED late-joining session:
//   - keyframe-on-demand: `need_keyframe` is set true when a new peer attaches, so a
//     late joiner syncs within one frame instead of waiting for the periodic IDR.
//   - keepalive re-encode: a STATIC page emits exactly one CDP screencast frame then
//     goes silent (screencast is change-driven). Without this, a peer that connects
//     after that single frame never gets a keyframe and stays black. So on an input
//     timeout we re-encode the LAST frame — cheap, and it keeps every viewer fed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::Sender;

/// Blocking encoder loop: JPEG → RGB → I420 → H.264 → `sample_tx`.
/// Exits when `rx` closes (producer dropped) or `sample_tx` closes (writer gone).
pub fn encode_thread(rx: Receiver<Vec<u8>>, sample_tx: Sender<Vec<u8>>, need_keyframe: Arc<AtomicBool>) {
    use openh264::encoder::Encoder;
    use openh264::formats::{RgbSliceU8, YUVBuffer};
    use zune_jpeg::JpegDecoder;

    // Re-encode the last frame if no new one arrives within this window (static pages).
    const KEEPALIVE: Duration = Duration::from_millis(500);
    // Periodic keyframe on a WALL-CLOCK timer (NOT a frame count): a late-joining peer
    // must get an IDR within ~1s regardless of the source frame rate. Frame-count IDR
    // starves static pages — at the ~2fps keepalive rate a 60-frame gap is ~30s, so a
    // viewer that connects a few seconds in never decodes (framesDecoded stuck at 0).
    const KEYFRAME_EVERY: Duration = Duration::from_millis(1000);

    let mut encoder: Option<(Encoder, usize, usize)> = None;
    let mut last: Option<(Vec<u8>, usize, usize)> = None; // last decoded RGB + dims
    let mut last_key = Instant::now() - Duration::from_secs(10); // force on first frame

    loop {
        // Get the next JPEG, or on timeout fall back to re-encoding the last RGB frame.
        let rgbframe: Option<(Vec<u8>, usize, usize)> = match rx.recv_timeout(KEEPALIVE) {
            Ok(jpeg) => {
                let mut dec = JpegDecoder::new(&jpeg);
                match (dec.decode(), dec.dimensions()) {
                    (Ok(rgb), Some((w, h))) => {
                        let (w, h) = (w as usize & !1, h as usize & !1); // even dims for 4:2:0
                        if w == 0 || h == 0 {
                            None
                        } else {
                            let rgb = rgb[..w * h * 3].to_vec();
                            last = Some((rgb.clone(), w, h));
                            Some((rgb, w, h))
                        }
                    }
                    (Err(e), _) => {
                        eprintln!("[enc] jpeg decode: {e}");
                        None
                    }
                    _ => None,
                }
            }
            Err(RecvTimeoutError::Timeout) => last.clone(), // keepalive: re-emit last frame
            Err(RecvTimeoutError::Disconnected) => break,
        };

        let (rgb, w, h) = match rgbframe {
            Some(f) => f,
            None => continue,
        };

        let need_new = match &encoder {
            Some((_, ew, eh)) => *ew != w || *eh != h,
            None => true,
        };
        if need_new {
            match Encoder::new() {
                Ok(enc) => {
                    eprintln!("[enc] encoder {w}x{h}");
                    encoder = Some((enc, w, h));
                    need_keyframe.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    eprintln!("[enc] create: {e}");
                    continue;
                }
            }
        }
        let (enc, _, _) = encoder.as_mut().unwrap();

        if need_keyframe.swap(false, Ordering::Relaxed) || last_key.elapsed() >= KEYFRAME_EVERY {
            enc.force_intra_frame();
            last_key = Instant::now();
        }

        let rgb_src = RgbSliceU8::new(&rgb, (w, h));
        let yuv = YUVBuffer::from_rgb8_source(rgb_src);
        let data = match enc.encode(&yuv) {
            Ok(bs) => bs.to_vec(),
            Err(e) => {
                eprintln!("[enc] encode: {e}");
                continue;
            }
        };
        if data.is_empty() {
            continue;
        }
        if sample_tx.blocking_send(data).is_err() {
            break; // writer gone
        }
    }
}
