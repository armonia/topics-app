//! The view of a card that has charts: it shows the card's image and, while the mouse is over a chart, draws
//! a vertical line on the reading under it and a label with its time and value over the image.
//!
//! A view inside an open menu does not get the system's tooltip, so it follows the mouse itself: an
//! `NSTrackingArea` (active always, in the visible rect) delivers `mouseMoved:` while the menu tracks. Where
//! the line and the label go is decided by `tray_hover::mark_at`; this file only draws what it returns.
//! The view is flipped, so its points are the picture's own (top origin). Card 126eac0a.

use crate::mac::{class, id, msg_send, nil, sel, NSPoint, NSRect, NSSize};
use crate::tray_hover::{mark_at, HoverMark, HoverZone};
use objc2::runtime::{AnyClass, Bool, Sel};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

/// What one view needs to draw itself, kept by the view's address (the class has no instance variables).
struct ViewState {
    image: usize,
    zones: Vec<HoverZone>,
    width: f32,
    mark: Option<HoverMark>,
}

static VIEWS: Mutex<Option<HashMap<usize, ViewState>>> = Mutex::new(None);
const LABEL_PT: f64 = 10.5;

unsafe fn ns(s: &str) -> id {
    let a: id = msg_send![class!(NSString), alloc];
    let b: id = msg_send![a, initWithBytes: s.as_ptr() as *const c_void, length: s.len(), encoding: 4usize];
    msg_send![b, autorelease]
}

/// The label's words, in the menu's ink, with digits of one width so the label does not tremble while the line moves.
unsafe fn label_string(text: &str) -> id {
    let font: id = msg_send![class!(NSFont), monospacedDigitSystemFontOfSize: LABEL_PT, weight: 0.0f64];
    let color: id = msg_send![class!(NSColor), labelColor];
    let d: id = msg_send![class!(NSMutableDictionary), dictionary];
    let _: () = msg_send![d, setObject: font, forKey: ns("NSFont")];
    let _: () = msg_send![d, setObject: color, forKey: ns("NSColor")];
    let s: id = msg_send![class!(NSAttributedString), alloc];
    let s: id = msg_send![s, initWithString: ns(text), attributes: d];
    msg_send![s, autorelease]
}

unsafe fn label_width(text: &str) -> f32 {
    let size: NSSize = msg_send![label_string(text), size];
    size.width as f32
}

extern "C" fn is_flipped(_this: id, _s: Sel) -> Bool {
    Bool::YES
}

extern "C" fn draw_rect(this: id, _s: Sel, _dirty: NSRect) {
    unsafe {
        let bounds: NSRect = msg_send![this, bounds];
        let (image, mark) = {
            let guard = VIEWS.lock().unwrap();
            match guard.as_ref().and_then(|m| m.get(&(this as usize))) {
                Some(st) => (st.image as id, st.mark.clone()),
                None => return,
            }
        };
        let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
        // SourceOver, respecting the flip: the image is drawn upright in a flipped view
        let _: () = msg_send![image, drawInRect: bounds, fromRect: zero, operation: 2usize, fraction: 1.0f64, respectFlipped: true, hints: nil];
        let Some(m) = mark else { return };
        let ink: id = msg_send![class!(NSColor), labelColor];
        let line: id = msg_send![ink, colorWithAlphaComponent: 0.65f64];
        let _: () = msg_send![line, set];
        // a little past the plot at both ends, so the line reads as a cursor and not as a grid guide
        let rect = NSRect::new(NSPoint::new(m.line_x as f64 - 0.75, m.top as f64 - 3.0), NSSize::new(1.5, (m.bottom - m.top) as f64 + 6.0));
        let _: () = msg_send![class!(NSBezierPath), fillRect: rect];
        let box_rect = NSRect::new(NSPoint::new(m.box_x as f64, m.box_y as f64), NSSize::new(m.box_w as f64, m.box_h as f64));
        let path: id = msg_send![class!(NSBezierPath), bezierPathWithRoundedRect: box_rect, xRadius: 5.0f64, yRadius: 5.0f64];
        let fill: id = msg_send![class!(NSColor), windowBackgroundColor];
        let _: () = msg_send![fill, set];
        let _: () = msg_send![path, fill];
        let edge: id = msg_send![class!(NSColor), separatorColor];
        let _: () = msg_send![edge, set];
        let _: () = msg_send![path, setLineWidth: 1.0f64];
        let _: () = msg_send![path, stroke];
        let text = label_string(&m.label);
        let size: NSSize = msg_send![text, size];
        let at = NSPoint::new(m.box_x as f64 + 7.0, m.box_y as f64 + (m.box_h as f64 - size.height) / 2.0);
        let _: () = msg_send![text, drawAtPoint: at];
    }
}

/// Sets the mark for a cursor at `at` (view points, top origin; `None` = the mouse left), and redraws only when it changed.
pub(crate) unsafe fn hover_at(this: id, at: Option<(f32, f32)>) {
    let mark = match at {
        Some((px, py)) => {
            let (zones, width) = {
                let guard = VIEWS.lock().unwrap();
                match guard.as_ref().and_then(|m| m.get(&(this as usize))) {
                    Some(st) => (st.zones.clone(), st.width),
                    None => return,
                }
            };
            mark_at(&zones, px, py, &|t| unsafe { label_width(t) }, width)
        }
        None => None,
    };
    let changed = {
        let mut guard = VIEWS.lock().unwrap();
        match guard.as_mut().and_then(|m| m.get_mut(&(this as usize))) {
            Some(st) if st.mark != mark => {
                st.mark = mark;
                true
            }
            _ => false,
        }
    };
    if changed {
        let _: () = msg_send![this, setNeedsDisplay: true];
    }
}

unsafe fn follow(this: id, ev: id, inside: bool) {
    if !inside {
        return hover_at(this, None);
    }
    let window_point: NSPoint = msg_send![ev, locationInWindow];
    let p: NSPoint = msg_send![this, convertPoint: window_point, fromView: nil];
    hover_at(this, Some((p.x as f32, p.y as f32)));
}

extern "C" fn mouse_moved(this: id, _s: Sel, ev: id) {
    unsafe { follow(this, ev, true) }
}

extern "C" fn mouse_exited(this: id, _s: Sel, ev: id) {
    unsafe { follow(this, ev, false) }
}

extern "C" fn dealloc(this: id, _s: Sel) {
    unsafe {
        let gone = VIEWS.lock().unwrap().as_mut().and_then(|m| m.remove(&(this as usize)));
        if let Some(st) = gone {
            let _: () = msg_send![st.image as id, release];
        }
        let _: () = msg_send![super(this, class!(NSView)), dealloc];
    }
}

fn view_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut b = objc2::declare::ClassBuilder::new(c"TopicsChartHoverView", class!(NSView)).expect("TopicsChartHoverView registered twice");
        unsafe {
            b.add_method(sel!(isFlipped), is_flipped as extern "C" fn(id, Sel) -> Bool);
            b.add_method(sel!(drawRect:), draw_rect as extern "C" fn(id, Sel, NSRect));
            b.add_method(sel!(mouseMoved:), mouse_moved as extern "C" fn(id, Sel, id));
            b.add_method(sel!(mouseExited:), mouse_exited as extern "C" fn(id, Sel, id));
            b.add_method(sel!(dealloc), dealloc as extern "C" fn(id, Sel));
        }
        b.register()
    })
}

/// A retained view of `frame` that draws `image` and answers to the mouse over `zones`. The caller owns the
/// returned reference (release it after `setView:`); the view keeps its own hold on the image.
pub unsafe fn new_view(frame: NSRect, image: id, zones: Vec<HoverZone>) -> id {
    let view: id = msg_send![view_class(), alloc];
    let view: id = msg_send![view, initWithFrame: frame];
    let _: id = msg_send![image, retain];
    let width = frame.size.width as f32;
    VIEWS.lock().unwrap().get_or_insert_with(HashMap::new).insert(view as usize, ViewState { image: image as usize, zones, width, mark: None });
    // MouseEnteredAndExited | MouseMoved | ActiveAlways | InVisibleRect: it follows the view whatever its size
    let area: id = msg_send![class!(NSTrackingArea), alloc];
    let area: id = msg_send![area, initWithRect: frame, options: 0x283usize, owner: view, userInfo: nil];
    let _: () = msg_send![view, addTrackingArea: area];
    let _: () = msg_send![area, release];
    view
}
