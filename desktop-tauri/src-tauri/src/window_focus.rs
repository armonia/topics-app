//! Whether a Topics window has the focus, told to the page that draws it.
//!
//! WHY THE PAGE CANNOT ASK FOR ITSELF. `document.hasFocus()` in the UI webview
//! reads false exactly when a native browser pane of the same window holds the
//! keyboard (the pane is a sibling webview), so the page's own answer is inverted
//! by the thing the answer is for. The native window knows: `WindowEvent::Focused`
//! is the NSWindow key state on macOS and is synthesised from WebView2 Got/Lost
//! focus on Windows (tauri-runtime-wry 2.11), which already accounts for child
//! webviews.
//!
//! WHO LISTENS. A heavy browser pane stays live only while its window is focused
//! (`client/src/lib/shell/windowFocus.ts`), and the pane polls of that window stop
//! while it is not. So the event has to reach EVERY window that can host a pane:
//! main, a pop-out (`window_detach`) and a group window (`window_detach_space`).
//! Each of the three builders calls `wire` once.

/// The script that tells the page. A `CustomEvent` on `window`, so the client
/// subscribes with a plain listener and no Tauri event plumbing.
pub(crate) fn focus_event_js(focused: bool) -> String {
    format!("window.dispatchEvent(new CustomEvent('topics:window-focus',{{detail:{focused}}}))")
}

/// Forward this window's focus changes to its UI webview.
///
/// `get_webview(label)` and not `get_webview_window`: once a browser pane is a
/// child of the window, the window stops being a single-webview window and the
/// latter returns `None`. `on_window_event` appends a listener, so nothing
/// already listening on the window is replaced.
pub(crate) fn wire<R: tauri::Runtime>(window: &tauri::Window<R>, label: String) {
    use tauri::Manager;
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.eval(focus_event_js(*focused));
            }
        }
    });
}

/// The focus state right now, for a page that has just (re)loaded and missed
/// every event before it.
///
/// `None` where the platform gives no trustworthy answer (Linux), which the
/// client reads as "focused": only an event or a correct answer can pause a pane.
/// On Windows `is_focused()` is NOT corrected for a child WebView2 holding the
/// keyboard, while the top-level window stays the foreground window in that case,
/// so the foreground window is the answer there.
#[tauri::command]
pub(crate) fn window_focus_state(window: tauri::Window) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        window.is_focused().ok()
    }
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let ours = window.hwnd().ok()?;
        let foreground = unsafe { GetForegroundWindow() };
        Some(foreground.0 as isize == ours.0 as isize)
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = window;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::focus_event_js;

    #[test]
    fn the_event_carries_a_boolean_the_page_can_read() {
        assert_eq!(
            focus_event_js(true),
            "window.dispatchEvent(new CustomEvent('topics:window-focus',{detail:true}))"
        );
        assert_eq!(
            focus_event_js(false),
            "window.dispatchEvent(new CustomEvent('topics:window-focus',{detail:false}))"
        );
    }

    /// One `wire` per window kind: main, pop-out, group window. No cargo test can
    /// open a window, and a missing call is silent (that window's panes never
    /// pause and its polls never stop), so the call sites are counted here.
    #[test]
    fn every_window_kind_is_wired() {
        let shell = include_str!("lib.rs");
        let calls = shell.matches("window_focus::wire(").count();
        assert_eq!(calls, 3, "main, window_detach and window_detach_space each wire once");
    }
}
