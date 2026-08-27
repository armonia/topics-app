//! Windows: the menu accelerators actually fire.
//!
//! `muda` builds the `HACCEL` table for the menu, and then nobody translates it:
//! there is no `TranslateAcceleratorW` in the message loop (tao 0.35.3, wry
//! 0.55.1, tauri-runtime-wry 2.11.3, zero occurrences). So on Windows Ctrl+Q,
//! Ctrl+= , Ctrl+- and Ctrl+0 did nothing at all, while the shortcuts panel kept
//! listing them: the app promised four keys it could not honour.
//!
//! The seat the engine offers is the same one the browser panes use for the app
//! chords, `ICoreWebView2Controller::add_AcceleratorKeyPressed`, only armed on
//! the window's UI webview instead: it fires for modifier combinations, never
//! for plain typing, and it fires BEFORE the page. What the press means is not
//! decided here but in [`crate::menu_chords`], and what it DOES is
//! `run_menu_action`, the same body the menu click runs. One behaviour, two
//! doors.
//!
//! SCOPE, and it is a real edge: this arms the UI webview of each of our
//! windows. A browser pane is a webview of its own with its own controller, so
//! a chord typed while a pane holds focus does not come through here; that half
//! is the app-chord forwarder (card 3f789dfa), which owns the pane's hook.
//!
//! `SetHandled(true)` stops WEBVIEW2's own default for the accelerator (its
//! per-webview zoom on Ctrl+- / Ctrl+=), which is exactly what we want: the zoom
//! that must move is the app's, kept in `ZOOM_PERCENT`, not the engine's private
//! one. The page still receives the DOM keydown, as it always does on Windows.

use crate::menu_chords::{menu_action_for_chord, menu_chord_key};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, MapVirtualKeyW, MAPVK_VK_TO_CHAR, VK_CONTROL, VK_MENU, VK_SHIFT,
};

/// Is that modifier down right now? `GetKeyState` answers as of the message
/// being processed, which is this key press; the high bit means "down".
fn is_down(vk: u16) -> bool {
    (unsafe { GetKeyState(vk as i32) } as u16 & 0x8000) != 0
}

/// What the active layout prints on this key with no modifier. The low word is
/// the character; the top bit marks a dead key, which is never a chord.
fn layout_char(vk: u32) -> Option<char> {
    let mapped = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) };
    if mapped == 0 || mapped & 0x8000_0000 != 0 {
        return None;
    }
    char::from_u32(mapped & 0xFFFF)
}

/// Arm the menu-accelerator hook on a window's UI webview.
///
/// Called for `main` and for every window we build afterwards (detached windows,
/// group windows), because a chord has to work in the window it was typed in and
/// each one carries its own webview. The controller keeps the handler alive and
/// drops it with the window, so there is nothing to unregister.
pub(crate) fn install(app: &tauri::AppHandle, ui_label: &str) {
    use tauri::Manager;
    let Some(webview) = app.get_webview(ui_label) else {
        log::warn!("[topics] menu chords not armed: no webview {ui_label}");
        return;
    };
    let app = app.clone();
    let label = ui_label.to_string();
    let res = webview.with_webview(move |platform| {
        let controller = platform.controller();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // A panic here would unwind into a COM vtable, where unwinding is
            // forbidden: that is the whole app aborting on a key press.
            let _ = crate::no_abort("menu_chords_win", || {
                on_accelerator(&app, &args);
                Ok(())
            });
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) } {
            log::warn!("[topics] {label}: menu accelerator hook not armed: {e}");
        }
    });
    if let Err(e) = res {
        log::warn!("[topics] menu_chords_win: with_webview failed: {e}");
    }
}

/// One accelerator press: read the facts, ask the table, run the menu action.
fn on_accelerator(
    app: &tauri::AppHandle,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs,
) {
    // Key DOWN only. The release of the same chord fires this event too, and
    // acting on both would quit twice and zoom twice.
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
    let Some(key) = menu_chord_key(vk, layout_char(vk)) else {
        return;
    };
    let action = menu_action_for_chord(
        is_down(VK_CONTROL.0),
        is_down(VK_SHIFT.0),
        is_down(VK_MENU.0),
        key,
    );
    if let Some(id) = action {
        crate::run_menu_action(app, id);
        let _ = unsafe { args.SetHandled(true) };
    }
}
