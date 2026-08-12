// H.264 encoder loop on a dedicated OS thread. The encoder is !Send by construction
// (openh264's is; VideoToolbox's session we keep thread-local anyway), so it can NOT
// live on the async runtime (can't be held across an .await). It receives JPEG frames,
// decodes to RGB, encodes to Annex-B H.264, and hands samples to an async writer that
// fans them onto the shared WebRTC track.
//
// Two properties matter for a SHARED late-joining session:
//   - keyframe-on-demand: `need_keyframe` is set true when a new peer attaches, so a
//     late joiner syncs within one frame instead of waiting for the periodic IDR.
//   - keepalive re-encode: a STATIC page emits exactly one CDP screencast frame then
//     goes silent (screencast is change-driven). Without this, a peer that connects
//     after that single frame never gets a keyframe and stays black. So on an input
//     timeout we re-encode the LAST frame — cheap, and it keeps every viewer fed.
//
// CHI comprime (punto 5 del piano WebRTC): su macOS l'encoder è VideoToolbox, cioè il
// blocco hardware del SoC (vt.rs). openh264 resta come rete: altre piattaforme, e i
// casi in cui la sessione VT non nasce. Il salto non è solo "compressione in HW" —
// sparisce anche la conversione RGB→I420 che openh264 imponeva sulla CPU, perché a
// VideoToolbox il fotogramma si consegna in BGRA e la conversione colore la fa lui.
//
// Interruttore per la misura e per il debug: TOPICS_WEBRTC_SW_ENCODE=1 torna a openh264.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use tokio::sync::mpsc::Sender;

/// Un compressore H.264 che restituisce Annex-B. Due implementazioni: VideoToolbox
/// (hardware, macOS) e openh264 (software, ovunque).
pub trait H264Encoder {
    fn encode(&mut self, rgb: &[u8], force_idr: bool) -> Result<Vec<u8>>;
    fn label(&self) -> String;
}

// --- openh264 (software) ---------------------------------------------------

struct Openh264Encoder {
    enc: openh264::encoder::Encoder,
    w: usize,
    h: usize,
}

impl H264Encoder for Openh264Encoder {
    fn encode(&mut self, rgb: &[u8], force_idr: bool) -> Result<Vec<u8>> {
        use openh264::formats::{RgbSliceU8, YUVBuffer};
        if force_idr {
            self.enc.force_intra_frame();
        }
        // Il costo nascosto di questo percorso: la conversione colore la paga la CPU,
        // fotogramma per fotogramma, prima ancora di comprimere.
        let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(rgb, (self.w, self.h)));
        Ok(self.enc.encode(&yuv).map_err(|e| anyhow!("openh264: {e}"))?.to_vec())
    }
    fn label(&self) -> String {
        "openh264 (software)".into()
    }
}

fn new_openh264(w: usize, h: usize) -> Result<Box<dyn H264Encoder>> {
    let enc = openh264::encoder::Encoder::new().map_err(|e| anyhow!("openh264 create: {e}"))?;
    Ok(Box::new(Openh264Encoder { enc, w, h }))
}

// --- VideoToolbox (hardware, macOS) ----------------------------------------

#[cfg(target_os = "macos")]
impl H264Encoder for crate::vt::VtEncoder {
    fn encode(&mut self, rgb: &[u8], force_idr: bool) -> Result<Vec<u8>> {
        crate::vt::VtEncoder::encode(self, rgb, force_idr)
    }
    fn label(&self) -> String {
        format!("VideoToolbox ({})", if self.hardware { "hardware" } else { "software" })
    }
}

/// Bitrate obiettivo per una pane a `w×h`. Una pagina web è quasi tutta piatta e
/// statica: la curva utile sta molto sotto quella di un video reale. ~3 bit per
/// pixel-al-secondo dà 2,8 Mbps a 720p e 6,2 a 1080p, con un tetto perché un
/// 1440p su Wi-Fi non ha senso che pretenda 12 Mbps di picco.
/// Sovrascrivibile con TOPICS_WEBRTC_BITRATE (bit al secondo).
fn target_bitrate(w: usize, h: usize) -> i32 {
    if let Some(v) = std::env::var("TOPICS_WEBRTC_BITRATE").ok().and_then(|s| s.parse::<i32>().ok()) {
        if v > 0 {
            return v;
        }
    }
    ((w * h) as f64 * 3.0).clamp(1_000_000.0, 12_000_000.0) as i32
}

/// Costruisce l'encoder migliore disponibile per queste dimensioni.
pub fn new_encoder(w: usize, h: usize) -> Result<Box<dyn H264Encoder>> {
    let force_sw = std::env::var("TOPICS_WEBRTC_SW_ENCODE").ok().as_deref() == Some("1");
    #[cfg(target_os = "macos")]
    if !force_sw {
        match crate::vt::VtEncoder::new(w, h, 30.0, target_bitrate(w, h)) {
            Ok(e) => return Ok(Box::new(e)),
            // Non è fatale: si scende su openh264 e la pane continua a vedersi.
            Err(e) => eprintln!("[enc] VideoToolbox non disponibile ({e}) — ripiego su openh264"),
        }
    }
    let _ = force_sw;
    new_openh264(w, h)
}

/// Blocking encoder loop: JPEG → RGB → H.264 Annex-B → `sample_tx`.
/// Exits when `rx` closes (producer dropped) or `sample_tx` closes (writer gone).
pub fn encode_thread(rx: Receiver<Vec<u8>>, sample_tx: Sender<Vec<u8>>, need_keyframe: Arc<AtomicBool>) {
    use zune_jpeg::JpegDecoder;

    // Re-encode the last frame if no new one arrives within this window (static pages).
    const KEEPALIVE: Duration = Duration::from_millis(500);
    // Periodic keyframe on a WALL-CLOCK timer (NOT a frame count): a late-joining peer
    // must get an IDR within ~1s regardless of the source frame rate. Frame-count IDR
    // starves static pages — at the ~2fps keepalive rate a 60-frame gap is ~30s, so a
    // viewer that connects a few seconds in never decodes (framesDecoded stuck at 0).
    const KEYFRAME_EVERY: Duration = Duration::from_millis(1000);

    let mut encoder: Option<(Box<dyn H264Encoder>, usize, usize)> = None;
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
            match new_encoder(w, h) {
                Ok(enc) => {
                    eprintln!("[enc] encoder {w}x{h} — {}", enc.label());
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

        let force_idr = need_keyframe.swap(false, Ordering::Relaxed) || last_key.elapsed() >= KEYFRAME_EVERY;
        if force_idr {
            last_key = Instant::now();
        }

        let data = match enc.encode(&rgb, force_idr) {
            Ok(bs) => bs,
            Err(e) => {
                eprintln!("[enc] encode: {e}");
                // Una sessione VT che va in errore non si riprende da sola: si butta
                // l'encoder e il giro dopo se ne costruisce uno nuovo. Senza questo un
                // singolo errore trasformava la pane in un fermo immagine per sempre.
                encoder = None;
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

/// Banco di misura: `webrtc-bridge --bench <frame.jpg> [n]`.
///
/// Esiste perché il punto 5 va PROVATO, e "sembra più fluido" non è una prova.
/// Comprime lo stesso fotogramma n volte con entrambi gli encoder e stampa
/// millisecondi per fotogramma e tempo CPU consumato dal processo — che è il
/// numero che conta: il lavoro tolto alla CPU è tutto il senso del cambio.
pub fn bench(jpeg_path: &str, frames: usize) -> Result<()> {
    use zune_jpeg::JpegDecoder;
    let jpeg = std::fs::read(jpeg_path)?;
    let mut dec = JpegDecoder::new(&jpeg);
    let rgb = dec.decode().map_err(|e| anyhow!("jpeg: {e}"))?;
    let (w, h) = dec.dimensions().ok_or_else(|| anyhow!("jpeg senza dimensioni"))?;
    let (w, h) = (w as usize & !1, h as usize & !1);
    let rgb = rgb[..w * h * 3].to_vec();
    println!("banco: {w}x{h}, {frames} fotogrammi\n");

    for (name, force_sw) in [("openh264 (software)", true), ("VideoToolbox", false)] {
        if force_sw {
            std::env::set_var("TOPICS_WEBRTC_SW_ENCODE", "1");
        } else {
            std::env::remove_var("TOPICS_WEBRTC_SW_ENCODE");
        }
        let mut enc = match new_encoder(w, h) {
            Ok(e) => e,
            Err(e) => {
                println!("{name}: non disponibile ({e})");
                continue;
            }
        };
        // Un giro a vuoto: la prima compressione paga l'allocazione delle risorse.
        let _ = enc.encode(&rgb, true);

        let cpu0 = cpu_time();
        let t0 = Instant::now();
        let mut bytes = 0usize;
        for i in 0..frames {
            bytes += enc.encode(&rgb, i % 30 == 0)?.len();
        }
        let wall = t0.elapsed();
        let cpu = cpu_time() - cpu0;
        println!(
            "{:<28} {:>7.2} ms/frame   cpu {:>7.2} ms/frame   ({:.0} fps)   {:>5.0} kB/frame   [{}]",
            name,
            wall.as_secs_f64() * 1000.0 / frames as f64,
            cpu * 1000.0 / frames as f64,
            frames as f64 / wall.as_secs_f64(),
            bytes as f64 / frames as f64 / 1024.0,
            enc.label(),
        );
    }
    std::env::remove_var("TOPICS_WEBRTC_SW_ENCODE");
    Ok(())
}

/// Tempo CPU (utente+sistema) consumato da QUESTO processo, in secondi.
/// getrusage, non l'orologio a muro: un encoder hardware aspetta il SoC, e
/// quell'attesa non è CPU spesa — misurare a muro la regalerebbe a openh264.
fn cpu_time() -> f64 {
    #[repr(C)]
    #[derive(Default)]
    struct Timeval {
        tv_sec: i64,
        tv_usec: i32,
        _pad: i32,
    }
    #[repr(C)]
    struct Rusage {
        ru_utime: Timeval,
        ru_stime: Timeval,
        rest: [i64; 14],
    }
    extern "C" {
        fn getrusage(who: i32, usage: *mut Rusage) -> i32;
    }
    let mut ru = Rusage {
        ru_utime: Timeval::default(),
        ru_stime: Timeval::default(),
        rest: [0; 14],
    };
    unsafe {
        if getrusage(0 /* RUSAGE_SELF */, &mut ru) != 0 {
            return 0.0;
        }
    }
    ru.ru_utime.tv_sec as f64
        + ru.ru_utime.tv_usec as f64 / 1e6
        + ru.ru_stime.tv_sec as f64
        + ru.ru_stime.tv_usec as f64 / 1e6
}
