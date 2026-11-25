//! Parsing of fake service answers, one test per section, and the PNG snapshot of
//! the views for the side-by-side proof. Card 1aba05b4.

use super::*;

const BOARD: &str = r#"{
 "machines":[
  {"id":"local","name":"Machine A","state":"impegnato","level":1,"lines":["CPU intasata · altro","In pausa"],
   "metrics":[{"key":"cpu","name":"CPU","pct":55,"level":1,"note":"lavori in coda"},{"key":"mem","name":"Memoria","pct":41,"level":0,"note":"pressione"},
              {"key":"gpu","name":"GPU","pct":62,"level":0,"note":"picco 24 h 99%"},{"key":"disk","name":"Disco","pct":81,"level":0,"note":"194 GB liberi"}]},
  {"id":"pc","name":"Machine B","state":"dorme","level":0,"lines":[],"metrics":[]},
  {"id":"x","name":"","state":"?"}],
 "accounts":[
  {"provider":"claude","email":"a@example.org","used":100,"state":{"text":"esaurito → dom 10:00","tone":"bad"},
   "gauge":{"needle":2,"zone":"frenato"},"windows":[{"key":"week","label":"7 g","used":100,"reset":"dom 10:00","tone":"bad"}],
   "plan":{"label":"Piano","value":"Ultra","right":"23/11","tone":"mut"},"api":{"label":"API","value":"—","right":"da leggere","tone":"mut"},"end":null,"tokens":null},
  {"provider":"codex","email":"b@example.org","used":40,"state":{"text":"in ritmo","tone":"ok","dial":true},"gauge":{"needle":0.8,"zone":"ok","day":2.5},
   "windows":[{"key":"5h","label":"5 h","used":30,"reset":"tra 2 h","tone":"ok","mark":50},{"key":"week","label":"7 g","used":40,"reset":"gio 09:00","tone":"ok"},{"key":"day","label":"24 h","used":12,"tone":"ok","note":"ok"}],
   "tokens":{"left":"231 M","perDay":"283 M/g"},"end":{"text":"finisce oggi 23:12","tone":"bad"}}]}"#;

const BACKUP: &str = r#"{"last_ok":1799990000,"last_read_check":1799900000,"last_restore_ok":1799000000,"pending_since":null,
 "runs":[{"at":1797500000,"ok":true},{"at":1797600000,"ok":false},{"at":1799990000,"ok":true}],"icloud":{"files":10,"uploaded":10,"bytes":3221225472}}"#;
const NOW: i64 = 1_800_000_000;

#[test]
fn machines_parse_from_the_board_and_skip_nameless_rows() {
    let m = machine_cards_from_board(BOARD);
    assert_eq!(m.len(), 2);
    assert_eq!((m[0].badge.as_str(), m[0].reason.as_str()), ("impegnato", "CPU intasata"));
    assert_eq!(m[0].metrics.len(), 4);
    assert!(m[1].metrics.is_empty() && m[1].reason.is_empty());
    assert!(machine_cards_from_board("not json").is_empty());
}

#[test]
fn quota_cards_put_spent_accounts_last_and_keep_every_minor_row() {
    let q = quota_cards(BOARD);
    assert_eq!(q.len(), 2);
    assert_eq!(q[0].who, "b@example.org");
    assert_eq!(q[0].needle, Some(0.8));
    assert_eq!(q[0].five_hour.as_ref().map(|m| m.mark), Some(Some(50.0)));
    let labels: Vec<_> = q[0].minors.iter().map(|m| m.label.as_str()).collect();
    // the 24 hour window is a pace: one sentence across the card, in times the sustainable one, and not a percentage
    assert_eq!(labels, ["Finisce", "Token", ""]);
    assert_eq!(q[0].minors[2].whole, "Ritmo: 2,5× il sostenibile");
    assert_eq!(q[0].minors[1].right, "rimasti", "tokens say they are what is left");
    assert_eq!(ratio_text(29.0), "29");
    assert_eq!(q[1].needle, None, "no dial unless the state asks for it");
    assert!(q[1].five_hour.is_none() && q[1].week.is_some());
    assert!(quota_cards("{}").is_empty());
}

#[test]
fn backup_card_judges_days_and_proofs() {
    let b = backup_card(BACKUP, NOW).unwrap();
    assert_eq!((b.badge.as_str(), b.level), ("a posto", 0));
    assert_eq!(b.days.len(), 30);
    assert_eq!(b.days.last(), Some(&Some(true)));
    assert!(b.days_say.ends_with("riusciti"));
    assert_eq!(b.proofs.len(), 4);
    assert!(backup_card("{\"error\":1}", NOW).is_some(), "an object is a state, even an empty one");
    assert!(backup_card("nope", NOW).is_none());
    let failed = backup_card(r#"{"last_ok":1,"last_error":"x"}"#, NOW).unwrap();
    assert_eq!(failed.level, 2);
}

#[test]
fn a_reading_the_dial_cannot_show_is_a_legend_row_not_the_line() {
    let spend = Metric { key: "spend".into(), name: "Spesa".into(), value: "8,44/60 €".into(), pct: Some(14), level: 2, ..Default::default() };
    let cpu = Metric { key: "cpu".into(), pct: Some(30), ..Default::default() };
    let m = MachineCard { name: "Server".into(), badge: "spento".into(), reason: "Oltre il tetto".into(), metrics: vec![spend, cpu.clone()], ..Default::default() };
    assert_eq!(card_line(&m), "Oltre il tetto");
    assert_eq!(extra_rows(&m).iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), ["spend"]);
    // the swap is the note of the memory row, never a row of its own
    let swap = Metric { key: "swap".into(), value: "5/6 GB".into(), ..Default::default() };
    assert!(extra_rows(&MachineCard { metrics: vec![swap, cpu], ..Default::default() }).is_empty());
    assert_eq!(card_line(&MachineCard::default()), "");
}

#[test]
fn backup_card_has_the_private_archive_the_foot_and_the_next_run() {
    let fresh = r#"{"last_ok":1799990000,"private_at":1799980000,"last_seconds":239,"icloud":{"local_bytes":1288490188,"files":1,"uploaded":1,"bytes":1}}"#;
    let b = backup_card(fresh, NOW).unwrap();
    assert!(b.caption.ends_with("prossima alle 5:00"), "{}", b.caption);
    assert!(b.proofs.iter().any(|p| p.0 == "Archivio privato" && p.2));
    assert_eq!(b.foot, "Sul Mac: Adesso niente · ultimo giro 4 min · 1,2 GB sul disco");
    let stale = fresh.replace("1799980000", "1799800000");
    let bad = backup_card(&stale, NOW).unwrap();
    assert_eq!((bad.level, bad.proofs.iter().any(|p| p.0 == "Archivio privato" && !p.2)), (2, true));
    assert!(bad.caption.starts_with("Archivio privato fermo"));
    // an older service has no such field: no false alarm
    assert!(!backup_card(BACKUP, NOW).unwrap().proofs.iter().any(|p| p.0 == "Archivio privato"));
    let running = backup_card(r#"{"last_ok":1799990000,"pending_since":1799999000,"run_phase":"sta controllando i dati"}"#, NOW).unwrap();
    assert_eq!(running.foot, "Sul Mac: sta controllando i dati");
    let (with, without) = (draw_backup_card(&b, Palette::new(true)), draw_backup_card(&BackupCard { foot: String::new(), ..b.clone() }, Palette::new(true)));
    // a line of its own, or the free half of an odd last row (the layout test below says which)
    assert!(with.cv.h >= without.cv.h, "the foot never takes space away");
}

#[test]
fn the_server_card_is_the_pc_card_with_one_more_row_for_its_spend() {
    let p = Palette::new(true);
    let hw = |k: &str, v: u32| Metric { key: k.into(), pct: Some(v), ..Default::default() };
    let pc = MachineCard { id: "pc".into(), name: "PC".into(), badge: "lavora".into(), metrics: vec![hw("cpu", 5), hw("mem", 32), hw("disk", 97)], ..Default::default() };
    let mut server = MachineCard { id: "hetzner".into(), name: "Server".into(), ..pc.clone() };
    let plain = draw_machine_card(&server, p);
    server.metrics.push(Metric { key: "spend".into(), name: "Spesa".into(), value: "8,44/60 €".into(), pct: Some(14), level: 2, ..Default::default() });
    let with_spend = draw_machine_card(&server, p);
    assert_eq!(plain.cv.h, draw_machine_card(&pc, p).cv.h, "same card as the PC");
    // three readings and the spend are four rows: the card grows by what the dial's own height did not already hold
    assert!(with_spend.cv.h > plain.cv.h, "the spend is one more legend row");
    assert!(with_spend.cv.h <= plain.cv.h + 36, "and not more than one row (18 pt at 2x)");
    // a server that measures only its spend still gets the dial's height, not a squashed card
    let only_spend = MachineCard { metrics: vec![server.metrics[3].clone()], ..server.clone() };
    assert_eq!(draw_machine_card(&only_spend, p).cv.h, plain.cv.h);
}

#[test]
fn every_view_renders_ink_at_the_menu_width() {
    let p = Palette::new(true);
    let m = machine_cards_from_board(BOARD);
    for card in &m {
        let pic = draw_machine_card(card, p);
        assert_eq!(pic.cv.w, (MENU_W * 2.0) as u32);
        assert!(pic.cv.px.chunks(4).any(|px| px[3] > 0));
    }
    assert!(draw_quota_panel(&quota_cards(BOARD), p).is_some());
    assert!(draw_quota_panel(&[], p).is_none());
    assert!(draw_backup_card(&backup_card(BACKUP, NOW).unwrap(), p).to_png().is_some());
}

/// TRAY_MENU_SNAPSHOT_DIR=/tmp/x cargo test --lib tray_menu_views -- snapshot
/// writes machines.png, quota.png and backup.png (dark and light) from the fake answers above,
/// or from TRAY_MENU_SNAPSHOT_BOARD / TRAY_MENU_SNAPSHOT_BACKUP files when given, plus the
/// Topics machines (the client's `set_app_status` list) from TRAY_MENU_SNAPSHOT_MACHINES.
#[test]
fn snapshot() {
    let Ok(dir) = std::env::var("TRAY_MENU_SNAPSHOT_DIR") else { return };
    let read = |k: &str, d: &str| std::env::var(k).ok().map(|f| std::fs::read_to_string(f).unwrap()).unwrap_or(d.to_string());
    let (board, backup) = (read("TRAY_MENU_SNAPSHOT_BOARD", BOARD), read("TRAY_MENU_SNAPSHOT_BACKUP", BACKUP));
    let now = if std::env::var("TRAY_MENU_SNAPSHOT_BOARD").is_ok() { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 } else { NOW };
    // the process table is native rows, not a picture: its text goes next to the pictures
    if let (Ok(procs), Ok(trust)) = (std::env::var("TRAY_MENU_SNAPSHOT_PROCS"), std::env::var("TRAY_MENU_SNAPSHOT_TRUST")) {
        let cpu = std::env::var("TRAY_MENU_SNAPSHOT_PS").ok().map(|f| crate::tray_menu::parse_ps(&std::fs::read_to_string(f).unwrap())).unwrap_or_default();
        let snap = crate::tray_menu::Snapshot { procs: Some(std::fs::read_to_string(procs).unwrap()), trust: Some(std::fs::read_to_string(trust).unwrap()), cpu, ..Default::default() };
        std::fs::write(format!("{dir}/procs.txt"), crate::tray_menu::dump_text(&crate::tray_menu_procs::procs_table(&snap))).unwrap();
    }
    for (name, dark) in [("dark", true), ("light", false)] {
        let p = Palette::new(dark);
        // a stack of the views, on the menu's own background, as the menu shows them
        let client: Vec<crate::tray_menu_views::MachineCard> = std::env::var("TRAY_MENU_SNAPSHOT_MACHINES").ok()
            .map(|f| serde_json::from_str::<Vec<crate::tray_machines::StatusMachine>>(&std::fs::read_to_string(f).unwrap()).unwrap())
            .unwrap_or_default().iter().filter_map(|m| m.card()).collect();
        let snap = crate::tray_menu::Snapshot { board: Some(board.clone()), ..Default::default() };
        let mut pics: Vec<Pic> = crate::tray_menu_rich::machines_for(&client, &snap).iter().map(|m| draw_machine_card(m, p)).collect();
        pics.extend(draw_quota_panel(&quota_cards(&board), p));
        pics.extend(backup_card(&backup, now).map(|b| draw_backup_card(&b, p)));
        let total: u32 = pics.iter().map(|x| x.cv.h).sum();
        let (w, bg) = (pics[0].cv.w, if dark { 40u8 } else { 236 });
        let mut px = Vec::new();
        for _ in 0..(w * total) {
            px.extend([bg, bg, bg, 255]);
        }
        let mut y0 = 0usize;
        for pic in &pics {
            for (i, c) in pic.cv.px.chunks(4).enumerate() {
                let o = (y0 * w as usize + i) * 4;
                let a = c[3] as f32 / 255.0;
                for k in 0..3 {
                    px[o + k] = (c[k] as f32 * a + px[o + k] as f32 * (1.0 - a)) as u8;
                }
            }
            y0 += pic.cv.h as usize;
        }
        let file = std::fs::File::create(format!("{dir}/menu-{name}.png")).unwrap();
        let mut enc = png::Encoder::new(file, w, total);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&px).unwrap();
    }
}

#[test]
fn tray_machine_logos_have_the_sizes_of_the_original_tray() {
    // machineSym in ClaudeUsage.swift: the Apple logo at 14, a cloud at 13, the Windows logo at 12
    assert_eq!([machine_glyph_side("apple.logo"), machine_glyph_side("cloud"), machine_glyph_side("windows")], [14.0, 13.0, 12.0]);
}

// ---- layout rules of the card and the panel (card tray-impaginazione-compatta)

/// The rightmost painted column, in points, between two heights (points) of a card.
fn ink_right(pic: &Pic, y0: f32, y1: f32) -> f32 {
    let (w, scale) = (pic.cv.w as usize, crate::tray_quota::SCALE);
    let mut right = 0usize;
    for y in (y0 * scale) as usize..((y1 * scale) as usize).min(pic.cv.h as usize) {
        for x in (0..w).rev() {
            if pic.cv.px[(y * w + x) * 4 + 3] > 90 {
                right = right.max(x);
                break;
            }
        }
    }
    right as f32 / scale
}

#[test]
fn the_legend_of_a_card_reaches_the_right_margin_and_not_only_sixty_per_cent_of_it() {
    // short notes («lavori in coda») used to end the rows at the middle of the card, leaving the right side empty
    let hw = |k: &str, v: u32, note: &str| Metric { key: k.into(), pct: Some(v), note: note.into(), ..Default::default() };
    let m = MachineCard { id: "local".into(), local: true, name: "Mac".into(), badge: "impegnato".into(),
        metrics: vec![hw("cpu", 74, "lavori in coda"), hw("gpu", 57, "picco"), hw("mem", 58, "swap"), hw("disk", 95, "51 GB liberi")], ..Default::default() };
    for dark in [false, true] {
        let pic = draw_machine_card(&m, Palette::new(dark));
        let edge = ink_right(&pic, 30.0, 100.0);
        assert!(edge >= MENU_W - 16.0 - 2.0, "the legend stops at {edge} pt of {MENU_W}: its notes end on the right margin");
        assert!(edge <= MENU_W - 16.0 + 1.0, "and not past it ({edge})");
    }
}

#[test]
fn a_sentence_that_ends_in_its_figure_keeps_the_figure_when_it_is_shortened() {
    let long = "Barra completa della rubrica Contatti (tipi, lint, test, build, anteprima), da 7 minuti";
    let room = 330.0;
    assert!(Pic::text_w(Face::Sans, long, 10.5) > room, "the sample really is too long");
    let fit = fit_keeping_tail(Face::Sans, long, 10.5, room);
    assert!(Pic::text_w(Face::Sans, &fit, 10.5) <= room + 0.5, "{fit}");
    assert!(fit.ends_with(", da 7 minuti"), "the minutes are the part that matters: {fit}");
    assert_eq!(fit_keeping_tail(Face::Sans, "Collegato dal Mac", 10.5, room), "Collegato dal Mac", "a short one is left alone");
}

#[test]
fn a_remote_card_sets_a_long_reason_on_its_own_line_and_a_short_one_beside_the_name() {
    let base = MachineCard { id: "pc".into(), name: "PC Windows".into(), badge: "lavora".into(), ..Default::default() };
    let short = draw_machine_card(&MachineCard { reason: "da 7 minuti".into(), ..base.clone() }, Palette::new(true));
    let long = draw_machine_card(&MachineCard { reason: "Barra completa della rubrica Contatti (tipi, lint, test, build, anteprima), da 7 minuti".into(), ..base.clone() }, Palette::new(true));
    assert!(long.cv.h > short.cv.h, "a long one takes its own line instead of being cut after the name");
}

// the widths come from CoreText: the estimate used where there is none is wider and says nothing about the menu
#[cfg(target_os = "macos")]
#[test]
fn the_state_of_an_account_is_never_cut_when_it_has_a_time_to_split_off() {
    // the width left in a card of three to a row, beside the state's symbol
    let room = (MENU_W - 2.0 * PAD - 8.0 * 2.0) / 3.0 - 18.0 - 19.0;
    for state in ["solo riserva → dom 10:00", "esaurito → mer 05:00", "sopra ritmo", "solo riserva → dom 09:00"] {
        assert_ne!(state_plan(state, room), StatePlan::Cut, "«{state}» fits in {room} pt");
    }
    assert_eq!(state_plan("un testo molto più lungo del posto che resta alla riga dello stato", room), StatePlan::Cut);
}

#[test]
fn an_odd_proof_takes_the_footer_beside_it_when_it_fits_and_no_row_of_its_own() {
    let mut b = backup_card(BACKUP, NOW).unwrap();
    b.foot = "3,3 GB sul disco".into();
    let even = b.proofs.len() % 2 == 0;
    let beside = draw_backup_card(&b, Palette::new(true)).cv.h;
    let without = draw_backup_card(&BackupCard { foot: String::new(), ..b.clone() }, Palette::new(true)).cv.h;
    if even {
        assert!(beside > without);
    } else {
        assert_eq!(beside, without, "the right half of the last row holds the footer");
    }
    let long = BackupCard { foot: "Sul Mac: una frase troppo lunga per mezza riga della scheda, che resta intera".into(), ..b };
    assert!(draw_backup_card(&long, Palette::new(true)).cv.h > without, "a footer too wide for the half row keeps its own line, whole");
}

// the widths come from CoreText: the estimate used where there is none is wider and says nothing about the menu
#[cfg(target_os = "macos")]
#[test]
fn a_meter_names_what_its_share_is_of_and_keeps_the_time_of_its_reset() {
    let q = quota_cards(BOARD);
    assert_eq!(q[0].five_hour.as_ref().map(|m| m.label.as_str()), Some("5 ore"));
    assert_eq!(q[0].week.as_ref().map(|m| m.label.as_str()), Some("7 giorni"));
    // the longest reset of the sample fits the line next to its percentage: the arrow is what goes when it cannot
    let w = (MENU_W - 2.0 * PAD - 8.0 * 2.0) / 3.0 - 18.0;
    let used = Pic::text_w(Face::SansRegular, "7 giorni", 11.0) + 6.0 + Pic::text_w(Face::MonoBold, "100%", 14.0) + 8.0;
    assert!(used + Pic::text_w(Face::Mono, "dom 10:00", 10.5) <= w, "label, percentage and reset share {w} pt");
}

#[test]
fn a_remote_machines_description_is_not_coloured_like_trouble() {
    // the PC's disk is red, its card level high: the line of what it is doing stays a grey description
    let m = MachineCard { id: "pc".into(), name: "PC".into(), badge: "lavora".into(), level: 2, reason: "Barra completa della rubrica Contatti con i suoi test per un terminale, da 7 minuti".into(), ..Default::default() };
    let pic = draw_machine_card(&m, Palette::new(true));
    let red = |px: &[u8]| px[3] > 90 && px[0] > 200 && px[1] < 110 && px[2] < 110;
    let (w, scale) = (pic.cv.w as usize, crate::tray_quota::SCALE);
    let band = ((26.0 * scale) as usize * w * 4)..((42.0 * scale) as usize * w * 4);
    assert!(!pic.cv.px[band].chunks(4).any(red), "the second line of a remote card has no red ink");
}

#[test]
fn the_meters_of_an_account_are_named_by_what_they_cover_on_every_platform() {
    let q = quota_cards(BOARD);
    assert_eq!(q[0].five_hour.as_ref().map(|m| m.label.as_str()), Some("5 ore"));
    assert_eq!(q[0].week.as_ref().map(|m| m.label.as_str()), Some("7 giorni"));
}

// ---- the legend: one set of columns, and no row for a reading the machine does not have

fn metric(key: &str, pct: Option<u32>, note: &str) -> Metric {
    Metric { key: key.into(), pct, note: note.into(), ..Default::default() }
}

#[test]
fn a_reading_the_machine_does_not_have_is_not_a_row() {
    let m = MachineCard { metrics: vec![metric("cpu", Some(90), "14,4 di 16 core"), metric("gpu", None, ""), metric("mem", Some(48), ""), metric("disk", Some(24), "pieno")], ..Default::default() };
    let keys: Vec<&str> = legend_dial_rows(&m).iter().map(|r| r.0).collect();
    assert_eq!(keys, ["cpu", "mem", "disk"]);
    // a reading with a value but no note stays; one with a note and no value stays too (it says why)
    let n = MachineCard { metrics: vec![metric("gpu", None, "non misurata")], ..Default::default() };
    assert_eq!(legend_dial_rows(&n).len(), 1);
}

#[test]
fn a_wide_value_widens_the_value_column_for_every_row_and_the_bars_share_both_ends() {
    let labels = ["CPU", "Memoria", "Spesa"];
    let narrow = legend_cols(200.0, 524.0, &labels, &["66%".into(), "88%".into(), "9%".into()], &["7,9 di 12 core", "", ""]);
    let wide = legend_cols(200.0, 524.0, &labels, &["66%".into(), "88%".into(), "8,44/60 €".into()], &["7,9 di 12 core", "", ""]);
    // short values keep the column near where it always was (the text metrics differ a little between systems)
    assert!(narrow.val_right >= 300.0 && narrow.val_right < 312.0, "{narrow:?}");
    assert!(wide.val_right > narrow.val_right, "{wide:?}");
    // the widest value fits between the widest label and the column's end, whatever row it is on
    let value_w = Pic::text_w(Face::MonoBold, "8,44/60 €", 11.5);
    let label_end = 200.0 + 20.0 + Pic::text_w(Face::Sans, "Memoria", 10.5);
    assert!(wide.val_right - value_w >= label_end, "{wide:?}");
    assert!(wide.bar_x > wide.val_right && wide.bar_end > wide.bar_x + 40.0, "{wide:?}");
    // with no note on any row the bars run to the right margin
    assert_eq!(legend_cols(200.0, 524.0, &labels, &["1%".into(), "2%".into(), "3%".into()], &["", "", ""]).bar_end, 524.0);
}

#[test]
fn a_backup_day_says_its_date_and_its_outcome() {
    let b = backup_card(r#"{"last_ok":1800000000,"runs":[{"at":1799990000,"ok":true},{"at":1799900000,"ok":false}]}"#, 1_800_000_100).unwrap();
    let pic = draw_backup_card(&b, Palette::new(false));
    let z = &pic.hover[0];
    assert_eq!(z.points.len(), 30);
    let last = z.points.last().unwrap();
    assert!(last.label.ends_with("copia fatta") || last.label.ends_with("niente da giudicare"), "{}", last.label);
    assert!(z.points.iter().any(|p| p.label.ends_with("copia non riuscita")));
}

#[test]
fn a_note_at_the_edge_of_an_account_card_is_never_cut_while_a_smaller_form_fits() {
    let wide = Pic::text_w(Face::Mono, "ieri 14:18", 10.0) + 12.0;
    // room for everything: the text as it is, with its arrow
    assert_eq!(fit_note("ieri 14:18", wide + 1.0, true, 10.0), ("ieri 14:18".to_string(), 10.0, true));
    // a little less: the arrow goes first, the text stays whole
    let (t, size, arrow) = fit_note("ieri 14:18", wide - 6.0, true, 10.0);
    assert_eq!((t.as_str(), arrow), ("ieri 14:18", false));
    assert!(size <= 10.0);
    // much less: the day word goes, the time stays
    let (t, _, _) = fit_note("ieri 14:18", Pic::text_w(Face::Mono, "14:18", 9.0) + 1.0, true, 10.0);
    assert_eq!(t, "14:18");
    // nothing to cut when there is room for the time alone, and a note with no arrow never draws one
    assert!(!fit_note("14/12", 200.0, false, 10.0).2);
}

// ---- account cards: the provider next to the email, and the hub's sentence for a missing 5 hour reading

const HUB_ACCOUNTS: &str = r#"{"accounts":[
 {"provider":"claude","providerName":"Claude","email":"a@example.org","used":14,"state":{"text":"in ritmo","tone":"ok"},
  "fiveHour":{"state":"none","say":"nessun limite a 5 ore"},"windows":[{"key":"week","label":"7 g","used":14,"tone":"ok"}]},
 {"provider":"codex","providerName":"Codex","email":"a@example.org","used":16,"state":{"text":"in ritmo","tone":"ok"},
  "fiveHour":{"state":"ok","say":null},"windows":[{"key":"5h","label":"5 h","used":0,"tone":"ok"},{"key":"week","label":"7 g","used":16,"tone":"ok"}]},
 {"provider":"muse","providerName":"Muse","name":"Muse","used":69,"state":{"text":"in ritmo","tone":"ok"},
  "fiveHour":{"state":"unread","say":"da leggere"},"windows":[{"key":"week","label":"7 g","used":69,"tone":"ok"}]}]}"#;

#[test]
fn an_account_card_carries_its_provider_name_and_the_hubs_sentence_only_when_there_is_no_reading() {
    let q = quota_cards(HUB_ACCOUNTS);
    let by = |p: &str| q.iter().find(|c| c.provider == p).unwrap().clone();
    assert_eq!(by("claude").provider_name, "Claude");
    assert_eq!(by("claude").five_say, "nessun limite a 5 ore");
    assert_eq!(by("codex").five_say, "", "a read window has nothing to say");
    assert_eq!(by("muse").five_say, "da leggere");
}

// the widths come from CoreText: the estimate used where there is none is wider
#[cfg(target_os = "macos")]
#[test]
fn a_long_address_and_its_provider_share_the_room_of_a_card_whole() {
    let card_room = (MENU_W - 2.0 * PAD - 8.0 * 2.0) / 3.0 - 18.0 - 18.0;
    let real = who_line("abcd@example.org", "Claude", card_room);
    assert_eq!(real.who, "abcd@example.org", "{real:?}");
}

#[test]
fn the_provider_follows_the_email_unless_it_is_the_name_already() {
    let room = 127.0;
    let codex = who_line("b@example.org", "Codex", room);
    assert_eq!(codex.suffix, " · Codex");
    let claude = who_line("b@example.org", "Claude", room);
    assert_ne!(codex.suffix, claude.suffix, "two cards with one email tell each other apart");
    assert!(who_line("Muse", "Muse", room).suffix.is_empty(), "a Muse account is already called Muse");
    assert!(who_line("a@example.org", "", room).suffix.is_empty());
    // the email gives way, the provider stays: size first, then the cut
    let tight = who_line("abcdefghijklmnopqrstu@example.org", "Claude", 100.0);
    assert_eq!(tight.suffix, " · Claude");
    assert!(tight.size <= 9.0 && tight.who.ends_with('…'), "{tight:?}");
    let wide = who_line("a@example.org", "Claude", 300.0);
    assert_eq!((wide.who.as_str(), wide.size), ("a@example.org", 11.5));
}

#[test]
fn a_five_hour_row_without_a_reading_says_why_in_place_of_the_dash() {
    let p = Palette::new(true);
    let q = quota_cards(HUB_ACCOUNTS);
    let claude = q.iter().find(|c| c.provider == "claude").unwrap().clone();
    let silent = QuotaCard { five_say: String::new(), ..claude.clone() };
    let px = |c: &QuotaCard| draw_quota_panel(std::slice::from_ref(c), p).unwrap().cv.px;
    assert_ne!(px(&claude), px(&silent), "the sentence is drawn where the dash was");
    // a card that has the percentage ignores the sentence: the 5 hour reading wins
    let read = QuotaCard { five_hour: Some(Meter { label: "5 ore".into(), used: 30.0, ..Default::default() }), ..claude };
    assert_eq!(px(&read), px(&QuotaCard { five_say: String::new(), ..read.clone() }));
    // the sentence fits its room or shrinks: never wider than the line
    let (t, size) = say_fit("nessun limite a 5 ore", 60.0);
    assert!(Pic::text_w(Face::SansRegular, &t, size) <= 60.5 && size <= 10.0, "{t} {size}");
}

#[test]
fn a_meter_with_no_reading_is_its_line_alone_and_the_card_is_shorter() {
    let p = Palette::new(false);
    let q = quota_cards(HUB_ACCOUNTS);
    let claude = q.iter().find(|c| c.provider == "claude").unwrap().clone();
    let codex = q.iter().find(|c| c.provider == "codex").unwrap().clone();
    let h = |c: &QuotaCard| draw_quota_panel(std::slice::from_ref(c), p).unwrap().h;
    // claude: no 5 hour reading, a week; codex: both read. No minor rows on either: the gap is the missing bar's room
    assert!(claude.five_hour.is_none() && codex.five_hour.is_some());
    assert!(h(&claude) <= h(&codex) - 9.0, "{} vs {}", h(&claude), h(&codex));
    // neither window read: both lines alone
    let neither = QuotaCard { week: None, ..claude.clone() };
    assert!(h(&neither) <= h(&claude) - 9.0, "{} vs {}", h(&neither), h(&claude));
    // the same account with a 5 hour reading is as tall as the codex one: the bar's room comes back with the value
    let read = QuotaCard { five_hour: Some(Meter { label: "5 ore".into(), used: 0.0, ..Default::default() }), ..claude };
    assert_eq!(h(&read), h(&codex));
}
