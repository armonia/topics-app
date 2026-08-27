//! Windows: app shortcuts survive a focused WebView2 browser pane.
//!
//! Same fault as the Mac's, same shape of remedy. A focused child webview eats
//! the keydown before the UI webview sees it, so Ctrl+W / Ctrl+1-9 /
//! Ctrl+Shift+Tab / Escape / Ctrl+R never reach `useKeyboardShortcuts`: click on
//! a page in a browser pane, then press Ctrl+W, and nothing closes. macOS gets
//! the key first with a local NSEvent monitor; here the engine offers the same
//! seat, `ICoreWebView2Controller::add_AcceleratorKeyPressed`, which fires on
//! the PANE's controller for exactly the class of keys involved (modifier
//! combinations, Tab, Escape, function keys), never for plain typing.
//!
//! What to do with the press is not decided here: [`crate::chords`] holds the
//! table, reading the allowlist generated from the shortcut registry. This file
//! is only the plumbing between WebView2 and that table, which is the reason the
//! table is testable on a Mac and this file is not.
//!
//! ONE HONEST DIFFERENCE from macOS, and it is in the engine, not in us:
//! `SetHandled(true)` suppresses WEBVIEW2's own default action for the
//! accelerator (its reload on Ctrl+R, its find bar on Ctrl+F), but the page
//! still receives the DOM keydown. The NSEvent monitor can drop an event
//! outright; here "swallow" means "the browser does not also act", never "the
//! page never knew". For the forwarded chords that is harmless (a web page has
//! no use for Ctrl+W), and it is why Ctrl+R has to be handled here at all: left
//! alone, WebView2 would reload the PANE instead of the app.

use crate::chords::{decide, key_from_virtual_key, Chord, ChordAction};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
use webview2_com::AcceleratorKeyPressedEventHandler;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, MapVirtualKeyW, MAPVK_VK_TO_CHAR, VK_CONTROL, VK_MENU, VK_SHIFT,
};

/// Is that modifier down right now? `GetKeyState` reports the state as of the
/// message being processed, which is this key press: the high bit is "down".
fn is_down(vk: u16) -> bool {
    (unsafe { GetKeyState(vk as i32) } as u16 & 0x8000) != 0
}

/// What the active layout prints on this key with no modifier. The low word of
/// `MapVirtualKeyW(MAPVK_VK_TO_CHAR)` is the character; the top bit marks a dead
/// key, which is not a chord. Returns None when the key has no character.
fn layout_char(vk: u32) -> Option<char> {
    let mapped = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) };
    if mapped == 0 || mapped & 0x8000_0000 != 0 {
        return None;
    }
    char::from_u32(mapped & 0xFFFF)
}

/// Arm the accelerator hook on a browser pane's webview.
///
/// `host_label` is the window that owns the pane: the chord acts where it was
/// typed, pop-out included, because a UI webview carries its window's label
/// (`browser_open` adds the pane as a child of the host window). Called right
/// after the pane is created; the pane's own controller keeps the handler alive,
/// and it dies with the pane.
pub(crate) fn install(app: &tauri::AppHandle, pane: &tauri::Webview, host_label: &str) {
    let app = app.clone();
    let host = host_label.to_string();
    let pane_label = pane.label().to_string();
    let res = pane.with_webview(move |platform| {
        let controller = platform.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // A panic here would unwind into the COM vtable, where unwinding is
            // forbidden: that is an abort of the whole app on a key press. Same
            // guard, same reason, as the NSEvent block on macOS.
            let _ = crate::no_abort("chords_win", || {
                on_accelerator(&app, &host, &args);
                Ok(())
            });
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
            log::warn!("[topics] {pane_label}: accelerator hook not armed: {e}");
        }
    });
    if let Err(e) = res {
        log::warn!("[topics] chords_win: with_webview failed: {e}");
    }
}

/// One accelerator press: read the facts, ask the table, act.
fn on_accelerator(
    app: &tauri::AppHandle,
    host: &str,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs,
) {
    use tauri::Manager;

    // Key DOWN only: the release of the same chord fires this too, and acting on
    // both would run every shortcut twice.
    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
    if unsafe { args.KeyEventKind(&mut kind) }.is_err()
        || (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
            && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
    {
        return;
    }
    let mut vk: u32 = 0;
    if unsafe { args.VirtualKey(&mut vk) }.is_err() {
        return;
    }

    let chord = Chord {
        ctrl: is_down(VK_CONTROL.0),
        shift: is_down(VK_SHIFT.0),
        alt: is_down(VK_MENU.0),
        key: key_from_virtual_key(vk, layout_char(vk)),
    };

    match decide(&chord) {
        ChordAction::PassThrough => {}
        ChordAction::ReloadApp => {
            crate::reload_all_ui_windows(app);
            let _ = unsafe { args.SetHandled(true) };
        }
        ChordAction::Forward { js, swallow } => {
            // The host window's UI webview, so the chord acts in the window it
            // was typed in; "main" only as the fallback for a host that died.
            let target = app
                .get_webview(host)
                .or_else(|| app.get_webview("main"));
            if let Some(ui) = target {
                let _ = ui.eval(&js);
            }
            if swallow {
                let _ = unsafe { args.SetHandled(true) };
            }
        }
    }
}
