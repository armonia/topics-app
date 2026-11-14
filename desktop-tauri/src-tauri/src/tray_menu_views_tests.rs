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
  {"provider":"codex","email":"b@example.org","used":40,"state":{"text":"in ritmo","tone":"ok","dial":true},"gauge":{"needle":0.8,"zone":"ok"},
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
    assert_eq!(labels, ["Fine", "Token", "24 h"]);
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
