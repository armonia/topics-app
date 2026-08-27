//! Windows: the DWM backdrop behind the app window, tinted with the app's theme.
//!
//! macOS gets its depth from per-region NSVisualEffectViews further up in
//! `lib.rs`. Windows has no equivalent, so the whole window asks DWM for one
//! backdrop and the page floats on top of it. `transparent: true` is already in
//! the shared window config, which is the precondition: `set_effects` documents
//! that it needs a transparent window, and a webview that paints an opaque
//! background hides the backdrop just as effectively (see `windows_repaint`,
//! where the default background colour is now A:0 for exactly this reason).
//!
//! WHY ACRYLIC AND NOT MICA, and where to change your mind: `BACKDROP` below is
//! the ONE line. Mica samples the desktop WALLPAPER, so a window sitting behind
//! ours would not show through at all; the design intent here is the macOS
//! vibrancy, which shows what is actually underneath. Acrylic blurs the real
//! content behind the window, so it is the one that matches. Swapping is
//! `Effect::Mica` (or `MicaLight` / `MicaDark`, which pin the tint instead of
//! following the window theme) in that constant and nothing else.
//!
//! WHAT ACTUALLY CARRIES THE THEME, because it is not the tint. Read
//! `window_vibrancy::apply_acrylic` (0.6.0, already a transitive dependency of
//! tauri, which is why nothing was added to Cargo.toml):
//!
//! ```text
//! build >= 22523   DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE,
//!                                        DWMSBT_TRANSIENTWINDOW)   colour IGNORED
//! build >= 17763   SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND,
//!                                        colour)                   colour USED
//! older            unsupported, returns an error
//! ```
//!
//! So on a current Windows 11 the tint constants below do nothing at all: DWM
//! picks light or dark itself, from `DWMWA_USE_IMMERSIVE_DARK_MODE` on the HWND.
//! The only lever we have on that attribute is the WINDOW THEME, which is why
//! `apply_backdrop` sets it before asking for the effect. The tints still matter
//! on Windows 10 v1809 and on Windows 11 before build 22523, where the legacy
//! composition path is the one that runs and the colour is the whole tint.
//!
//! SIDE EFFECT, stated out loud because this repo has already paid for the macOS
//! version of it (see `apply_appearance` in `lib.rs`): pinning the window theme
//! also flips the page's `prefers-color-scheme`. `tauri-runtime-wry` answers
//! `TaoWindowEvent::ThemeChanged` by calling `SetPreferredColorScheme` on every
//! webview in the window. That does NOT reopen the macOS bug, and the reason is
//! worth writing down. There the loop closed on itself: WKWebView inherits the
//! window's effective appearance, so once "light" was pinned, "system" read our
//! own pin back and never moved. Here mode "system" means `set_theme(None)`,
//! and tao then recomputes the theme from the REGISTRY
//! (`AppsUseLightTheme` under `should_use_dark_mode`), never from the window.
//! The value that comes back is the OS one, so the loop cannot close.
//!
//! This module compiles on EVERY platform and only Windows calls into it. That
//! is deliberate: the sibling file next door carries the scar of a Windows-only
//! line that lived inside a macOS-only block, "compiled nowhere, and no
//! `cargo check` could say so". Cross-checking the real Windows target from a
//! Mac is not available here (`cargo check --target x86_64-pc-windows-msvc` dies
//! in `ring`'s C build, which wants the MSVC headers), so a Mac `cargo check`
//! type-checking these bodies as dead code is the only compile proof there is,
//! and it is worth more than a `#[cfg]` that hides them.

use tauri::window::{Color, Effect, EffectState, EffectsBuilder};

/// Acrylic or Mica: the whole decision, in one line. See the header for why it
/// is Acrylic today.
const BACKDROP: Effect = Effect::Acrylic;

/// The frost, as `(R, G, B, A)`. Both are the app's own `--bg` for that theme
/// (`client/src/index.css`), so the window keeps its colour where the legacy
/// composition path is what runs; see the header for where that is and is not.
/// Alpha stays far below 255 on purpose: at 255 the tint is a flat fill and the
/// blur behind it is invisible, which is the same as having no backdrop.
const TINT_LIGHT: Color = Color(244, 244, 246, 140);
const TINT_DARK: Color = Color(20, 21, 23, 140);

/// The windows that are the APP shell, and therefore the ones that carry the
/// app's chrome: `main`, every pop-out (`detach-*`) and every group window
/// (`space-*`). `browserpane-*` are excluded because they load the open web, not
/// the app.
///
/// THIS SET IS WIDER THAN THE ONE `set_theme` WALKS IN `lib.rs`, on purpose, and
/// the difference is a bug this change would otherwise have shipped. That arm
/// tests `label != "main" && !label.starts_with("detach-")`, so a group window
/// falls out of it. On macOS that is only cosmetic: the group window still gets
/// its frost from the per-region vibrancy views, so nobody ever saw it. On
/// Windows the same omission is a hole in the screen. `window_detach_space`
/// builds the window `transparent(true)` and undecorated, wry then forces the
/// WebView2 background to (0,0,0,0) for any transparent window, and the client
/// tags EVERY Tauri window on Windows with `native-frost`, which paints
/// `html, body, #root` transparent. Transparent window plus transparent page
/// plus no backdrop is not a flat window, it is a see-through one: the live
/// unblurred desktop, straight through the app chrome.
///
/// So the set is widened HERE, where the backdrop is decided, and the macOS arm
/// is left exactly as it was, because nothing on that platform may change. If
/// that arm is ever fixed too, this predicate is what it should call.
pub(crate) fn is_app_shell(label: &str) -> bool {
    label == "main" || label.starts_with("detach-") || label.starts_with("space-")
}

/// Ask DWM for the backdrop on one window, tinted for `dark`.
///
/// `dark: None` is theme mode "system" and means "do not pin anything, follow
/// the OS". The window theme goes back to `None` so tao recomputes it from the
/// registry, and the tint is then read back off the window rather than guessed
/// from a registry key of our own.
///
/// Every call is idempotent, so re-applying on a theme change is the normal path
/// and not a special case. Failures are swallowed on purpose: `apply_acrylic`
/// returns `UnsupportedPlatformVersion` on Windows 10 before v1809, and a window
/// with a flat background is a worse-looking window, not a broken one.
///
/// Callable from `setup()`, before the event loop runs, and it lands there and
/// then rather than a turn later. `set_effects` routes through
/// `run_on_main_thread`, and `send_user_message` in tauri-runtime-wry answers a
/// send that is ALREADY on the main thread by running it inline
/// (`Message::Task(task) => task()`) instead of posting it to a loop that has
/// not started.
pub(crate) fn apply_backdrop(window: &tauri::Window, dark: Option<bool>) {
    #[cfg(target_os = "windows")]
    apply_backdrop_win(window, dark);
    #[cfg(not(target_os = "windows"))]
    let _ = (window, dark);
}

/// The real body. Split out so the platform check is a single line above and
/// this stays type-checked by a `cargo check` on any platform.
fn apply_backdrop_win(window: &tauri::Window, dark: Option<bool>) {
    // FIRST, because on Windows 11 build 22523 and later this is what decides
    // whether the backdrop comes out light or dark; the tint below is ignored
    // there. `None` removes the pin and hands the choice back to the OS.
    let _ = window.set_theme(match dark {
        Some(true) => Some(tauri::Theme::Dark),
        Some(false) => Some(tauri::Theme::Light),
        None => None,
    });
    // Read the window back rather than guess: in "system" mode this is the only
    // way to know which frost the OS just chose. `theme()` is a round trip to
    // the window dispatcher that reads a value tao has already resolved, and it
    // does NOT deadlock when the caller is the main thread: `send_user_message`
    // in tauri-runtime-wry handles a main-thread send inline instead of posting
    // it, so the answer is in the channel before the receive. That is what makes
    // it safe to call this from `setup()`, before the event loop is spinning.
    let is_dark = match dark {
        Some(d) => d,
        None => matches!(window.theme(), Ok(tauri::Theme::Dark)),
    };
    let _ = window.set_effects(
        EffectsBuilder::new()
            .effect(BACKDROP)
            // Windows reads only the effect and the colour out of this config.
            // `state` is macOS-only and inert here; it is set so the config is a
            // complete one and a future macOS reader is not left wondering.
            .state(EffectState::Active)
            .color(if is_dark { TINT_DARK } else { TINT_LIGHT })
            .build(),
    );
}

/// Apply the backdrop to every app-shell window at startup.
///
/// `None` and not a guessed theme: the client calls `set_theme` as soon as it
/// boots, and until then following the OS is the right default. It also costs
/// nothing, because a window that was never pinned is already unpinned and tao
/// short-circuits the call.
///
/// `windows()` and not `webview_windows()`: the filtered map drops any window
/// that has a native browser pane open, and this app has them (the same trap
/// documented at length in `reload_all_ui_windows`). Harmless at startup, where
/// no pane can exist yet, and correct everywhere.
pub(crate) fn wire(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    wire_win(app);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

fn wire_win(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (label, win) in app.windows() {
        if !is_app_shell(&label) {
            continue;
        }
        apply_backdrop(&win, None);
    }
}

/// The Windows half of the `set_theme` command: re-tint every app-shell window
/// for the theme MODE the client just chose.
///
/// Takes the mode string and maps it exactly as the macOS arm does, so the two
/// platforms cannot disagree about what "system" means: anything that is not
/// "dark" or "light" is "do not pin a theme", never "light".
pub(crate) fn apply_theme_mode(app: &tauri::AppHandle, mode: &str) {
    #[cfg(target_os = "windows")]
    apply_theme_mode_win(app, mode);
    #[cfg(not(target_os = "windows"))]
    let _ = (app, mode);
}

fn apply_theme_mode_win(app: &tauri::AppHandle, mode: &str) {
    use tauri::Manager;
    let dark = match mode {
        "dark" => Some(true),
        "light" => Some(false),
        _ => None,
    };
    for (label, win) in app.windows() {
        if !is_app_shell(&label) {
            continue;
        }
        apply_backdrop(&win, dark);
    }
}

#[cfg(test)]
mod tests {
    use super::is_app_shell;

    /// Every window that paints the app must be in, and nothing else. A browser
    /// pane leaking in would put a DWM backdrop behind the open web; an app
    /// window falling out is worse than flat, because the page is transparent
    /// and what shows through the hole is the desktop.
    #[test]
    fn app_shell_is_every_window_that_paints_the_app() {
        assert!(is_app_shell("main"));
        assert!(is_app_shell("detach-0a1b2c3d"));
        // Group windows: `space_window_label` mints `space-{hash:016x}-{n}`.
        assert!(is_app_shell("space-0123456789abcdef-0"));
        assert!(!is_app_shell("browserpane-1"));
        assert!(!is_app_shell("maintenance"));
    }
}
