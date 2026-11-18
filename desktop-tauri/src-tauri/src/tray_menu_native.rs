//! AppKit glue for the graphic tray menu. The tray library builds plain items; the
//! ones that carry a card or a table row get a marker title, and once the menu is
//! installed this module finds them and gives each its real content: an image view
//! for a card, an attributed title with tab stops for a table row. Everything else
//! stays a system item, so hover, keyboard and submenus are the system's.
//! Card 1aba05b4.

use crate::mac::{class, id, msg_send, nil, NSRect, NSSize};
use crate::tray_menu::{Look, Priority, Table};
use std::collections::HashMap;
use std::ffi::{c_char, CStr};
use std::sync::Mutex;

const CARD_MARK: &str = "\u{200B}card:";
const ROW_MARK: &str = "\u{200B}row:";

struct CardImage {
    png: Vec<u8>,
    w: f64,
    h: f64,
    /// The charts of the card that answer to the mouse; a card with none is a plain image view.
    hover: Vec<crate::tray_hover::HoverZone>,
}

struct TableRow {
    cells: Vec<String>,
    header: bool,
    /// The tab stops of the table the row belongs to: each table has its own, as in the original tray.
    tabs: &'static [f64],
    look: Look,
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
pub fn register_card(key: &str, png: &[u8], w: f32, h: f32, hover: &[crate::tray_hover::HoverZone]) -> String {
    CARDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.into(), CardImage { png: png.to_vec(), w: w as f64, h: h as f64, hover: hover.to_vec() });
    format!("{CARD_MARK}{key}")
}

/// The marker title of a table row; `n` makes each one unique. The row carries the tab stops of its
/// own table: one set for all of them overran the right edge of the menu.
pub fn register_row(n: usize, cells: &[String], header: bool, table: Table, look: Look) -> String {
    let key = n.to_string();
    ROWS.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.clone(), TableRow { cells: cells.to_vec(), header, tabs: table.tabs(), look });
    format!("{ROW_MARK}{key}")
}

/// The type sizes of the original tray (ClaudeUsage.swift `rowFont`, `rowNum`, `rowSmall`, the header
/// and `titledFont`), the same on every row of the menu.
pub const NAME_PT: f64 = 13.0;
pub const NUM_PT: f64 = 12.5;
pub const SMALL_PT: f64 = 10.5;
pub const HEAD_PT: f64 = 10.0;
/// `NSFontWeightSemibold`.
const SEMIBOLD: f64 = 0.3;
/// Symbol size of an icon in front of a row, and the size of a provider's logo and a project's picture.
pub const SYMBOL_PT: f64 = 13.0;
pub const PROVIDER_PT: f64 = 13.0;
pub const PROJECT_ICON_PT: f64 = 15.0;

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

extern "C" {
    fn class_getInstanceMethod(cls: *const std::ffi::c_void, name: crate::mac::Sel) -> *mut std::ffi::c_void;
    fn method_setImplementation(m: *mut std::ffi::c_void, imp: *const std::ffi::c_void) -> *const std::ffi::c_void;
}

/// The original `-[NSStatusItem setMenu:]`, kept so the hook can forward to it.
static ORIGINAL_SET_MENU: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

extern "C" fn set_menu_hooked(this: id, sel: crate::mac::Sel, menu: id) {
    // Decorate before the status item shows it, so the first frame is already right.
    if menu != nil {
        unsafe { decorate_menu(menu) };
    }
    let original = ORIGINAL_SET_MENU.load(std::sync::atomic::Ordering::Acquire);
    if original != 0 {
        let forward: extern "C" fn(id, crate::mac::Sel, id) = unsafe { std::mem::transmute(original) };
        forward(this, sel, menu);
    }
}

/// Decorates every menu the status item is about to show. tray-icon 0.25 keeps the
/// menu in a private field and hands it to the status item only for the duration of
/// a click (`setMenu:`, `performClick`, `setMenu:nil`), and tauri does not expose
/// the underlying NSMenu, so the status item's `menu` is nil whenever we look. The
/// one place that same NSMenu is visible is that `setMenu:` call: hook it, once.
pub fn install_menu_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe { hook_set_menu(class!(NSStatusItem) as *const _ as *const std::ffi::c_void) });
}

/// Swaps `-setMenu:` of `class` for the decorating one; the class is a parameter so a test can aim it at a stand-in.
unsafe fn hook_set_menu(class: *const std::ffi::c_void) {
    let method = class_getInstanceMethod(class, crate::mac::sel!(setMenu:));
    if method.is_null() {
        return;
    }
    let previous = method_setImplementation(method, set_menu_hooked as *const std::ffi::c_void);
    ORIGINAL_SET_MENU.store(previous as usize, std::sync::atomic::Ordering::Release);
}

pub(crate) unsafe fn decorate_menu(menu: id) {
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
            // The view carries the content; the title must not leak the marker (accessibility, menu search).
            let _: () = msg_send![mi, setTitle: ns("")];
        } else if let Some(key) = title.strip_prefix(ROW_MARK) {
            if let Some(r) = ROWS.lock().unwrap().as_ref().and_then(|m| m.get(key)) {
                // the plain title first: setting it after the attributed one would be free to drop it
                let plain = r.cells.join(" ");
                let _: () = msg_send![mi, setTitle: ns(&plain)];
                let t = row_title(r);
                if t != nil {
                    let _: () = msg_send![mi, setAttributedTitle: t];
                }
            }
        } else if !title.is_empty() {
            let separator: bool = msg_send![mi, isSeparatorItem];
            let view: id = msg_send![mi, view];
            if !separator && view == nil {
                let enabled: bool = msg_send![mi, isEnabled];
                let t = plain_title(&title, enabled);
                let _: () = msg_send![mi, setAttributedTitle: t];
            }
        }
    }
}

/// A simple item or note at the size of the original tray's rows (13, not the menu's default 14): an
/// enabled item in the menu's ink, a note in the secondary one (an explicit colour is not faded).
unsafe fn plain_title(title: &str, enabled: bool) -> id {
    let font: id = msg_send![class!(NSFont), systemFontOfSize: NAME_PT];
    let color: id = if enabled { msg_send![class!(NSColor), labelColor] } else { msg_send![class!(NSColor), secondaryLabelColor] };
    let d: id = msg_send![class!(NSMutableDictionary), dictionary];
    let _: () = msg_send![d, setObject: font, forKey: ns("NSFont")];
    let _: () = msg_send![d, setObject: color, forKey: ns("NSColor")];
    let s: id = msg_send![class!(NSAttributedString), alloc];
    let s: id = msg_send![s, initWithString: ns(title), attributes: d];
    msg_send![s, autorelease]
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
        let _: () = msg_send![img, setSize: NSSize::new(PROJECT_ICON_PT, PROJECT_ICON_PT)];
        return msg_send![img, autorelease];
    }
    if let Some(name) = spec.strip_prefix("png:") {
        // a project's own picture, read by the poller; 15×15 and in its own colours, as the original draws it
        // a picture that cannot be read leaves the row with the folder, never with no icon at all
        let Some(png) = crate::tray_menu::project_icon_png(name) else { return icon_image("sf:folder") };
        let data: id = msg_send![class!(NSData), dataWithBytes: png.as_ptr() as *const std::ffi::c_void, length: png.len()];
        let img: id = msg_send![class!(NSImage), alloc];
        let img: id = msg_send![img, initWithData: data];
        if img == nil {
            return icon_image("sf:folder");
        }
        let _: () = msg_send![img, setSize: NSSize::new(PROJECT_ICON_PT, PROJECT_ICON_PT)];
        let _: () = msg_send![img, setTemplate: false];
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
        let _: () = msg_send![img, setSize: NSSize::new(PROVIDER_PT, PROVIDER_PT)];
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
    let cfg: id = msg_send![class!(NSImageSymbolConfiguration), configurationWithPointSize: SYMBOL_PT, weight: 0.0f64];
    let color: id = match tone {
        "bad" => msg_send![class!(NSColor), systemRedColor],
        "warn" => msg_send![class!(NSColor), systemOrangeColor],
        "ok" => msg_send![class!(NSColor), systemGreenColor],
        "info" => msg_send![class!(NSColor), systemBlueColor],
        "teal" => msg_send![class!(NSColor), systemTealColor],
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
    let frame = NSRect::new(crate::mac::NSPoint::new(0.0, 0.0), NSSize::new(c.w, c.h));
    // a card with charts is a view that follows the mouse and draws the line and the label over its image
    let view: id = if c.hover.is_empty() {
        let view: id = msg_send![class!(NSImageView), alloc];
        let view: id = msg_send![view, initWithFrame: frame];
        let _: () = msg_send![view, setImage: image];
        // The image is exactly the view's size: no scaling, no resampling blur.
        let _: () = msg_send![view, setImageScaling: 2usize];
        view
    } else {
        crate::tray_menu_hover_view::new_view(frame, image, c.hover.clone())
    };
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

/// An inline symbol (13×12, as the original tray's `inlineIcon`) as an attributed piece.
unsafe fn inline_symbol(spec: &str) -> Option<id> {
    let image = icon_image(spec);
    if image == nil {
        return None;
    }
    let att: id = msg_send![class!(NSTextAttachment), new];
    let _: () = msg_send![att, setImage: image];
    let _: () = msg_send![att, setBounds: NSRect::new(crate::mac::NSPoint::new(0.0, -2.0), NSSize::new(13.0, 12.0))];
    let piece: id = msg_send![class!(NSAttributedString), attributedStringWithAttachment: att];
    let _: () = msg_send![att, release];
    Some(piece)
}

/// An empty piece as wide and tall as an inline symbol (13×12): the place an arrow would take.
unsafe fn blank_slot() -> Option<id> {
    // an attachment with no image has no width: a transparent image of the arrow's size is what holds the place
    let blank: id = msg_send![class!(NSImage), alloc];
    let blank: id = msg_send![blank, initWithSize: NSSize::new(13.0, 12.0)];
    let att: id = msg_send![class!(NSTextAttachment), new];
    let _: () = msg_send![att, setImage: blank];
    let _: () = msg_send![att, setBounds: NSRect::new(crate::mac::NSPoint::new(0.0, -2.0), NSSize::new(13.0, 12.0))];
    let piece: id = msg_send![class!(NSAttributedString), attributedStringWithAttachment: att];
    let _: () = msg_send![att, release];
    let _: () = msg_send![blank, release];
    Some(piece)
}

/// One table row as an attributed string: cells separated by tabs, the numbers in a
/// monospaced-digit face, the header small and grey, the name semibold when the row's look says so.
unsafe fn row_title(r: &TableRow) -> id {
    let para: id = msg_send![class!(NSMutableParagraphStyle), new];
    let stops: id = msg_send![class!(NSMutableArray), array];
    let opts: id = msg_send![class!(NSDictionary), dictionary];
    for &loc in r.tabs {
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
    let name_font: id = if r.look.bold && !r.header {
        msg_send![class!(NSFont), systemFontOfSize: NAME_PT, weight: SEMIBOLD]
    } else {
        msg_send![class!(NSFont), systemFontOfSize: NAME_PT]
    };
    let num_font: id = msg_send![class!(NSFont), monospacedDigitSystemFontOfSize: NUM_PT, weight: 0.0f64];
    let small: id = msg_send![class!(NSFont), systemFontOfSize: HEAD_PT, weight: SEMIBOLD];
    let small_regular: id = msg_send![class!(NSFont), systemFontOfSize: SMALL_PT];
    let out: id = msg_send![class!(NSMutableAttributedString), alloc];
    let out: id = msg_send![out, init];
    for (i, cell) in r.cells.iter().enumerate() {
        // a cell that starts a line, or one past the columns of a row, is the row's second line
        // (kind, owner, since), small and grey; the header has one too (the summary under «PROGETTI») allow-italian: quoted menu wording
        if cell.starts_with('\n') || (!r.header && i > r.tabs.len()) {
            let piece: id = msg_send![class!(NSAttributedString), alloc];
            let piece: id = msg_send![piece, initWithString: ns(&format!("\n{}", cell.trim_start_matches('\n'))), attributes: attrs(small_regular, dim, para)];
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
        // A priority other than normal goes before the name, as the Projects page draws it.
        if i == 0 && !r.header {
            let arrow = match r.look.priority {
                Priority::High => Some("sf:arrow.up|warn"),
                Priority::Low => Some("sf:arrow.down|teal"),
                Priority::Normal => None,
            };
            // the place of an arrow the other rows of the table wear: a blank attachment of its size
            let arrow = arrow.or(if r.look.arrow_slot { Some("blank") } else { None });
            let glyph = match arrow {
                Some("blank") => blank_slot(),
                Some(spec) => inline_symbol(spec),
                None => None,
            };
            if let Some(glyph) = glyph {
                let _: () = msg_send![out, appendAttributedString: glyph];
                let gap: id = msg_send![class!(NSAttributedString), alloc];
                let gap: id = msg_send![gap, initWithString: ns(" "), attributes: attrs(font, color, para)];
                let _: () = msg_send![out, appendAttributedString: gap];
                let _: () = msg_send![gap, release];
            }
        }
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
            if let Some(glyph_piece) = inline_symbol(spec) {
                let _: () = msg_send![out, appendAttributedString: glyph_piece];
            }
        }
        let piece: id = msg_send![class!(NSAttributedString), alloc];
        let piece: id = msg_send![piece, initWithString: ns(&if i == 0 && !r.tabs.is_empty() { clip(&text, 34) } else { text }), attributes: attrs(font, color, para)];
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

/// A name that is too long loses its middle, never its end when the end is a port («Next.js :3181»): the
/// port is what tells two dev servers apart.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let tail = s.rsplit_once(' ').map(|(_, t)| t).filter(|t| t.starts_with(':') && t.chars().count() <= 6);
    match tail {
        Some(t) => {
            let head = &s[..s.len() - t.len()];
            let room = max.saturating_sub(t.chars().count() + 2);
            format!("{}… {t}", head.chars().take(room).collect::<String>().trim_end())
        }
        None => format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end()),
    }
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
