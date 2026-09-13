//! Reading the AppKit view tree from outside wry: which child webviews exist,
//! in which order they sit in their superview, and which one answers a hit test
//! at a point where two of them overlap.
//!
//! The views are found by walking the tree instead of being handed over by wry,
//! because wry exposes no NSView accessor for a child webview. They are
//! recognised by class name (`WryWebView`, a WKWebView subclass) and named by
//! their width, which the probe chose to be different for each one.

use objc2::rc::Retained;
use objc2_app_kit::{NSResponder, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::NSPoint;
use tao::platform::macos::WindowExtMacOS;

fn ns_window(window: &tao::window::Window) -> &NSWindow {
    // The pointer comes from tao and lives as long as the window does.
    unsafe { &*(window.ns_window() as *const NSWindow) }
}

fn content_view(window: &tao::window::Window) -> Retained<NSView> {
    ns_window(window).contentView().expect("content view")
}

fn is_webview(view: &NSView) -> bool {
    let name = format!("{:?}", view.class());
    name.contains("WryWebView") || name.contains("WKWebView")
}

/// The role each width stands for in this probe: the host page fills the
/// window, the others are the two overlapping panes and the late arrival.
fn role(view: &NSView) -> &'static str {
    match view.frame().size.width as i64 {
        420 => "pane",
        360 => "floater",
        300 => "late",
        _ => "host",
    }
}

fn collect(view: &NSView, out: &mut Vec<Retained<NSView>>) {
    for sub in view.subviews().iter() {
        if is_webview(&sub) {
            out.push(sub);
        } else {
            collect(&sub, out);
        }
    }
}

/// Every child webview under the window, in the order AppKit draws them:
/// first is the bottom of the pile, last is on top.
fn webviews(window: &tao::window::Window) -> Vec<Retained<NSView>> {
    let mut out = Vec::new();
    collect(&content_view(window), &mut out);
    out
}

/// Print the pile, and who answers a hit test at `point` (window coordinates,
/// top-left based like the bounds the client sends).
pub fn report(window: &tao::window::Window, point: (f64, f64)) {
    for (i, view) in webviews(window).iter().enumerate() {
        let f = view.frame();
        println!(
            "   [{i}] {:8} frame=({:.0},{:.0} {:.0}x{:.0})",
            role(view),
            f.origin.x,
            f.origin.y,
            f.size.width,
            f.size.height
        );
    }
    println!(
        "   hit test at ({:.0},{:.0}): {}",
        point.0,
        point.1,
        top_at(window, point)
    );
}

/// Role of the webview that answers a hit test at `point`, or "none". This is
/// the z order as the user experiences it: the view that takes the click is the
/// view drawn over the others.
pub fn top_at(window: &tao::window::Window, point: (f64, f64)) -> String {
    let root = content_view(window);
    // Window coordinates are bottom-left based; the caller thinks top-left,
    // like the client does when it sends bounds.
    let height = root.frame().size.height;
    let Some(hit) = root.hitTest(NSPoint::new(point.0, height - point.1)) else {
        return "none".to_string();
    };
    let views = webviews(window);
    let mut node = Some(hit);
    while let Some(view) = node {
        if views.iter().any(|v| **v == *view) {
            return role(&view).to_string();
        }
        node = unsafe { view.superview() };
    }
    "none".to_string()
}

/// Put the child webview with this role on top of its siblings, exactly the way
/// `browser_raise` in the shell does: `addSubview:positioned:above relativeTo:nil`
/// on the superview it already has, and nothing else. AppKit reorders it in
/// place; a `removeFromSuperview` first would reorder too, but hand the first
/// responder to the window (see `first_responder_is`).
pub fn raise_role(window: &tao::window::Window, which: &str) {
    let views = webviews(window);
    let Some(view) = views.iter().find(|v| role(v) == which) else {
        return;
    };
    let Some(parent) = (unsafe { view.superview() }) else {
        return;
    };
    parent.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Above, None);
}

/// Give the keyboard to the child webview with this role, as a click in its
/// page would. Returns whether AppKit accepted it.
pub fn focus_role(window: &tao::window::Window, which: &str) -> bool {
    let views = webviews(window);
    let Some(view) = views.iter().find(|v| role(v) == which) else {
        return false;
    };
    let responder: &NSResponder = view;
    ns_window(window).makeFirstResponder(Some(responder))
}

/// Is the child webview with this role its window's first responder, the view
/// AppKit sends key events to? The page cannot answer this: after a
/// `removeFromSuperview` + re-add the DOM still reports the same
/// `document.activeElement`, while the keys go to the NSWindow instead.
pub fn first_responder_is(window: &tao::window::Window, which: &str) -> bool {
    let views = webviews(window);
    let Some(view) = views.iter().find(|v| role(v) == which) else {
        return false;
    };
    let Some(first) = ns_window(window).firstResponder() else {
        return false;
    };
    Retained::as_ptr(&first).cast::<()>() == Retained::as_ptr(view).cast::<()>()
}
