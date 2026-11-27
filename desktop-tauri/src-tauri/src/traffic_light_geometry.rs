//! Where a native traffic light sits on the app's own top row, as plain
//! arithmetic: `window_chrome::apply_traffic_lights` feeds it the live
//! container and frame heights, and the tests below pin it without AppKit.

/// The 12px disc AppKit draws at the top edge of each traffic light's taller
/// (14x16) frame. The client's `TRAFFIC_LIGHT_DOT_PX` is this same 12.
const TRAFFIC_LIGHT_DOT: f64 = 12.0;

/// The y origin, in the titlebar container's coordinates, that centres a
/// traffic light's DISC on the app's top row.
///
/// Measured: the AppKit titlebar container is 32px tall and top-flush with the
/// window, while the app draws its own row under it (Overlay style), 40 with
/// the tab strip and 46 with the tabs at the side. Centring in the 32px strip
/// left the lights ~4px high, so the target is the row's centre.
///
/// The DISC and not the frame: a frame centred on the row lands the disc ~2px
/// above it. Measured 2026-09-07 on the live window (v2.2.274, 40px row): discs
/// at y 12-25 (centre 18.5) against the wordmark's capitals at 15-26 (centre
/// 20.5) and the row's buttons at 20.
///
/// Clamped so the disc, not the whole frame, stays inside the container: on
/// the 46 row the disc spans 17..29, inside the 32px strip, while its frame
/// would end at 33. Clamping the frame cost the disc a pixel (centre 22 on a
/// row whose buttons centre on 23); only the frame's empty bottom edge is
/// allowed to overhang.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn traffic_light_y(row_px: f64, container_h: f64, frame_h: f64, flipped: bool) -> f64 {
    let dot = TRAFFIC_LIGHT_DOT.min(frame_h);
    let disc_top = row_px / 2.0 - TRAFFIC_LIGHT_DOT / 2.0;
    if flipped {
        // y grows downwards: the frame's top is the disc's top.
        disc_top.clamp(0.0, (container_h - dot).max(0.0))
    } else {
        // y grows upwards: the frame's top is at container_h - y - frame_h.
        let lo = dot - frame_h;
        let hi = (container_h - frame_h).max(lo);
        (container_h - disc_top - frame_h).clamp(lo, hi)
    }
}

#[cfg(test)]
mod traffic_light_y_tests {
    use super::traffic_light_y;

    // The live container (32px strip) and frame (16 tall) measured on the
    // window; the disc is the frame's top 12.
    const STRIP: f64 = 32.0;
    const FRAME: f64 = 16.0;

    /// The disc's centre, from the container's top, for a given origin.
    fn disc_centre(y: f64, flipped: bool) -> f64 {
        let top = if flipped { y } else { STRIP - y - FRAME };
        top + 6.0
    }

    #[test]
    fn the_disc_centres_on_the_strip_row_both_ways() {
        for flipped in [true, false] {
            let y = traffic_light_y(40.0, STRIP, FRAME, flipped);
            assert_eq!(disc_centre(y, flipped), 20.0, "flipped={flipped}");
        }
    }

    #[test]
    fn the_disc_centres_on_the_side_row_both_ways() {
        // 46: its frame would end at 33, past the 32px strip. The old clamp on
        // the frame put the disc at 22; the disc itself fits (17..29).
        for flipped in [true, false] {
            let y = traffic_light_y(46.0, STRIP, FRAME, flipped);
            assert_eq!(disc_centre(y, flipped), 23.0, "flipped={flipped}");
        }
    }

    #[test]
    fn a_row_too_tall_keeps_the_disc_inside_the_strip() {
        for flipped in [true, false] {
            let y = traffic_light_y(64.0, STRIP, FRAME, flipped);
            let centre = disc_centre(y, flipped);
            assert!(centre - 6.0 >= 0.0 && centre + 6.0 <= STRIP, "flipped={flipped} centre={centre}");
        }
    }
}
