//! Global shortcuts and the app menu: the native chord forwarder, the global
//! Cmd tap, the accessibility prompt and the action behind every menu id.
//! Moved out of lib.rs verbatim.

use super::*;

/// Map a keyDown chord to the JS that re-dispatches it as a synthetic keydown on
/// the main webview's window (so the single `useKeyboardShortcuts` handler runs),
/// or None if the chord is NOT an app shortcut (let the focused page keep it).
///
/// The ⌘-chord allowlist is GENERATED from the shared registry
/// (`shared/shortcuts.ts` → `shortcuts_generated::is_forwarded_cmd_chord`), so it
/// can't silently drift from the "Keyboard Shortcuts" window. It deliberately
/// EXCLUDES page-critical chords (⌘C/⌘V/⌘X/⌘A/⌘Z, ⌘R reload) — those registry
/// rows carry no `native` flag, so a focused web page keeps them. ⌘F and ⌘G
/// are NOT among them any more: find-in-pane opens the app's own bar on the
/// focused pane (BROWSER-FIND-02), so they are forwarded and the page no longer
/// receives them (a page with its own ⌘F, Google Docs, loses it on the Mac).
/// The fail-safe default stays "not a chord → pass through". Tab-cycle (keyCode
/// 48) and bare Escape (keyCode 53) key off `key_code`, not chars, so they stay
/// hand-written here.
///
/// `alt` is CARRIED, never consulted: whether to forward 'e' is the same answer
/// with and without Option, exactly as it is Shift-agnostic for 'w', so neither
/// the branches below nor the generated table gain a parameter. What Option DOES
/// change is the event the renderer receives, and that is the whole point:
/// `charactersIgnoringModifiers` drops Option by definition, so ⌘E and ⌥⌘E reach
/// here with the same `chars`. With `altKey` hard-coded false, ⌥⌘E typed over a
/// native browser pane did not go inert - it ARRIVED AS ⌘E, and the original was
/// swallowed right after, so asking for one cell got you the whole scope in
/// silence. The renderer tells the two apart on `e.altKey` alone; it can only do
/// that if the real bit gets this far (LAYOUT-40).
#[cfg(target_os = "macos")]
pub(crate) fn app_chord_dispatch_js(cmd: bool, ctrl: bool, shift: bool, alt: bool, chars: &str, key_code: u16) -> Option<String> {
    // Tab == keyCode 48. Standard cycle: ⌃Tab, ⌃⇧Tab, ⌘⇧Tab (⌘Tab is macOS).
    let is_tab = key_code == 48;
    // Escape == keyCode 53. Bare key, no modifier — mirrors claude-code's Esc:
    // interrupts the focused panel's running turn. Handled here too because a
    // focused child WKWebView (embedded browser pane) swallows it just like
    // every other chord below; without this, Esc only stops streaming when
    // the main renderer itself holds focus.
    let is_escape = key_code == 53;
    let key: &str = if is_escape && !cmd && !ctrl && !shift {
        "Escape"
    } else if is_tab && (ctrl || (cmd && shift)) {
        "Tab"
    } else if cmd && !ctrl && shortcuts_generated::is_forwarded_cmd_chord(shift, chars) {
        // Forwarded ⌘-chord (from the registry): re-dispatch it as-is. The set —
        // ⌘W/K/B/P/N/F/G, ⌘1‥9, ⌘⇧T/⌘⇧U, ⌘//⌘? — is generated; ⌘C/V/X/A/Z/R and
        // everything else carry no `native` flag, so the page keeps them.
        chars
    } else {
        return None;
    };
    // `key` for a letter is lowercase; the renderer checks both cases and reads
    // shiftKey, so lowercase + the shift flag is enough. Only quote-safe chars
    // reach here ('/', '?', letters, digits, 'Tab'). `altKey` used to be a
    // hard-coded `false` here, which flattened EVERY forwarded chord, Escape and
    // Tab included, not just the new one.
    Some(format!(
        "window.dispatchEvent(new KeyboardEvent('keydown',{{key:'{key}',metaKey:{cmd},ctrlKey:{ctrl},shiftKey:{shift},altKey:{alt},bubbles:true,cancelable:true}}))"
    ))
}

/// macOS: forward app keyboard shortcuts to the renderer WHEN a child browser
/// pane (WKWebView) holds keyboard focus.
///
/// A focused child WKWebView swallows keydown events before they reach the main
/// webview, so ⌘W / ⌘⇧Tab / ⌘1-9 never reach `useKeyboardShortcuts` — the tab
/// won't close, the "devo cliccare sulla tab per fare ⌘W" bug. Menu accelerators
/// don't help (the focused WKWebView eats their key-equivalents too — same reason
/// ⌘R is intercepted in the renderer). A LOCAL NSEvent monitor sees the event
/// first: for the allowlisted app chords, and ONLY when the first responder is
/// NOT inside the main webview, re-dispatch the chord as a synthetic keydown into
/// the main webview (so the one renderer handler runs) and swallow the original
/// (so the page doesn't also act on it). Everything else — all page typing, and
/// ⌘C/⌘V/⌘Z which the page needs — passes through untouched.
#[cfg(target_os = "macos")]
pub(crate) fn install_shortcut_forwarder(app: &tauri::AppHandle) {
    use crate::mac::*;
    use tauri::Manager;

    // Seed the UI-webview registry with the main window before the monitor arms
    // (detach windows register themselves as they're built). The monitor
    // resolves the target window PER EVENT from this map — never a cached single
    // pointer, which mis-forwarded ⌘W from a detached window into main.
    // Qui `get_webview_window` va bene, ed è per il momento in cui gira: siamo in
    // `setup()`, prima che il frontend possa aver chiesto una pane browser, quindi
    // la mappa filtrata e quella completa coincidono ancora. Serve una
    // `WebviewWindow` vera perché il registro vuole DUE puntatori, la NSWindow e
    // la NSView della sua webview di UI. Se un giorno questa riga si spostasse
    // dopo l'avvio dell'event loop tornerebbe `None` con una pane aperta — e
    // senza registro il monitor NSEvent esce prima di guardare ⌘R.
    if let Some(win) = app.get_webview_window("main") {
        register_ui_webview(&win, "main");
    }

    let app = app.clone();
    let mask: u64 = 1 << 10; // NSEventMaskKeyDown
    let block = block2::RcBlock::new(move |event: id| -> id {
        unsafe {
            // Resolve which of OUR windows fired this event and what its UI
            // webview is. The event's NSWindow keys the registry; if it isn't
            // one of ours (or the window died), pass the event untouched.
            let ev_window: id = msg_send![event, window];
            if ev_window == nil { return event; }
            let ev_window_ptr = ev_window as usize;
            let ui_view_ptr: usize = match UI_WEBVIEW_BY_NSWINDOW
                .get()
                .and_then(|m| m.lock().ok().and_then(|g| g.get(&ev_window_ptr).copied()))
            {
                Some(p) if p != 0 => p,
                _ => return event, // not an app window we manage
            };

            // ⌘R / ⌘⇧R = reload the app — the ONE chord that must win over EVERY
            // focus context. A focused child WKWebView (browser pane) or an xterm
            // terminal eats the menu accelerator's key-equivalent, so ⌘R never
            // reloaded unless the main chrome itself held focus ("premo reload e
            // non succede nulla"). The NSEvent monitor sees the key first — so we
            // handle it HERE, BEFORE the inside-UI gate below, riparte TUTTA la
            // app (`reload_all_ui_windows`, la stessa logica di `app_reload_all`),
            // poi ingoia l'originale così né la pane né il terminale agiscono
            // anche loro. `location.reload()` re-fetches index.html + bundle = the
            // app reload the user expects. (Only ⌘R without Ctrl — leaves ⌃R and
            // page shortcuts alone.)
            //
            // TUTTE le finestre, non solo quella dell'evento: siccome qui si
            // ingoia il keydown, `useKeyboardShortcuts` — che chiamava
            // `reloadAllWindows` — non vede mai ⌘R, quindi questo ramo È il ⌘R
            // del desktop. Ricaricarne una sola lasciava i gruppi staccati sul
            // bundle vecchio, due versioni dello stesso client sullo stesso
            // pane-store.
            //
            // E senza Shift: ⌘⇧R è "Record voice" (lo dicono il tooltip del
            // microfono e il pannello delle scorciatoie). Togliere l'acceleratore
            // dal menu — dove stava per sbaglio su "Force Reload" — non bastava:
            // questo monitor vede il tasto PRIMA del menu e prima della webview,
            // quindi continuava a ricaricare l'app al posto di far partire il
            // dettato, e a ingoiare l'evento perché la UI non lo vedesse mai.
            {
                let flags_r: u64 = msg_send![event, modifierFlags];
                let cmd_r = flags_r & (1 << 20) != 0;
                let ctrl_r = flags_r & (1 << 18) != 0;
                let shift_r = flags_r & (1 << 17) != 0;
                let chars_r_id: id = msg_send![event, charactersIgnoringModifiers];
                let chars_r = ns_string_to_rust(chars_r_id).to_lowercase();
                if cmd_r && !ctrl_r && !shift_r && chars_r == "r" {
                    // no_abort: si sta girando dentro un blocco NSEvent, dove un
                    // panic non ha nessuno che lo raccolga — sarebbe un abort
                    // dell'intera app su una pressione di ⌘R.
                    let _ = no_abort("cmd_r_reload_all", || Ok(reload_all_ui_windows(&app)));
                    return nil; // swallow — the pane/terminal must not also see ⌘R
                }
            }

            // If the first responder is inside THIS window's own UI webview, the
            // renderer's keydown path handles the chord — never double-fire.
            // Only a child browser PANE reaches the forward path. Da quando
            // browser_open parenta la webview alla finestra ospite, anche un
            // pop-out PUÒ avere una pane browser: NON dare più per scontato che
            // «una finestra staccata non ha pane browser». Non serve comunque,
            // perché il forward qui sotto risolve la UI webview dalla finestra
            // dell'evento (ev_window_ptr) — il chord agisce dove è stato digitato,
            // pop-out incluso, con fallback a main.
            let fr: id = msg_send![ev_window, firstResponder];
            if fr == nil { return event; }
            let ui_view = ui_view_ptr as id;
            let is_view: BOOL = msg_send![fr, isKindOfClass: class!(NSView)];
            if is_view == YES {
                let inside_ui: BOOL = msg_send![fr, isDescendantOf: ui_view];
                if inside_ui == YES { return event; } // UI webview → normal path
            }

            // A browser pane holds focus. Is this an app chord we should forward?
            let flags: u64 = msg_send![event, modifierFlags];
            const CMD: u64 = 1 << 20;
            const CTRL: u64 = 1 << 18;
            const SHIFT: u64 = 1 << 17;
            // Option. Same number the right-⌘ monitor already spells out in its
            // OTHER_MODS mask below. Read here because `charactersIgnoringModifiers`
            // strips Option: without this bit ⌥⌘E and ⌘E are indistinguishable by
            // the time they reach `app_chord_dispatch_js`, and the renderer, which
            // splits the two zoom scopes on `e.altKey`, would see them as one.
            const OPT: u64 = 1 << 19;
            let cmd = flags & CMD != 0;
            let ctrl = flags & CTRL != 0;
            let shift = flags & SHIFT != 0;
            let alt = flags & OPT != 0;
            let key_code: u16 = msg_send![event, keyCode];
            let chars_id: id = msg_send![event, charactersIgnoringModifiers];
            let chars = ns_string_to_rust(chars_id).to_lowercase();

            if let Some(js) = app_chord_dispatch_js(cmd, ctrl, shift, alt, &chars, key_code) {
                // Forward into the SAME window's UI webview (resolve its label by
                // matching the event NSWindow), so the chord acts where it was
                // typed. Le pane browser ora possono vivere anche in un pop-out
                // (browser_open le parenta alla finestra ospite): keying off the
                // event window è ciò che tiene corretto questo forward.
                let mut dispatched = false;
                // `windows()`: questo ramo gira PROPRIO QUANDO una pane browser
                // ha il fuoco, cioè esattamente quando la mappa filtrata non
                // contiene la finestra dell'evento. Il confronto non combaciava
                // mai, `dispatched` restava false e si finiva sempre nel
                // fallback su "main": con un pop-out il chord digitato lì
                // atterrava nella finestra principale.
                for (label, w) in app.windows() {
                    if w.ns_window().map(|p| p as usize).ok() == Some(ev_window_ptr) {
                        if let Some(wv) = app.get_webview(&label) {
                            let _ = wv.eval(&js);
                            dispatched = true;
                        }
                        break;
                    }
                }
                if !dispatched {
                    if let Some(mw) = app.get_webview("main") {
                        let _ = mw.eval(&js);
                    }
                }
                // Bare Esc is forwarded best-effort (interrupt a streaming turn)
                // but must ALSO reach the focused page: unlike the ⌘-chords the
                // page has first-class uses for Esc (close dialogs, cancel).
                // The renderer side no-ops unless a session is streaming.
                if key_code == 53 && !cmd && !ctrl && !shift {
                    return event;
                }
                return nil; // swallow — the page must not also act on the chord
            }
            event // not an app chord → let the focused page have it
        }
    });
    unsafe {
        let _monitor: id = msg_send![class!(NSEvent),
            addLocalMonitorForEventsMatchingMask: mask,
            handler: &*block];
    }
    // AppKit Block_copy'd the handler; keep OUR heap block alive for the app
    // lifetime too (the monitor is never removed).
    std::mem::forget(block);
}

// ─────────────────── Global right-⌘ tap → focus the task composer ──────────────
//
// Renderer-parity for the "tap right-⌘ to jump to the board composer" gesture,
// but working from ANY app (when Topics is in the background). The in-app path
// (useKeyboardShortcuts, MetaRight keyup within 400 ms) only sees keys while the
// webview has focus; a GLOBAL NSEvent monitor sees them system-wide. The two
// don't collide: a global monitor is only delivered while OUR app is inactive —
// once Topics is frontmost the renderer path owns the gesture.
//
// Detection mirrors the renderer: a bare right-⌘ PRESS arms a timestamp; the
// matching RELEASE fires only if it came quickly (< 400 ms) with nothing in
// between — any other key, modifier, mouse, or scroll disarms it, so right-⌘
// held as a modifier (⌘C, ⌘-click) never triggers. On a real tap we activate
// Topics and re-dispatch the existing `task-composer:focus` renderer event.
//
// Keyboard events reach a global monitor ONLY when the process is trusted for
// Accessibility — `install_accessibility_prompt` requests that; until it's
// granted (may need a relaunch) the monitor is installed but simply receives
// nothing, so this degrades to "in-app only" rather than breaking.
#[cfg(target_os = "macos")]
pub(crate) fn install_global_cmd_tap(app: &tauri::AppHandle) {
    use crate::mac::*;
    use std::cell::Cell;
    use std::rc::Rc;

    // NSEventMask bits. Two SEPARATE monitors, one per role, so neither block
    // ever calls `-[NSEvent type]` — the objc `sel!` macro mangles the raw
    // identifier `r#type` into the bogus selector "r#type", which NSEvent does
    // not recognize → doesNotRecognizeSelector → uncaught NSException →
    // objc_terminate → SIGABRT on EVERY event once the monitor is live. Splitting
    // by mask lets each block know its event kind statically and only send
    // selectors NSEvent actually responds to.
    const MASK_FLAGS_CHANGED: u64 = 1 << 12; // ⌘ press/release
    const MASK_DISARM: u64 = (1 << 10)       // key down
        | (1 << 1) | (1 << 3)                // left/right mouse down
        | (1 << 22);                         // scroll wheel

    // kVK_RightCommand. Left ⌘ is 55; we intentionally only bind the right one.
    const RIGHT_CMD_KEYCODE: u16 = 54;
    // Device-independent modifier bits (mask off the low device-dependent byte).
    const DEVICE_INDEPENDENT: u64 = 0xffff_0000;
    const FLAG_COMMAND: u64 = 1 << 20;
    // Every OTHER modifier that must be absent for a *bare* right-⌘ tap.
    const OTHER_MODS: u64 =
        (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 23); // caps/shift/ctrl/opt/fn

    // Global monitors are delivered on the main run loop, so a plain non-atomic
    // Cell shared via Rc between the two blocks is safe (never touched off-main).
    // Armed timestamp (NSEvent.timestamp, seconds since boot); 0.0 = disarmed.
    let armed_at = Rc::new(Cell::new(0.0_f64));

    // ── Monitor 1: flagsChanged — arm on bare right-⌘ press, fire on quick release ──
    let app_flags = app.clone();
    let armed_flags = armed_at.clone();
    let flags_block = block2::RcBlock::new(move |event: id| {
        unsafe {
            // Every event here is a flagsChanged, so keyCode/modifierFlags/timestamp
            // are all valid selectors on it.
            let key_code: u16 = msg_send![event, keyCode];
            let flags: u64 = msg_send![event, modifierFlags];
            let ts: f64 = msg_send![event, timestamp];
            let dev = flags & DEVICE_INDEPENDENT;
            let cmd_now = dev & FLAG_COMMAND != 0;
            let others = dev & OTHER_MODS != 0;

            if key_code != RIGHT_CMD_KEYCODE {
                armed_flags.set(0.0); // a different modifier changed → disarm
                return;
            }
            if cmd_now && !others {
                armed_flags.set(ts); // bare right-⌘ pressed → arm
            } else if !cmd_now {
                // Right-⌘ released — fire only for a quick, uninterrupted tap.
                let start = armed_flags.get();
                armed_flags.set(0.0);
                if start > 0.0 && ts - start < 0.4 {
                    focus_task_composer_from_background(&app_flags);
                }
            } else {
                armed_flags.set(0.0); // right-⌘ + another modifier → chord, not a tap
            }
        }
    });

    // ── Monitor 2: any other key / mouse / scroll → disarm (never a tap) ──
    let armed_disarm = armed_at.clone();
    let disarm_block = block2::RcBlock::new(move |_event: id| {
        armed_disarm.set(0.0);
    });

    unsafe {
        let _m1: id = msg_send![class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: MASK_FLAGS_CHANGED,
            handler: &*flags_block];
        let _m2: id = msg_send![class!(NSEvent),
            addGlobalMonitorForEventsMatchingMask: MASK_DISARM,
            handler: &*disarm_block];
    }
    // Keep the heap blocks alive for the app lifetime (monitors are never removed).
    std::mem::forget(flags_block);
    std::mem::forget(disarm_block);
}

/// Activate Topics (it was in the background) and focus the board's task composer.
/// Called from the global right-⌘ tap monitor. The AppKit activation + Tauri window
/// ops are pushed onto the main-thread event loop via `run_on_main_thread` (even
/// though the monitor already runs on main) so the work never re-enters the window
/// dispatcher inline from inside an event-handler frame.
#[cfg(target_os = "macos")]
pub(crate) fn focus_task_composer_from_background(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use crate::mac::*;
        if let Some(win) = app.get_window("main") {
            unsafe {
                let nsapp: id = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![nsapp, activateIgnoringOtherApps: YES];
            }
            ensure_window_visible(&win);
            if let Some(wv) = app.get_webview("main") {
                let _ = wv.eval("window.dispatchEvent(new CustomEvent('task-composer:focus'))");
            }
        }
    });
}

// Request Accessibility trust so the global monitor above receives key events — but
// AT MOST ONCE per install. `AXIsProcessTrustedWithOptions` with the prompt option
// shows the scary system dialog ("Topics wants to control this computer using
// accessibility features") and drops the app into System Settings ▸ Privacy ▸
// Accessibility. macOS re-shows it on EVERY launch while the app stays untrusted, so
// a fresh user who ignores it — Accessibility is a heavy ask for what is only a
// convenience here (the global right-⌘ tap → focus the board composer) — gets
// re-nagged forever. That's the "chiede troppi permessi" a new install hits. So we
// prompt once and never again: already trusted → silent no-op; already asked → stay
// quiet. A user who wants the global tap grants it on the single ask (or later, from
// System Settings — the first prompt already listed the app there); everyone else is
// asked exactly once. Either way the in-app gesture and the rest of the app are
// unaffected: without trust the global monitor is simply inert.
#[cfg(target_os = "macos")]
pub(crate) fn install_accessibility_prompt(app: &tauri::AppHandle) {
    use crate::mac::*;
    use tauri::Manager;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        // Takes a CFDictionaryRef; NSDictionary is toll-free bridged, so we pass an id.
        fn AXIsProcessTrustedWithOptions(options: id) -> bool;
    }

    unsafe {
        if AXIsProcessTrusted() {
            return; // already granted — silent no-op
        }
    }

    // At-most-once gate. The marker lives beside the app's per-user config so it
    // survives relaunches (a genuine uninstall/reinstall may legitimately ask again).
    // If the dir can't be resolved we key a temp path off the bundle id, so a broken
    // path degrades to "ask again next launch" rather than a nag loop or a crash.
    let marker = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"))
        .join(".accessibility-prompted");
    if marker.exists() {
        log::info!(
            "[topics] Accessibility not granted but already prompted once — not re-asking. \
             Enable it in System Settings ▸ Privacy & Security ▸ Accessibility to use the \
             global right-⌘ tap."
        );
        return;
    }

    unsafe {
        // options = @{ @"AXTrustedCheckOptionPrompt": @YES } — the constant's value
        // IS this string, so a literal key avoids linking the CFString global.
        let key_ns = nsstring("AXTrustedCheckOptionPrompt");
        let key: id = objc2::rc::Retained::as_ptr(&key_ns) as id;
        let yes: id = msg_send![class!(NSNumber), numberWithBool: YES];
        let opts: id = msg_send![class!(NSDictionary), dictionaryWithObject: yes, forKey: key];
        let trusted = AXIsProcessTrustedWithOptions(opts);
        if !trusted {
            log::warn!(
                "[topics] Accessibility not yet granted — global right-⌘ tap stays inert \
                 until it's enabled in System Settings ▸ Privacy & Security ▸ Accessibility \
                 (a relaunch may be needed). This prompt won't be shown again."
            );
        }
    }

    // Record the single ask so no future launch re-prompts (whether or not the user
    // granted it this time). Best-effort: a write failure just means we might ask once
    // more next launch — strictly better than a persistent nag.
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&marker, b"1\n");
}

/// Run the app action behind a MENU ID.
///
/// The menu is not the only door to these actions. On Windows the accelerator
/// table `muda` builds is never translated (nobody calls `TranslateAcceleratorW`
/// in the message loop: verified in tao 0.35.3, wry 0.55.1, tauri-runtime-wry
/// 2.11.3), so Ctrl+Q and the zoom chords reach the app only through the
/// WebView2 accelerator hook in `menu_chords_win`. Two doors, ONE body: the ids
/// are the contract between them, and a behaviour that changes here changes for
/// the menu click and for the chord together.
pub(crate) fn run_menu_action(app: &tauri::AppHandle, id: &str) {
    use tauri::Manager;
    match id {
        "reload" | "force-reload" => {
            // Il menu e la scorciatoia sono lo stesso gesto, quindi
            // chiamano la stessa funzione: riparte TUTTA la app, non la
            // sola finestra focussata. Il bundle è uno; ricaricarne una
            // lasciava le altre (gruppi staccati, finestre progetto) su
            // quello vecchio, a parlarsi sullo stesso pane-store.
            // Non serve più risolvere la finestra focussata: le prende
            // tutte, quella inclusa.
            let _ = no_abort("menu_reload_all", || Ok(reload_all_ui_windows(app)));
        }
        "app-quit" => {
            QUITTING.store(true, Ordering::Relaxed);
            app.exit(0);
        }
        "reset-split-layout" => {
            // Dispatch the per-window reset bus on the FOCUSED window's webview
            // (not always "main" — detached project windows may exist). The
            // client's GroupLayout / PanelGrid listen for this and flatten the
            // App-focused surface. Resolve the focused window by label, map it
            // to its webview_window (eval lives on the webview), fall back to
            // "main" if none reports focus (e.g. menu click stole key status).
            let label = app
                .get_focused_window()
                .map(|w| w.label().to_string())
                .unwrap_or_else(|| "main".to_string());
            let win = app
                .get_webview(&label)
                .or_else(|| app.get_webview("main"));
            if let Some(win) = win {
                let _ = win
                    .eval("window.dispatchEvent(new CustomEvent('topics:reset-split-layout'))");
            }
        }
        "always-on-top" => toggle_always_on_top(app),
        "open-at-login" => {
            use tauri_plugin_autostart::ManagerExt;
            let mgr = app.autolaunch();
            let _ = if mgr.is_enabled().unwrap_or(false) {
                mgr.disable()
            } else {
                mgr.enable()
            };
        }
        id @ ("zoom-in" | "zoom-out" | "zoom-reset") => {
            let cur = ZOOM_PERCENT.load(Ordering::Relaxed);
            let next = match id {
                "zoom-in" => (cur + 10).min(300),
                "zoom-out" => (cur - 10).max(50),
                _ => 100,
            };
            ZOOM_PERCENT.store(next, Ordering::Relaxed);
            if let Some(win) = app.get_webview("main") {
                let _ = win.set_zoom(next as f64 / 100.0);
            }
        }
        "help-github" => {
            // Same reaped path the client's openExternal takes — the
            // plugin's opener leaks a zombie per call (see open_external).
            let _ = open_external("https://github.com/armonia/topics-app".to_string());
        }
        "check-updates" => {
            // Hand off to the client's updater flow (reuses updater_check +
            // UpdaterToast). A DOM CustomEvent keeps the shell free of the
            // @tauri-apps/event dependency — same bridge the tray uses.
            if let Some(w) = app.get_window("main") { ensure_window_visible(&w); }
            if let Some(wv) = app.get_webview("main") {
                let _ = wv.eval(
                    "window.dispatchEvent(new CustomEvent('topics:check-for-updates'))",
                );
            }
        }
        _ => {}
    }
}

// Native menu — a WKWebView shell with NO app menu also has no working
// Cmd+C/V/X/A/Z and no Reload. Build the standard macOS menus plus an
// explicit View ▸ Reload (Cmd+R), matching the Electron app.
//
// NOT ON WINDOWS, and it is not a matter of taste. There the menu is not a
// strip at the top of the SCREEN, it is a row inside the WINDOW: with the
// system frame off (`set_decorations(false)` in setup) that row lands right
// above the app's own chrome, so the window carries two bars again. It buys
// nothing either: no accelerator of it ever fired, because nobody calls
// `TranslateAcceleratorW` in the message loop (see `menu_chords_win`, which
// is what actually makes Ctrl+R, Ctrl+0 and the rest work), and every entry
// it lists is reachable from the app itself. Reported from a Windows build
// (card 3198947b): "the View / Help bar we can disable altogether".
//
// Removed and not hidden: `hide_menu()` leaves the menu attached to the
// window, so a later `set_menu`/`show_menu` from anywhere brings the row
// back, and any window built afterwards inherits the app-wide menu. A menu
// that is never built cannot come back on its own.
#[cfg(not(target_os = "windows"))]
pub(crate) fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
    let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    // Nessun acceleratore: Cmd+Shift+R e' "Record voice" nell'app (lo dice
    // il pannello delle scorciatoie e il tooltip del microfono). Il menu
    // teneva la scorciatoia buona per un doppione del Reload qui sopra —
    // e quando il fuoco stava in una webview figlia partiva davvero,
    // ricaricando l'app al posto di far partire il dettato. La voce resta,
    // cliccabile; la scorciatoia torna a chi la documenta.
    //
    // Da SOLO questo non basta e non bastava: il monitor NSEvent (cerca
    // `!shift_r`) intercetta il tasto prima del menu e prima della
    // webview. Sono due porte sulla stessa scorciatoia — se ne riapri una
    // la riapri per tutti.
    let force_reload =
        MenuItem::with_id(handle, "force-reload", "Force Reload", true, None::<&str>)?;
    let zoom_in = MenuItem::with_id(handle, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(handle, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset =
        MenuItem::with_id(handle, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    // No accelerator: the Cmd/Ctrl+Alt+T chord is owned by the global
    // shortcut (works unfocused too); a menu accelerator on the same chord
    // would double-fire and cancel the toggle when the window is focused.
    let always_on_top =
        MenuItem::with_id(handle, "always-on-top", "Always on Top", true, None::<&str>)?;
    // Reset the focused window's split layout — flattens the panel tree
    // back to a single pane. The client already listens on the per-window
    // `topics:reset-split-layout` CustomEvent bus (GroupLayout / PanelGrid),
    // gated on which surface is App-focused, so we just dispatch it on the
    // focused window's webview (see the "reset-split-layout" menu handler).
    // No accelerator: the Command Palette already exposes this action, and a
    // menu chord risks colliding with a future pane shortcut.
    let reset_panels =
        MenuItem::with_id(handle, "reset-split-layout", "Reimposta pannelli", true, None::<&str>)?;
    // "Open at Login" (Electron parity). Toggling registers/removes the
    // LaunchAgent immediately. NOTE: we cannot read the current enabled state
    // here — the .menu() closure runs BEFORE the autostart plugin's setup
    // manages its AutoLaunchManager, so is_enabled() would panic. Plain label.
    let open_at_login =
        MenuItem::with_id(handle, "open-at-login", "Apri al login", true, None::<&str>)?;
    // Custom Quit (not the predefined .quit()) so ⌘Q sets QUITTING before
    // exiting — otherwise the hide-to-tray CloseRequested handler would
    // swallow the quit and trap the app in the tray.
    let app_quit =
        MenuItem::with_id(handle, "app-quit", "Quit Topics", true, Some("CmdOrCtrl+Q"))?;
    // "Check for Updates…" — drives the same client-side updater flow as the
    // sidebar Version popover (dispatches a DOM event the client listens for,
    // which calls updater_check → UpdaterToast). Without a manual entry point
    // the only trigger was the version popover; this makes it discoverable.
    let check_updates = MenuItem::with_id(
        handle,
        "check-updates",
        "Controlla aggiornamenti…",
        true,
        None::<&str>,
    )?;
    let app_menu = SubmenuBuilder::new(handle, "Topics")
        .about(None)
        .separator()
        .item(&check_updates)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&app_quit)
        .build()?;
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&reload)
        .item(&force_reload)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&reset_panels)
        .separator()
        .item(&always_on_top)
        .item(&open_at_login)
        .separator()
        .fullscreen()
        .build()?;
    // NOTE: no `.close_window()` — its default ⌘W accelerator would close
    // the whole window, but in Topics ⌘W closes the focused PANE (handled
    // in the renderer, useKeyboardShortcuts). The window is closed via the
    // traffic-light button. (A pane-close menu accelerator that also works
    // when a child browser webview holds focus lands in the browser phase.)
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .minimize()
        .maximize()
        .build()?;
    let help_github =
        MenuItem::with_id(handle, "help-github", "Topics on GitHub", true, None::<&str>)?;
    let help_menu = SubmenuBuilder::new(handle, "Help").item(&help_github).build()?;
    MenuBuilder::new(handle)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

/// The macOS half of the chord decision, interrogated off the NSEvent monitor.
///
/// `app_chord_dispatch_js` is private but PURE: its body is comparisons on
/// `key_code` and `chars` plus one `format!`, not a single `msg_send!`. Being
/// `#[cfg(target_os = "macos")]` it is compiled AND run by `cargo test --lib` on
/// the developer's own Mac, so the sentence "on macOS the decision cannot be
/// tested" (which `chords.rs` used to carry in its header) was about the welded
/// half only: the `modifierFlags` read at the monitor, which still has no test
/// but the manual pass.
///
/// What these cases pin is the one failure mode LAYOUT-40 calls FORBIDDEN:
/// `charactersIgnoringModifiers` drops Option, so ⌘E and ⌥⌘E reach this function
/// with identical `chars`. While `altKey` was a hard-coded `false`, ⌥⌘E typed
/// over a native browser pane did not go inert - it arrived as ⌘E, and the
/// original NSEvent was swallowed straight after. Asking for one cell and
/// getting the whole scope, silently.
///
/// Two chars on purpose, and it is not zeal. 'w' the registry has forwarded all
/// along, so this case could be written and seen RED before the registry gained
/// 'e' and without depending on it at all; it is also what proves the real
/// claim, namely that the constant flattened EVERY forwarded chord, not just the
/// new one. 'e' is the zoom chord this change adds.
#[cfg(all(test, target_os = "macos"))]
mod mac_chord_dispatch_tests {
    use super::app_chord_dispatch_js;

    /// Any key code that is neither 48 (Tab) nor 53 (Escape), or a different
    /// branch answers and the char never gets looked at. These are the real ANSI
    /// codes for the two letters.
    const KEY_W: u16 = 13;
    const KEY_E: u16 = 14;
    const KEY_F: u16 = 3;
    const KEY_G: u16 = 5;

    /// BROWSER-FIND-02: ⌘F, ⌘G and ⇧⌘G typed inside a native page reach the
    /// app's handler (and the monitor swallows the original). Red before the
    /// registry gained `native` on those rows: the function answered None.
    #[test]
    fn find_chords_reach_the_renderer() {
        let f = app_chord_dispatch_js(true, false, false, false, "f", KEY_F).expect("⌘F must be forwarded");
        assert!(f.contains("key:'f'") && f.contains("metaKey:true") && f.contains("shiftKey:false"), "{f}");
        let g = app_chord_dispatch_js(true, false, false, false, "g", KEY_G).expect("⌘G must be forwarded");
        assert!(g.contains("key:'g'"), "{g}");
        let sg = app_chord_dispatch_js(true, false, true, false, "g", KEY_G).expect("⇧⌘G must be forwarded");
        assert!(sg.contains("shiftKey:true"), "{sg}");
        let sf = app_chord_dispatch_js(true, false, true, false, "f", KEY_F).expect("⇧⌘F must be forwarded");
        assert!(sf.contains("key:'f'") && sf.contains("shiftKey:true"), "{sf}");
        // Ctrl proper on a Mac is the page's (forward one char in a field).
        assert!(app_chord_dispatch_js(false, true, false, false, "f", KEY_F).is_none());
    }

    fn cmd_chord(chars: &str, key_code: u16, alt: bool) -> String {
        app_chord_dispatch_js(true, false, false, alt, chars, key_code)
            .unwrap_or_else(|| panic!("⌘{chars} must be a forwarded chord (alt={alt})"))
    }

    #[test]
    fn option_reaches_the_renderer_instead_of_being_flattened() {
        for (chars, key_code) in [("w", KEY_W), ("e", KEY_E)] {
            let with_opt = cmd_chord(chars, key_code, true);
            let without = cmd_chord(chars, key_code, false);
            // Option does not change WHETHER the chord is forwarded: the decision
            // is Option-agnostic, the way it is Shift-agnostic for 'w'.
            assert!(with_opt.contains(&format!("key:'{chars}'")), "{with_opt}");
            assert!(without.contains(&format!("key:'{chars}'")), "{without}");
            // It changes HOW it arrives, and that is all the renderer has to tell
            // the two zoom scopes apart. This is the assertion the falsification
            // bites, so it comes FIRST: put `altKey:false` back as a constant at
            // the `format!` and the two strings become identical, which IS the
            // defect - ⌥⌘E delivered as ⌘E.
            assert_ne!(with_opt, without, "⌥⌘{chars} must not arrive as ⌘{chars}");
            // And which way round, so a red says more than "they match".
            assert!(with_opt.contains("altKey:true"), "⌥⌘{chars}: {with_opt}");
            assert!(without.contains("altKey:false"), "⌘{chars}: {without}");
        }
    }
}
