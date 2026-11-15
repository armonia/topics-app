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
            Node::Row { cells, header, children, .. } => out.push(Line { icon: None, row: Some(TableRow { cells: cells.clone(), header: *header }), text: String::new(), sep: false, arrow: !children.is_empty(), card: None }),
        }
    }
}

unsafe fn render(nodes: &[Node], dark: bool) -> Vec<u8> {
    let mut lines = Vec::new();
    lines_of(nodes, &mut lines);
    let height: f64 = lines.iter().map(|l| l.card.as_ref().map_or(if l.sep { 9.0 } else { ROW_H }, |c| c.2)).sum::<f64>() + 8.0;
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
        let h = l.card.as_ref().map_or(if l.sep { 9.0 } else { ROW_H }, |c| c.2);
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
                    let _: () = msg_send![img, drawInRect: NSRect::new(crate::mac::NSPoint::new(10.0 + (16.0 - s.width) / 2.0, y + (ROW_H - s.height) / 2.0), s)];
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
            let _: () = msg_send![title, drawInRect: NSRect::new(crate::mac::NSPoint::new(34.0, y + 3.0), NSSize::new(WIDTH - 60.0, ROW_H - 4.0))];
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
    let snap = crate::tray_menu::Snapshot::fetch(&base, None);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let machines = crate::tray_menu_rich::machines_for(&[], &snap);
    for (name, dark) in [("dark", true), ("light", false)] {
        let menu = crate::tray_menu_rich::build_menu_rich(&snap, crate::tray_menu::Prefs::default(), now, &machines, dark);
        // the top level, and the submenu of this computer (its first card)
        let first = menu.iter().find_map(|n| if let Node::Card { children, .. } = n { Some(children.clone()) } else { None }).unwrap_or_default();
        std::fs::write(format!("{dir}/native-top-{name}.png"), unsafe { render(&menu, dark) }).unwrap();
        std::fs::write(format!("{dir}/native-mac-{name}.png"), unsafe { render(&first, dark) }).unwrap();
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
