use super::*;

const SAMPLE: &str = r#"{"providers":[
  {"id":"claude","accounts":[
    {"label":"a@example.com","active":false,"quotas":[{"key":"7d","usedPct":100,"resetText":"5d7h"}]},
    {"label":"b@example.com","active":true,"quotas":[{"key":"5h","usedPct":12,"resetText":"2h"},{"key":"7d","usedPct":33,"resetText":"5d6h"}]}]},
  {"id":"hidden","menuOnly":true,"accounts":[{"label":"x","quotas":[]}]}]}"#;

fn opaque(s: &Strip) -> usize {
    s.rgba.chunks(4).filter(|p| p[3] > 0).count()
}

#[test]
fn parses_orders_and_skips_menu_only() {
    let cols = parse_overview(SAMPLE).unwrap();
    assert_eq!(cols.len(), 2);
    assert_eq!(cols[0].label, "a@example.com", "service order is kept");
    assert_eq!(
        cols[1].quotas[1],
        Quota { key: "7D".into(), status: "ok".into(), used_pct: 33, reset_text: "5d6h".into() }
    );
}

#[test]
fn no_service_keeps_the_plain_icon() {
    assert!(!strip_due(false, false), "never answered: no strip, no offline");
    assert!(strip_due(false, true));
    assert!(strip_due(true, false), "service went down after answering: offline strip");
}

#[test]
fn garbage_is_none() {
    assert!(parse_overview("<html>").is_none());
}

#[test]
fn service_down_draws_offline_not_blank() {
    let s = render_strip(None, &Extras::default());
    assert!(s.width > 20 && opaque(&s) > 50, "offline strip must have ink");
}

#[test]
fn strip_has_ink_and_scales_with_accounts() {
    let cols = parse_overview(SAMPLE).unwrap();
    let two = render_strip(Some(&cols), &Extras::default());
    let one = render_strip(Some(&cols[..1]), &Extras::default());
    assert_eq!(two.height, 44);
    assert!(two.width > one.width && opaque(&two) > opaque(&one));
}

/// Perf bar: a redraw happens every 60 s on a worker thread, so it must be cheap
/// and must not grow (same size and bytes every time, no cache that accumulates).
#[test]
fn redraw_is_cheap_and_stable() {
    let cols = parse_overview(SAMPLE).unwrap();
    let first = render_strip(Some(&cols), &Extras::default());
    let t = std::time::Instant::now();
    for _ in 0..200 {
        let s = render_strip(Some(&cols), &Extras::default());
        assert_eq!((s.width, s.rgba.len()), (first.width, first.rgba.len()));
        assert!(s.rgba == first.rgba, "redraw must be deterministic");
    }
    let per = t.elapsed().as_secs_f64() * 1000.0 / 200.0;
    assert!(per < 25.0, "render took {per:.1} ms (debug build budget 25 ms)");
}

#[test]
fn names_are_upper_case_and_cropped_with_an_ellipsis() {
    assert_eq!(crop_header("alpha-account", 500.0), "ALPHA-ACCOUNT");
    let cropped = crop_header("a.very.long.account.name.here", 40.0);
    assert!(cropped.ends_with('…') && cropped.chars().count() < 31);
}

#[test]
fn what_does_not_fit_collapses_into_plus_n() {
    let one = |n: usize| Column {
        provider: "claude".into(),
        label: format!("account{n}@example.com"),
        active: n == 0,
        current: false,
        reset_credits: 0,
        quotas: vec![Quota { key: "7D".into(), status: "ok".into(), used_pct: 10, reset_text: "5d6h".into() }],
    };
    let many: Vec<Column> = (0..20).map(one).collect();
    let narrow = render_strip_on(Some(&many), &Extras::default(), 1000.0);
    assert!(narrow.width as f32 <= MAX_STRIP_PT.min(1000.0 * SCREEN_SHARE) * SCALE + 4.0, "capped by the screen share");
    let wide = render_strip_on(Some(&many), &Extras::default(), 5000.0);
    assert!(wide.width > narrow.width);
    assert!(wide.width as f32 <= MAX_STRIP_PT * SCALE + 4.0);
}

/// A live service reading, names replaced: six accounts on a wide screen. The
/// original strip showed four columns and "+2"; the dials at its head are why.
#[test]
fn live_overview_collapses_like_the_original_strip() {
    let cols = parse_overview(include_str!("tray_overview_live.json")).expect("fixture parses");
    assert_eq!(cols.len(), 6);
    let extras = Extras {
        mac: crate::tray_dials::parse_mac(r#"{"effort":{"loadPct":100,"parts":[{"key":"cpu","pct":66,"level":2},{"key":"mem","pct":30,"level":0},{"key":"gpu","pct":60,"level":0},{"key":"disk","pct":77,"level":0}]}}"#),
        pace: crate::tray_dials::parse_pace(r#"{"overall":{"value":4.41,"zone":"sopra"}}"#),
    };
    assert!(extras.mac.is_some() && extras.pace.is_some());
    let with = render_strip_on(Some(&cols), &extras, 3440.0);
    let without = render_strip_on(Some(&cols), &Extras::default(), 3440.0);
    assert!(with.width as f32 / SCALE <= MAX_STRIP_PT, "capped");
    assert!(without.width > 0 && with.width > 0);
    let kept = |e: &Extras| hidden_count(&cols, e, 3440.0);
    assert_eq!(kept(&extras), 2, "four columns and +2 with the dials");
    assert_eq!(kept(&Extras::default()), 1, "without the dials one more fits");
}

/// Dumps the live-fixture strip as a PPM on a menu-bar grey when `TRAY_STRIP_DUMP`
/// names a file: the offscreen render the visual comparison starts from.
#[test]
fn dump_strip_for_the_visual_comparison() {
    let Ok(path) = std::env::var("TRAY_STRIP_DUMP") else { return };
    let cols = parse_overview(include_str!("tray_overview_live.json")).unwrap();
    let extras = Extras {
        mac: crate::tray_dials::parse_mac(r#"{"effort":{"loadPct":100,"parts":[{"key":"cpu","pct":66,"level":2},{"key":"mem","pct":30,"level":0},{"key":"gpu","pct":60,"level":0},{"key":"disk","pct":77,"level":0}]}}"#),
        pace: crate::tray_dials::parse_pace(r#"{"overall":{"value":4.41,"zone":"sopra"}}"#),
    };
    let st = render_strip_on(Some(&cols), &extras, 3440.0);
    let mut out = format!("P6\n{} {}\n255\n", st.width, st.height).into_bytes();
    for px in st.rgba.chunks(4) {
        let a = px[3] as f32 / 255.0;
        for c in 0..3 {
            out.push((px[c] as f32 * a + 40.0 * (1.0 - a)) as u8);
        }
    }
    std::fs::write(path, out).unwrap();
}

#[test]
fn dials_leave_ink_and_pace_text_uses_a_comma() {
    let cols = parse_overview(SAMPLE).unwrap();
    let extras = Extras {
        mac: crate::tray_dials::parse_mac(r#"{"effort":{"loadPct":40,"parts":[{"key":"cpu","pct":66,"level":2},{"key":"mem","pct":30,"level":0}]}}"#),
        pace: crate::tray_dials::parse_pace(r#"{"overall":{"value":1.2,"zone":"sopra"}}"#),
    };
    assert!(opaque(&render_strip_on(Some(&cols), &extras, 3440.0)) > opaque(&render_strip_on(Some(&cols), &Extras::default(), 3440.0)));
    assert_eq!(crate::tray_dials::pace_text(4.47), "4,47×");
    assert_eq!(crate::tray_dials::pace_text(1.2), "1,2×");
    assert!(crate::tray_dials::parse_pace(r#"{"overall":{"value":null}}"#).is_none());
}

#[test]
fn dead_port_is_none_fast() {
    // Port 1 is never open: connect must fail instead of hanging the poller.
    assert!(fetch_columns("http://127.0.0.1:1").is_none());
}

/// Writes the strip as PNG for the side-by-side proof:
/// TRAY_SNAPSHOT_OUT=/tmp/x.png [TRAY_SNAPSHOT_JSON=file] cargo test tray_quota::tests::snapshot
#[test]
fn snapshot() {
    let Ok(out) = std::env::var("TRAY_SNAPSHOT_OUT") else { return };
    let cols = match std::env::var("TRAY_SNAPSHOT_JSON") {
        Ok(f) => parse_overview(&std::fs::read_to_string(f).unwrap()),
        Err(_) => fetch_columns(&hub_base()),
    };
    let screen = std::env::var("TRAY_SNAPSHOT_SCREEN_W").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_SCREEN_PT);
    let strip = render_strip_on(cols.as_deref(), &Extras::default(), screen);
    let file = std::fs::File::create(out).unwrap();
    let mut enc = png::Encoder::new(file, strip.width, strip.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&strip.rgba).unwrap();
}


/// Sum of the absolute horizontal and vertical alpha steps: the edge energy of the ink.
#[cfg(target_os = "macos")]
fn edge_energy(c: &Canvas) -> f32 {
    let at = |x: u32, y: u32| c.px[((y * c.w + x) * 4 + 3) as usize] as f32;
    let mut sum = 0.0;
    for y in 0..c.h - 1 {
        for x in 0..c.w - 1 {
            sum += (at(x + 1, y) - at(x, y)).abs() + (at(x, y + 1) - at(x, y)).abs();
        }
    }
    sum
}

#[cfg(target_os = "macos")]
#[test]
fn coretext_text_is_at_least_as_sharp_as_ab_glyph() {
    let mut ct = Canvas::new(80, 40);
    let mut ab = Canvas::new(80, 40);
    let px = PCT_PT * SCALE;
    ct.glyphs(Face::MonoBold, "16%", 6.0, 26.0, px, [255, 255, 255], 1.0);
    ab.glyphs_ab(Face::MonoBold, "16%", 6.0, 26.0, px, [255, 255, 255], 1.0);
    let (e_ct, e_ab) = (edge_energy(&ct), edge_energy(&ab));
    assert!(e_ab > 0.0 && e_ct > 0.0, "no ink: ct {e_ct} ab {e_ab}");
    assert!(ct.px != ab.px, "the macOS path must not be ab_glyph");
    assert!(e_ct >= e_ab, "CoreText edge energy {e_ct} below ab_glyph {e_ab}");
}

#[cfg(target_os = "macos")]
#[test]
fn coretext_honours_the_weight_axis() {
    let ink = |w: f32| -> u32 {
        let m = crate::tray_coretext::rasterize("/System/Library/Fonts/SFNSMono.ttf", w, OPTICAL_SIZE_TEXT, 18.0, &['1', '6'], &[0.0, 11.0], 22.0).unwrap();
        m.a.iter().map(|&v| v as u32).sum()
    };
    assert!(ink(900.0) > ink(300.0) * 11 / 10, "weight variation has no effect");
}
