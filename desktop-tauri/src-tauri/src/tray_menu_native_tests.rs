//! Draws the native rows of the tray menu (icons, tab stops, attributed titles) into
//! PNGs, because the status item itself may be hidden by a menu bar manager.
//! TRAY_MENU_NATIVE_SNAPSHOT=<dir> [TRAY_MENU_HUB=<url>] cargo test --lib native_rows -- --nocapture

use super::*;
use crate::tray_menu::Node;

const ROW_H: f64 = 22.0;
const WIDTH: f64 = 540.0;

/// Each node as a drawable line: icon spec, title kind, and whether a submenu arrow follows.
struct Line {
    icon: Option<String>,
    row: Option<TableRow>,
    text: String,
    sep: bool,
    arrow: bool,
    card: Option<(Vec<u8>, f64, f64)>,
}

fn lines_of(nodes: &[Node], out: &mut Vec<Line>) {
    for n in nodes {
        match n {
            Node::Icon { icon, node } => {
                let before = out.len();
                lines_of(std::slice::from_ref(&**node), out);
                if let Some(l) = out.get_mut(before) {
                    l.icon = Some(icon.clone());
                }
            }
            Node::Sep => out.push(Line { icon: None, row: None, text: String::new(), sep: true, arrow: false, card: None }),
            Node::Item { label, .. } => out.push(Line { icon: None, row: None, text: label.clone(), sep: false, arrow: false, card: None }),
            Node::Sub { label, .. } => out.push(Line { icon: None, row: None, text: label.clone(), sep: false, arrow: true, card: None }),
            Node::Card { png, w, h, children, .. } => out.push(Line { icon: None, row: None, text: String::new(), sep: false, arrow: !children.is_empty(), card: Some((png.clone(), *w as f64, *h as f64)) }),
            Node::Row { cells, header, table, look, children, .. } => out.push(Line { icon: None, row: Some(TableRow { cells: cells.clone(), header: *header, tabs: table.tabs(), look: *look }), text: String::new(), sep: false, arrow: !children.is_empty(), card: None }),
        }
    }
}

/// A row with a second line (kind, owner, since, or the summary under a table's header) is two lines tall, as
/// the real menu sizes it: a header sized as one line drew its second line over the first row of the table.
fn line_h(l: &Line) -> f64 {
    let two = l.row.as_ref().map_or(false, |r| r.cells.iter().enumerate().any(|(i, c)| (!r.header && i > 5) || c.starts_with('\n')));
    l.card.as_ref().map_or(if l.sep { 9.0 } else if two { ROW_H + 14.0 } else { ROW_H }, |c| c.2)
}

unsafe fn render(nodes: &[Node], dark: bool) -> Vec<u8> {
    let mut lines = Vec::new();
    lines_of(nodes, &mut lines);
    let height: f64 = lines.iter().map(|l| line_h(l)).sum::<f64>() + 8.0;
    let name = if dark { "NSAppearanceNameDarkAqua" } else { "NSAppearanceNameAqua" };
    let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns(name)];
    let _: () = msg_send![class!(NSAppearance), setCurrentAppearance: appearance];
    let rep: id = msg_send![class!(NSBitmapImageRep), alloc];
    let rep: id = msg_send![rep, initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(), pixelsWide: (WIDTH * 2.0) as isize, pixelsHigh: (height * 2.0) as isize, bitsPerSample: 8isize, samplesPerPixel: 4isize, hasAlpha: true, isPlanar: false, colorSpaceName: ns("NSDeviceRGBColorSpace"), bytesPerRow: 0isize, bitsPerPixel: 0isize];
    let _: () = msg_send![rep, setSize: NSSize::new(WIDTH, height)];
    let ctx: id = msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
    let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
    let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: ctx];
    let bg: id = if dark { msg_send![class!(NSColor), colorWithCalibratedWhite: 0.16f64, alpha: 1.0f64] } else { msg_send![class!(NSColor), colorWithCalibratedWhite: 0.93f64, alpha: 1.0f64] };
    let _: () = msg_send![bg, set];
    let full = NSRect::new(crate::mac::NSPoint::new(0.0, 0.0), NSSize::new(WIDTH, height));
    let _: () = msg_send![class!(NSBezierPath), fillRect: full];
    let mut top = 4.0;
    for l in &lines {
        let h = line_h(l);
        let y = height - top - h;
        if l.sep {
            let c: id = msg_send![class!(NSColor), separatorColor];
            let _: () = msg_send![c, set];
            let _: () = msg_send![class!(NSBezierPath), fillRect: NSRect::new(crate::mac::NSPoint::new(12.0, y + 4.0), NSSize::new(WIDTH - 24.0, 1.0))];
        } else if let Some((png, w, ch)) = &l.card {
            let data: id = msg_send![class!(NSData), dataWithBytes: png.as_ptr() as *const std::ffi::c_void, length: png.len()];
            let img: id = msg_send![class!(NSImage), alloc];
            let img: id = msg_send![img, initWithData: data];
            let _: () = msg_send![img, setSize: NSSize::new(*w, *ch)];
            let _: () = msg_send![img, drawAtPoint: crate::mac::NSPoint::new(0.0, y), fromRect: NSRect::new(crate::mac::NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)), operation: 2usize, fraction: 1.0f64];
        } else {
            if let Some(spec) = &l.icon {
                let img = icon_image(spec);
                if img != nil {
                    let s: NSSize = msg_send![img, size];
                    let _: () = msg_send![img, drawInRect: NSRect::new(crate::mac::NSPoint::new(10.0 + (16.0 - s.width) / 2.0, y + (h - s.height) / 2.0), s)];
                }
            }
            let title: id = match &l.row {
                Some(r) => row_title(r),
                None => {
                    let para: id = msg_send![class!(NSMutableParagraphStyle), new];
                    let font: id = msg_send![class!(NSFont), systemFontOfSize: 13.0f64];
                    let color: id = msg_send![class!(NSColor), labelColor];
                    let s: id = msg_send![class!(NSAttributedString), alloc];
                    msg_send![s, initWithString: ns(&l.text), attributes: attrs(font, color, para)]
                }
            };
            let _: () = msg_send![title, drawInRect: NSRect::new(crate::mac::NSPoint::new(34.0, y + 3.0), NSSize::new(WIDTH - 60.0, h - 4.0))];
            if l.arrow {
                let chev: id = msg_send![class!(NSImage), imageWithSystemSymbolName: ns("chevron.right"), accessibilityDescription: nil];
                if chev != nil {
                    let s: NSSize = msg_send![chev, size];
                    let _: () = msg_send![chev, drawInRect: NSRect::new(crate::mac::NSPoint::new(WIDTH - 20.0, y + (ROW_H - s.height) / 2.0), s)];
                }
            }
        }
        top += h;
    }
    let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
    let opts: id = msg_send![class!(NSDictionary), dictionary];
    let data: id = msg_send![rep, representationUsingType: 4usize, properties: opts];
    let len: usize = msg_send![data, length];
    let ptr: *const u8 = msg_send![data, bytes];
    std::slice::from_raw_parts(ptr, len).to_vec()
}

#[test]
fn native_rows() {
    let Ok(dir) = std::env::var("TRAY_MENU_NATIVE_SNAPSHOT") else { return };
    let base = std::env::var("TRAY_MENU_HUB").unwrap_or_else(|_| crate::tray_quota::hub_base());
    let mut snap = crate::tray_menu::Snapshot::fetch(&base, None);
    // TRAY_MENU_NATIVE_MACHINES=<file>: an /api/machines answer in place of the live one
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_MACHINES") {
        snap.machines = Some(std::fs::read_to_string(f).unwrap());
    }
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_BOARD") {
        snap.board = Some(std::fs::read_to_string(f).unwrap());
    }
    // TRAY_MENU_NATIVE_MEMORY=<file>: a memory-sync answer (the contract) while the service has no such endpoint
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_MEMORY") {
        snap.memory_sync = Some(std::fs::read_to_string(f).unwrap());
        snap.memory_sync_set = true;
    }
    // TRAY_MENU_NATIVE_POOL=<file>: a node-pool state in place of the live one
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_POOL") {
        snap.pool = Some(std::fs::read_to_string(f).unwrap());
    }
    // TRAY_MENU_NATIVE_HEALTH / _SYNC=<file>: the security and memory-sync files in place of the real ones
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_HEALTH") {
        snap.health = Some(std::fs::read_to_string(f).unwrap());
    }
    if let Ok(f) = std::env::var("TRAY_MENU_NATIVE_SYNC") {
        snap.harness_sync = Some(std::fs::read_to_string(f).unwrap());
    }
    // TRAY_MENU_NATIVE_CLIENT=<file>: the Topics machine list as the client ships it (`set_app_status`), the nodes' source
    let client: Vec<crate::tray_menu_views::MachineCard> = std::env::var("TRAY_MENU_NATIVE_CLIENT").ok()
        .map(|f| serde_json::from_str::<Vec<crate::tray_machines::StatusMachine>>(&std::fs::read_to_string(f).unwrap()).unwrap())
        .unwrap_or_default().iter().filter_map(|m| m.card()).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let machines = crate::tray_menu_rich::machines_for(&client, &snap);
    for (name, dark) in [("dark", true), ("light", false)] {
        let menu = crate::tray_menu_rich::build_menu_rich(&snap, crate::tray_menu::Prefs::default(), now, &machines, dark);
        // the top level, and the submenu of this computer (its first card)
        let first = menu.iter().find_map(|n| if let Node::Card { children, .. } = n { Some(children.clone()) } else { None }).unwrap_or_default();
        std::fs::write(format!("{dir}/native-top-{name}.png"), unsafe { render(&menu, dark) }).unwrap();
        std::fs::write(format!("{dir}/native-mac-{name}.png"), unsafe { render(&first, dark) }).unwrap();
        // every machine: its card alone and its submenu, side by side they must read the same
        for n in &menu {
            if let Node::Card { key, children, .. } = n {
                if let Some(id) = key.strip_prefix("machine:") {
                    std::fs::write(format!("{dir}/card-{id}-{name}.png"), unsafe { render(std::slice::from_ref(n), dark) }).unwrap();
                    std::fs::write(format!("{dir}/sub-{id}-{name}.png"), unsafe { render(children, dark) }).unwrap();
                }
            }
        }
    }
}

#[test]
fn state_cells_lead_with_a_symbol_and_other_cells_do_not() {
    assert_eq!(state_glyph("▸ 2"), Some(("sf:play.circle|ok", "2")));
    assert_eq!(state_glyph("☾ 3 h"), Some(("sf:moon", "3 h")));
    assert_eq!(state_glyph("⏸ frenato"), Some(("sf:pause.circle|warn", "frenato")));
    assert_eq!(state_glyph("⏱ coda"), Some(("sf:clock|info", "coda")));
    assert_eq!(state_glyph("12,0"), None);
}

#[test]
fn icon_markers_round_trip_through_the_title() {
    let t = format!("{}Chiudi", icon_mark("sf:xmark.circle"));
    let rest = t.strip_prefix(ICON_MARK).and_then(|r| r.split_once(ICON_END)).unwrap();
    assert_eq!(rest, ("sf:xmark.circle", "Chiudi"));
}

unsafe fn raw_item(menu: id, title: &str) -> id {
    let item: id = msg_send![class!(NSMenuItem), alloc];
    let item: id = msg_send![item, initWithTitle: ns(title), action: std::ptr::null::<std::ffi::c_void>(), keyEquivalent: ns("")];
    let _: () = msg_send![menu, addItem: item];
    item
}

unsafe fn leaked_titles(menu: id, out: &mut Vec<String>) {
    let count: isize = msg_send![menu, numberOfItems];
    for i in 0..count {
        let item: id = msg_send![menu, itemAtIndex: i];
        let title = string_of(msg_send![item, title]).unwrap_or_default();
        if title.contains("card:") || title.contains("row:") || title.contains("icon:") {
            out.push(title);
        }
        let sub: id = msg_send![item, submenu];
        if sub != nil {
            leaked_titles(sub, out);
        }
    }
}

/// The real path: the menu goes to a real status item through `setMenu:`, exactly as
/// tray-icon does on a click, and no title (submenus included) may keep a marker.
#[test]
fn the_menu_a_status_item_receives_is_decorated() {
    reset();
    unsafe {
        // A stand-in with the status item's `setMenu:` shape: a real status item needs the main thread.
        let mut builder = objc2::declare::ClassBuilder::new(c"TrayMenuHookProbe", class!(NSObject)).unwrap();
        extern "C" fn plain_set_menu(_this: id, _sel: crate::mac::Sel, _menu: id) {}
        builder.add_method(crate::mac::sel!(setMenu:), plain_set_menu as extern "C" fn(id, crate::mac::Sel, id));
        let probe_class = builder.register();
        hook_set_menu(probe_class as *const _ as *const std::ffi::c_void);
        let menu: id = msg_send![class!(NSMenu), new];
        raw_item(menu, &format!("{}Apri Topics", icon_mark("sf:macwindow")));
        raw_item(menu, &register_card("machine:local", &[], 280.0, 90.0, &[]));
        let parent = raw_item(menu, &register_row(1, &["Projects".to_string(), "3".to_string()], true, Table::Projects, Look::default()));
        let sub: id = msg_send![class!(NSMenu), new];
        raw_item(sub, &format!("{}Esci", icon_mark("sf:power")));
        raw_item(sub, &register_row(2, &["alpha".to_string(), "1".to_string()], false, Table::Projects, Look::default()));
        let _: () = msg_send![parent, setSubmenu: sub];

        let status: id = msg_send![probe_class, new];
        let _: () = msg_send![status, setMenu: menu];
        let mut leaked = Vec::new();
        leaked_titles(menu, &mut leaked);
        assert!(leaked.is_empty(), "markers left in the menu the status item received: {leaked:?}");
    }
}

#[test]
fn the_type_sizes_and_icon_sizes_are_those_of_the_original_tray() {
    // ClaudeUsage.swift: rowFont 13, rowNum 12.5, rowSmall 10.5, header 10, symbols 13, providers 13, project pictures 15
    assert_eq!([NAME_PT, NUM_PT, SMALL_PT, HEAD_PT], [13.0, 12.5, 10.5, 10.0]);
    assert_eq!([SYMBOL_PT, PROVIDER_PT, PROJECT_ICON_PT], [13.0, 13.0, 15.0]);
}

#[test]
fn a_table_header_with_a_summary_is_two_lines_tall_so_nothing_is_drawn_over_the_first_row() {
    let head = crate::tray_menu::head_row(crate::tray_menu::Table::Projects, vec!["PROGETTI".into(), "Claude".into(), "\nnessun lavoro in corso".into()]);
    let mut lines = Vec::new();
    lines_of(&[head], &mut lines);
    assert!(line_h(&lines[0]) > ROW_H, "{}", line_h(&lines[0]));
}

#[test]
fn a_long_name_keeps_its_port() {
    let c = clip("Server di sviluppo · Next.js :3181", 24);
    assert!(c.ends_with(" :3181") && c.chars().count() <= 24, "{c}");
    assert_eq!(clip("Server :3181", 24), "Server :3181");
    assert!(clip("Un nome lunghissimo senza porta alla fine", 20).ends_with('…'));
}

/// Frames of the hover, drawn off screen: the card's view is given a cursor at a series of x over its charts and
/// each state is saved as a PNG. No window and no real mouse.
/// TRAY_HOVER_FRAMES=<dir> TRAY_MENU_NATIVE_MACHINES/_HEALTH/_POOL/_SYNC/_CLIENT as for `native_rows`.
#[test]
fn hover_frames() {
    let Ok(dir) = std::env::var("TRAY_HOVER_FRAMES") else { return };
    let base = std::env::var("TRAY_MENU_HUB").unwrap_or_else(|_| crate::tray_quota::hub_base());
    let mut snap = crate::tray_menu::Snapshot::fetch(&base, None);
    for (var, slot) in [("TRAY_MENU_NATIVE_MACHINES", 0), ("TRAY_MENU_NATIVE_HEALTH", 1), ("TRAY_MENU_NATIVE_POOL", 2), ("TRAY_MENU_NATIVE_SYNC", 3)] {
        if let Ok(f) = std::env::var(var) {
            let body = std::fs::read_to_string(f).unwrap();
            match slot { 0 => snap.machines = Some(body), 1 => snap.health = Some(body), 2 => snap.pool = Some(body), _ => snap.harness_sync = Some(body) }
        }
    }
    let client: Vec<crate::tray_menu_views::MachineCard> = std::env::var("TRAY_MENU_NATIVE_CLIENT").ok()
        .map(|f| serde_json::from_str::<Vec<crate::tray_machines::StatusMachine>>(&std::fs::read_to_string(f).unwrap()).unwrap())
        .unwrap_or_default().iter().filter_map(|m| m.card()).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let machines = crate::tray_menu_rich::machines_for(&client, &snap);
    let dark = std::env::var("TRAY_HOVER_DARK").is_ok();
    let menu = crate::tray_menu_rich::build_menu_rich(&snap, crate::tray_menu::Prefs::default(), now, &machines, dark);
    type Found = (String, Vec<u8>, f64, f64, Vec<crate::tray_hover::HoverZone>);
    // every card of the menu that has charts, plus the charts of their submenus
    fn collect(nodes: &[Node], out: &mut Vec<Found>) {
        for n in nodes {
            if let Node::Card { key, png, w, h, hover, children } = n {
                if !hover.is_empty() {
                    out.push((key.replace(':', "-"), png.clone(), *w as f64, *h as f64, hover.clone()));
                }
                collect(children, out);
            }
        }
    }
    let mut cards: Vec<Found> = Vec::new();
    collect(&menu, &mut cards);
    unsafe {
        let name = if dark { "NSAppearanceNameDarkAqua" } else { "NSAppearanceNameAqua" };
        let appearance: id = msg_send![class!(NSAppearance), appearanceNamed: ns(name)];
        let _: () = msg_send![class!(NSAppearance), setCurrentAppearance: appearance];
        for (key, png, w, h, zones) in &cards {
            let data: id = msg_send![class!(NSData), dataWithBytes: png.as_ptr() as *const std::ffi::c_void, length: png.len()];
            let image: id = msg_send![class!(NSImage), alloc];
            let image: id = msg_send![image, initWithData: data];
            let _: () = msg_send![image, setSize: NSSize::new(*w, *h)];
            let frame = NSRect::new(crate::mac::NSPoint::new(0.0, 0.0), NSSize::new(*w, *h));
            let view = crate::tray_menu_hover_view::new_view(frame, image, zones.clone());
            // the view follows the appearance asked for, not the one of the system running the test
            let _: () = msg_send![view, setAppearance: appearance];
            for (zi, z) in zones.iter().enumerate() {
                let n = z.points.len();
                // sweep across the chart: about 24 frames, each on a point's x
                let picks: Vec<usize> = if n <= 24 { (0..n).collect() } else { (0..24).map(|i| i * (n - 1) / 23).collect() };
                for (fi, pi) in picks.iter().enumerate() {
                    crate::tray_menu_hover_view::hover_at(view, Some((z.points[*pi].x, z.y + z.h / 2.0)));
                    let rep: id = msg_send![view, bitmapImageRepForCachingDisplayInRect: frame];
                    let _: () = msg_send![view, cacheDisplayInRect: frame, toBitmapImageRep: rep];
                    let opts: id = msg_send![class!(NSDictionary), dictionary];
                    let png_data: id = msg_send![rep, representationUsingType: 4usize, properties: opts];
                    let len: usize = msg_send![png_data, length];
                    let ptr: *const u8 = msg_send![png_data, bytes];
                    std::fs::write(format!("{dir}/{key}-z{zi}-{fi:02}.png"), std::slice::from_raw_parts(ptr, len)).unwrap();
                }
                crate::tray_menu_hover_view::hover_at(view, None);
            }
        }
    }
}
