//! AppKit glue for the graphic tray menu. The tray library builds plain items; the
//! ones that carry a card or a table row get a marker title, and once the menu is
//! installed this module finds them and gives each its real content: an image view
//! for a card, an attributed title with tab stops for a table row. Everything else
//! stays a system item, so hover, keyboard and submenus are the system's.
//! Card 1aba05b4.

use crate::mac::{class, id, msg_send, nil, NSRect, NSSize};
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::sync::Mutex;

const CARD_MARK: &str = "\u{200B}card:";
const ROW_MARK: &str = "\u{200B}row:";

struct CardImage {
    png: Vec<u8>,
    w: f64,
    h: f64,
}

struct TableRow {
    cells: Vec<String>,
    header: bool,
}

static CARDS: Mutex<Option<HashMap<String, CardImage>>> = Mutex::new(None);
static ROWS: Mutex<Option<HashMap<String, TableRow>>> = Mutex::new(None);

const ICON_MARK: &str = "\u{200B}icon:";
const ICON_END: char = '\u{200D}';

/// The marker that starts a title whose item gets an icon: `sf:<symbol>[|bad|warn|ok]` or `app:<bundle path>`.
pub fn icon_mark(spec: &str) -> String {
    format!("{ICON_MARK}{spec}{ICON_END}")
}

/// Forgets the contents of the previous menu; called before a new one is built.
pub fn reset() {
    *CARDS.lock().unwrap() = Some(HashMap::new());
    *ROWS.lock().unwrap() = Some(HashMap::new());
}

/// The marker title of a card item; its image is applied by `decorate`.
pub fn register_card(key: &str, png: &[u8], w: f32, h: f32) -> String {
    CARDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.into(), CardImage { png: png.to_vec(), w: w as f64, h: h as f64 });
    format!("{CARD_MARK}{key}")
}

/// The marker title of a table row; `n` makes each one unique.
pub fn register_row(n: usize, cells: &[String], header: bool) -> String {
    let key = n.to_string();
    ROWS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.clone(), TableRow { cells: cells.to_vec(), header });
    format!("{ROW_MARK}{key}")
}

/// Right-aligned tab stops of the projects table, in points from the text start.
const TABS: [f64; 5] = [268.0, 322.0, 376.0, 436.0, 506.0];

/// True when the menu is drawn on a dark surface.
pub fn dark() -> bool {
    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let ap: id = msg_send![app, effectiveAppearance];
        let name: id = if ap == nil { nil } else { msg_send![ap, name] };
        string_of(name).map_or(false, |n| n.contains("Dark"))
    }
}

unsafe fn string_of(s: id) -> Option<String> {
    if s == nil {
        return None;
    }
    let p: *const c_char = msg_send![s, UTF8String];
    (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
}

unsafe fn ns(s: &str) -> id {
    let a: id = msg_send![class!(NSString), alloc];
    let b: id = msg_send![a, initWithBytes: s.as_ptr() as *const std::ffi::c_void, length: s.len(), encoding: 4usize];
    msg_send![b, autorelease]
}

/// Applies the registered content to every marked item of the status item's menu.
pub fn decorate(tray: &tauri::tray::TrayIcon) {
    let _ = tray.with_inner_tray_icon(|inner| {
        let Some(item) = inner.ns_status_item() else { return };
        unsafe {
            let item: id = objc2::rc::Retained::as_ptr(&item) as id;
            let menu: id = msg_send![item, menu];
            if menu != nil {
                decorate_menu(menu);
            }
        }
    });
}

unsafe fn decorate_menu(menu: id) {
    let count: isize = msg_send![menu, numberOfItems];
    for i in 0..count {
        let mi: id = msg_send![menu, itemAtIndex: i];
        let mut title = string_of(msg_send![mi, title]).unwrap_or_default();
        while let Some(rest) = title.strip_prefix(ICON_MARK) {
            let Some((spec, rest)) = rest.split_once(ICON_END) else { break };
            let image = icon_image(spec);
            if image != nil {
                let _: () = msg_send![mi, setImage: image];
            }
            title = rest.to_string();
            if !title.starts_with(CARD_MARK) && !title.starts_with(ROW_MARK) {
                let _: () = msg_send![mi, setTitle: ns(&title)];
            }
        }
        let sub: id = msg_send![mi, submenu];
        if sub != nil {
            decorate_menu(sub);
        }
        if let Some(key) = title.strip_prefix(CARD_MARK) {
            if let Some(c) = CARDS.lock().unwrap().as_ref().and_then(|m| m.get(key)) {
                set_card_view(mi, c);
            }
        } else if let Some(key) = title.strip_prefix(ROW_MARK) {
            if let Some(r) = ROWS.lock().unwrap().as_ref().and_then(|m| m.get(key)) {
                let t = row_title(r);
                if t != nil {
                    let _: () = msg_send![mi, setAttributedTitle: t];
                }
            }
        }
    }
}

/// An item's icon: an app's own icon from its bundle, or a system symbol (template, so it follows the menu's ink).
unsafe fn icon_image(spec: &str) -> id {
    if let Some(path) = spec.strip_prefix("app:") {
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let shared: id = msg_send![ws, iconForFile: ns(path)];
        if shared == nil {
            return nil;
        }
        let img: id = msg_send![shared, copy];
        let _: () = msg_send![img, setSize: NSSize::new(15.0, 15.0)];
        return msg_send![img, autorelease];
    }
    if let Some(provider) = spec.strip_prefix("provider:") {
        static ANTHROPIC: &[u8] = include_bytes!("../assets/tray-providers/anthropic.png");
        static OPENAI: &[u8] = include_bytes!("../assets/tray-providers/openai.png");
        static META: &[u8] = include_bytes!("../assets/tray-providers/meta.png");
        let bytes = match provider {
            "claude" => ANTHROPIC,
            "codex" => OPENAI,
            "muse" => META,
            _ => return nil,
        };
        let data: id = msg_send![class!(NSData), dataWithBytes: bytes.as_ptr(), length: bytes.len()];
        let img: id = msg_send![class!(NSImage), alloc];
        let img: id = msg_send![img, initWithData: data];
        if img == nil {
            return nil;
        }
        let _: () = msg_send![img, setSize: NSSize::new(14.0, 14.0)];
        // a template: the menu inks it like its symbols, one family of icons
        let _: () = msg_send![img, setTemplate: true];
        return msg_send![img, autorelease];
    }
    let Some(sf) = spec.strip_prefix("sf:") else { return nil };
    let (name, tone) = sf.split_once('|').unwrap_or((sf, ""));
    let base: id = msg_send![class!(NSImage), imageWithSystemSymbolName: ns(name), accessibilityDescription: nil];
    if base == nil {
        return nil;
    }
    let cfg: id = msg_send![class!(NSImageSymbolConfiguration), configurationWithPointSize: 13.0f64, weight: 0.0f64];
    let color: id = match tone {
        "bad" => msg_send![class!(NSColor), systemRedColor],
        "warn" => msg_send![class!(NSColor), systemOrangeColor],
        "ok" => msg_send![class!(NSColor), systemGreenColor],
        "info" => msg_send![class!(NSColor), systemBlueColor],
        _ => nil,
    };
    let cfg: id = if color == nil {
        cfg
    } else {
        let colors: id = msg_send![class!(NSArray), arrayWithObject: color];
        let palette: id = msg_send![class!(NSImageSymbolConfiguration), configurationWithPaletteColors: colors];
        msg_send![cfg, configurationByApplyingConfiguration: palette]
    };
    let img: id = msg_send![base, imageWithSymbolConfiguration: cfg];
    let img = if img == nil { base } else { img };
    let _: () = msg_send![img, setTemplate: color == nil];
    img
}

unsafe fn set_card_view(mi: id, c: &CardImage) {
    let data: id = msg_send![class!(NSData), dataWithBytes: c.png.as_ptr() as *const std::ffi::c_void, length: c.png.len()];
    let image: id = msg_send![class!(NSImage), alloc];
    let image: id = msg_send![image, initWithData: data];
    if image == nil {
        return;
    }
    let _: () = msg_send![image, setSize: NSSize::new(c.w, c.h)];
    let _: () = msg_send![image, setTemplate: false];
    let view: id = msg_send![class!(NSImageView), alloc];
    let view: id = msg_send![view, initWithFrame: NSRect::new(crate::mac::NSPoint::new(0.0, 0.0), NSSize::new(c.w, c.h))];
    let _: () = msg_send![view, setImage: image];
    // The image is exactly the view's size: no scaling, no resampling blur.
    let _: () = msg_send![view, setImageScaling: 2usize];
    let _: () = msg_send![mi, setView: view];
    let _: () = msg_send![view, release];
    let _: () = msg_send![image, release];
}

unsafe fn attrs(font: id, color: id, para: id) -> id {
    let d: id = msg_send![class!(NSMutableDictionary), dictionary];
    let _: () = msg_send![d, setObject: font, forKey: ns("NSFont")];
    let _: () = msg_send![d, setObject: color, forKey: ns("NSColor")];
    let _: () = msg_send![d, setObject: para, forKey: ns("NSParagraphStyle")];
    d
}

/// One table row as an attributed string: cells separated by tabs, the numbers in a
/// monospaced-digit face, the header small and grey.
unsafe fn row_title(r: &TableRow) -> id {
    let para: id = msg_send![class!(NSMutableParagraphStyle), new];
    let stops: id = msg_send![class!(NSMutableArray), array];
    let opts: id = msg_send![class!(NSDictionary), dictionary];
    for loc in TABS {
        let tab: id = msg_send![class!(NSTextTab), alloc];
        // NSTextAlignmentRight = 1 on macOS.
        let tab: id = msg_send![tab, initWithTextAlignment: 1isize, location: loc, options: opts];
        let _: () = msg_send![stops, addObject: tab];
        let _: () = msg_send![tab, release];
    }
    let _: () = msg_send![para, setTabStops: stops];
    let _: () = msg_send![para, setDefaultTabInterval: 0.0f64];
    // NSLineBreakByClipping = 2.
    let _: () = msg_send![para, setLineBreakMode: 2usize];
    let label: id = msg_send![class!(NSColor), labelColor];
    let dim: id = msg_send![class!(NSColor), secondaryLabelColor];
    let weight_semibold = 0.3f64;
    let (name_font, num_font, small): (id, id, id) = (
        msg_send![class!(NSFont), systemFontOfSize: 13.0f64],
        msg_send![class!(NSFont), monospacedDigitSystemFontOfSize: 12.5f64, weight: 0.0f64],
        msg_send![class!(NSFont), systemFontOfSize: 10.0f64, weight: weight_semibold],
    );
    let small_regular: id = msg_send![class!(NSFont), systemFontOfSize: 10.5f64];
    let out: id = msg_send![class!(NSMutableAttributedString), alloc];
    let out: id = msg_send![out, init];
    for (i, cell) in r.cells.iter().enumerate() {
        // a cell past the columns is the row's second line (kind, owner, since), small and grey
        if i > TABS.len() && !r.header {
            let piece: id = msg_send![class!(NSAttributedString), alloc];
            let piece: id = msg_send![piece, initWithString: ns(&format!("\n{cell}")), attributes: attrs(small_regular, dim, para)];
            let _: () = msg_send![out, appendAttributedString: piece];
            let _: () = msg_send![piece, release];
            continue;
        }
        let text = if i == 0 { cell.clone() } else { format!("\t{cell}") };
        let (font, color) = if r.header {
            (small, dim)
        } else if i == 0 {
            (name_font, label)
        } else if cell == "–" {
            (num_font, dim)
        } else {
            (num_font, label)
        };
        // The state cell leads with a system symbol, as the original tray draws it: playing for agents at work, a moon for still.
        let glyph = if i > 0 && !r.header { state_glyph(cell) } else { None };
        let (lead, text) = match glyph {
            Some((_, rest)) => ("\t".to_string(), rest.to_string()),
            None => (String::new(), text),
        };
        if let Some((spec, _)) = glyph {
            let piece: id = msg_send![class!(NSAttributedString), alloc];
            let piece: id = msg_send![piece, initWithString: ns(&lead), attributes: attrs(font, color, para)];
            let _: () = msg_send![out, appendAttributedString: piece];
            let _: () = msg_send![piece, release];
            let image = icon_image(spec);
            if image != nil {
                let att: id = msg_send![class!(NSTextAttachment), new];
                let _: () = msg_send![att, setImage: image];
                let _: () = msg_send![att, setBounds: NSRect::new(crate::mac::NSPoint::new(0.0, -2.0), NSSize::new(13.0, 12.0))];
                let glyph_piece: id = msg_send![class!(NSAttributedString), attributedStringWithAttachment: att];
                let _: () = msg_send![out, appendAttributedString: glyph_piece];
                let _: () = msg_send![att, release];
            }
        }
        let piece: id = msg_send![class!(NSAttributedString), alloc];
        let piece: id = msg_send![piece, initWithString: ns(&if i == 0 { clip(&text, 34) } else { text }), attributes: attrs(font, color, para)];
        let _: () = msg_send![out, appendAttributedString: piece];
        let _: () = msg_send![piece, release];
    }
    let _: () = msg_send![para, release];
    msg_send![out, autorelease]
}

/// The icon and the words of a state cell («▸ 2», «☾ 3 h»): the text signs stay in the data, the menu draws symbols.
fn state_glyph(cell: &str) -> Option<(&'static str, &str)> {
    if let Some(rest) = cell.strip_prefix("▸ ") {
        return Some(("sf:play.circle|ok", rest));
    }
    if let Some(rest) = cell.strip_prefix("⏸ ") {
        return Some(("sf:pause.circle|warn", rest));
    }
    if let Some(rest) = cell.strip_prefix("⏱ ") {
        return Some(("sf:clock|info", rest));
    }
    cell.strip_prefix("☾ ").map(|rest| ("sf:moon", rest))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end()) }
}

/// A system symbol as a coverage mask, drawn large enough to be scaled down cleanly.
/// `None` when the symbol does not exist on this system.
pub fn symbol_mask(name: &str) -> Option<crate::tray_menu_pic::Mask> {
    unsafe {
        let base: id = msg_send![class!(NSImage), imageWithSystemSymbolName: ns(name), accessibilityDescription: nil];
        if base == nil {
            return None;
        }
        let cfg: id = msg_send![class!(NSImageSymbolConfiguration), configurationWithPointSize: 56.0f64, weight: 0.0f64];
        let img: id = msg_send![base, imageWithSymbolConfiguration: cfg];
        let img = if img == nil { base } else { img };
        let tiff: id = msg_send![img, TIFFRepresentation];
        if tiff == nil {
            return None;
        }
        let rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if rep == nil {
            return None;
        }
        let opts: id = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4.
        let data: id = msg_send![rep, representationUsingType: 4usize, properties: opts];
        if data == nil {
            return None;
        }
        let len: usize = msg_send![data, length];
        let ptr: *const u8 = msg_send![data, bytes];
        crate::tray_menu_pic::Mask::from_png(std::slice::from_raw_parts(ptr, len))
    }
}

#[cfg(test)]
#[path = "tray_menu_native_tests.rs"]
mod tests;
