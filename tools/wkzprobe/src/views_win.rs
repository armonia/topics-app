//! Reading the Win32 child window tree from outside wry: which child webviews
//! exist, in which z order they sit under the window, and which one answers a
//! hit test at a point where two of them overlap. The Windows half of what
//! `views_mac.rs` does with AppKit, same five functions, same meaning.
//!
//! wry gives every child webview a container window of its own, class
//! `WRY_WEBVIEW`, a DIRECT child of the tao window; the WebView2 render windows
//! (`Chrome_WidgetWin_0`, `Chrome_WidgetWin_1`, `Chrome_RenderWidgetHostHWND`,
//! `Intermediate D3D Window`) hang underneath it and belong to the browser
//! processes, not to this one. That container is the same handle
//! `controller().ParentWindow()` hands `browser_win::raise`, so the raise below
//! is the production call and not a lookalike.
//!
//! Views are named by their width, which the probe chose to be different for
//! each one, exactly as the macOS backend does.

use tao::platform::windows::WindowExtWindows;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumChildWindows, GetClassNameW, GetParent, GetWindowRect, SetWindowPos,
    CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE,
};

/// The window class wry registers for the container of each child webview.
const CONTAINER_CLASS: &str = "WRY_WEBVIEW";

fn toplevel(window: &tao::window::Window) -> HWND {
    // The handle comes from tao and lives as long as the window does.
    HWND(window.hwnd() as *mut _)
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

struct Walk {
    top: HWND,
    out: Vec<HWND>,
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // The pointer is the `Walk` the caller kept alive on its own stack.
    let walk = unsafe { &mut *(lparam.0 as *mut Walk) };
    let parent = unsafe { GetParent(hwnd) }.unwrap_or_default();
    if parent == walk.top && class_name(hwnd) == CONTAINER_CLASS {
        walk.out.push(hwnd);
    }
    BOOL(1)
}

/// Every child webview container under the window, in the order Windows paints
/// them: first is the bottom of the pile, last is on top.
///
/// `EnumChildWindows` walks children in z order, top first, so the list is
/// reversed to match what `views_mac.rs` returns.
fn webviews(window: &tao::window::Window) -> Vec<HWND> {
    let top = toplevel(window);
    let mut walk = Walk { top, out: Vec::new() };
    let _ = unsafe {
        EnumChildWindows(
            Some(top),
            Some(collect),
            LPARAM(&mut walk as *mut Walk as isize),
        )
    };
    walk.out.reverse();
    walk.out
}

/// Window rect of `hwnd` in the toplevel's CLIENT coordinates, logical pixels,
/// top-left based: the frame the client asked for when it sent bounds.
fn client_frame(window: &tao::window::Window, hwnd: HWND) -> (f64, f64, f64, f64) {
    let mut r = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let mut origin = POINT { x: 0, y: 0 };
    // `GetWindowRect` answers in screen coordinates; the client origin of the
    // toplevel is what turns them back into the numbers the probe asked for.
    let _ = unsafe { windows::Win32::Graphics::Gdi::ClientToScreen(toplevel(window), &mut origin) };
    let scale = window.scale_factor();
    (
        (r.left - origin.x) as f64 / scale,
        (r.top - origin.y) as f64 / scale,
        (r.right - r.left) as f64 / scale,
        (r.bottom - r.top) as f64 / scale,
    )
}

/// The role each width stands for in this probe: the host page fills the
/// window, the others are the two overlapping panes and the late arrival.
fn role(window: &tao::window::Window, hwnd: HWND) -> &'static str {
    match client_frame(window, hwnd).2.round() as i64 {
        420 => "pane",
        360 => "floater",
        300 => "late",
        _ => "host",
    }
}

fn find(window: &tao::window::Window, which: &str) -> Option<HWND> {
    webviews(window).into_iter().find(|h| role(window, *h) == which)
}

/// Print the pile, and who answers a hit test at `point` (client coordinates,
/// top-left based like the bounds the client sends).
pub fn report(window: &tao::window::Window, point: (f64, f64)) {
    for (i, hwnd) in webviews(window).iter().enumerate() {
        let (x, y, w, h) = client_frame(window, *hwnd);
        println!(
            "   [{i}] {:8} frame=({x:.0},{y:.0} {w:.0}x{h:.0}) hwnd={:?}",
            role(window, *hwnd),
            hwnd.0
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
/// the z order as the user experiences it: the window that takes the click is
/// the window drawn over the others.
///
/// `ChildWindowFromPointEx` searches the DIRECT children of the toplevel in z
/// order and returns the first one that contains the point, which is exactly
/// the pile the containers form.
pub fn top_at(window: &tao::window::Window, point: (f64, f64)) -> String {
    let top = toplevel(window);
    let scale = window.scale_factor();
    let pt = POINT {
        x: (point.0 * scale).round() as i32,
        y: (point.1 * scale).round() as i32,
    };
    let hit = unsafe {
        ChildWindowFromPointEx(top, pt, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT)
    };
    if hit.is_invalid() || hit == top {
        return "none".to_string();
    }
    match webviews(window).into_iter().find(|h| *h == hit) {
        Some(h) => role(window, h).to_string(),
        None => "none".to_string(),
    }
}

/// Put the child webview with this role on top of its siblings, exactly the way
/// `browser_win::raise` in the shell does: `SetWindowPos` to `HWND_TOP` with
/// `SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE` on the container window, and
/// nothing else. `SWP_NOACTIVATE` is what keeps the keyboard where it is, which
/// is the Windows reading of the AppKit arm's first responder.
pub fn raise_role(window: &tao::window::Window, which: &str) {
    let Some(hwnd) = find(window, which) else {
        return;
    };
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

/// Give the keyboard to the child webview with this role, as a click in its
/// page would. Returns whether Windows accepted it.
pub fn focus_role(window: &tao::window::Window, which: &str) -> bool {
    let Some(hwnd) = find(window, which) else {
        return false;
    };
    // `SetFocus` reports the window that held focus before, which says nothing
    // about whether this one took it: `GetFocus` right after is the answer.
    let _ = unsafe { SetFocus(Some(hwnd)) };
    first_responder_is(window, which)
}

/// Does the child webview with this role hold the keyboard focus of this
/// thread's message queue?
///
/// The container itself is what can be focused: the render windows below it
/// belong to the WebView2 browser processes, and `SetFocus` across threads is
/// refused. So focus is looked for on the container OR anywhere under it, which
/// is the same subtree AppKit's first responder check covers.
pub fn first_responder_is(window: &tao::window::Window, which: &str) -> bool {
    let Some(hwnd) = find(window, which) else {
        return false;
    };
    let top = toplevel(window);
    let focus = unsafe { GetFocus() };
    if focus.is_invalid() {
        return false;
    }
    let mut node = focus;
    loop {
        if node == hwnd {
            return true;
        }
        if node == top {
            return false;
        }
        match unsafe { GetParent(node) } {
            Ok(parent) if !parent.is_invalid() => node = parent,
            _ => return false,
        }
    }
}
