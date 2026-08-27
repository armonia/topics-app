//! Which app chord a focused browser pane must NOT keep, and what the shell does
//! with it. Windows shape of the table, compiled on EVERY platform.
//!
//! On macOS the same decision lives in `lib.rs` (`app_chord_dispatch_js` plus the
//! reload branch of `install_shortcut_forwarder`), where it is welded to an
//! NSEvent monitor: pure logic and AppKit calls in one block, so nothing of it
//! can be run off a Mac and nothing of it is covered by a test. The Windows
//! counterpart splits the two: this module is the decision, `chords_win.rs` is
//! the WebView2 plumbing that feeds it.
//!
//! It is therefore compiled everywhere on purpose (`cargo test --lib` proves the
//! table on the developer's Mac, where no WebView2 exists), and only Windows
//! calls it at runtime.
//!
//! The allowlist of forwarded chords is NOT written here: it comes from
//! [`crate::shortcuts_generated::is_forwarded_cmd_chord`], generated from the
//! shortcut registry (`shared/shortcuts.ts`) that also renders the "Keyboard
//! Shortcuts" window. One registry, both sides, no silent drift.

use crate::shortcuts_generated::is_forwarded_cmd_chord;

/// The key of a chord, reduced to what the decision needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChordKey {
    /// The character the key prints WITHOUT Shift, lowercased. macOS reads it
    /// from `charactersIgnoringModifiers`; on Windows it is the letter/digit of
    /// the virtual key, or what the active layout maps an OEM key to.
    Char(char),
    Tab,
    Escape,
    /// Everything the table has no opinion about (arrows, function keys, a key
    /// whose layout character could not be resolved).
    Other,
}

/// One key press, as the decision sees it. `ctrl` is the app modifier on this
/// platform (Command on macOS, Control on Windows).
#[derive(Debug, Clone, Copy)]
pub struct Chord {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub key: ChordKey,
}

/// What the shell must do with the press.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChordAction {
    /// Not an app chord: the focused page keeps it, untouched. The fail-safe
    /// default, and the answer for all page typing.
    PassThrough,
    /// Reload every UI window (Ctrl+R), then stop the engine acting on it too.
    ReloadApp,
    /// Re-dispatch the chord as a synthetic keydown on the host window's UI
    /// webview, so the single renderer handler (`useKeyboardShortcuts`) runs.
    ///
    /// `swallow` asks the engine not to ALSO perform its own default action for
    /// the accelerator. On Windows that is all it can ask: WebView2 delivers the
    /// key to the page regardless, which is why bare Escape (`swallow: false`)
    /// is not a special case there so much as the general truth made explicit.
    Forward { js: String, swallow: bool },
}

/// Map a Windows virtual-key code to the key the table reasons about.
///
/// `layout_char` is what the active keyboard layout says the key prints with no
/// modifier (`MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR)` in the caller, since it is a
/// Win32 call). It is only consulted for keys that are not letters or digits,
/// which is where layouts actually differ: the `/` of `Ctrl+/` is `VK_OEM_2` on
/// a US keyboard and another OEM key elsewhere.
pub fn key_from_virtual_key(vk: u32, layout_char: Option<char>) -> ChordKey {
    const VK_TAB: u32 = 0x09;
    const VK_ESCAPE: u32 = 0x1B;
    match vk {
        VK_TAB => ChordKey::Tab,
        VK_ESCAPE => ChordKey::Escape,
        // '0'-'9' and 'A'-'Z' are their own ASCII codes as virtual keys.
        0x30..=0x39 => ChordKey::Char(vk as u8 as char),
        0x41..=0x5A => ChordKey::Char((vk as u8 as char).to_ascii_lowercase()),
        // Numpad digits: same chord for whoever types 1-9 over there.
        0x60..=0x69 => ChordKey::Char((b'0' + (vk - 0x60) as u8) as char),
        _ => match layout_char {
            Some(c) if !c.is_control() => ChordKey::Char(c.to_ascii_lowercase()),
            _ => ChordKey::Other,
        },
    }
}

/// The JS that re-dispatches the chord on the UI webview's window. Only chars
/// the registry allowlisted (letters, digits, `/`, `?`) plus `Tab`/`Escape`
/// reach here, so the single quotes need no escaping.
fn dispatch_js(key: &str, ctrl: bool, shift: bool) -> String {
    format!(
        "window.dispatchEvent(new KeyboardEvent('keydown',{{key:'{key}',metaKey:false,ctrlKey:{ctrl},shiftKey:{shift},altKey:false,bubbles:true,cancelable:true}}))"
    )
}

/// The whole decision. Everything not named here passes through.
pub fn decide(c: &Chord) -> ChordAction {
    // Alt belongs to the system and to the menu (Alt+F4, Alt+Space), and the one
    // Alt chord the app owns (Ctrl+Alt+T, always on top) is registered as a
    // global hotkey, which sees the key before any webview does.
    if c.alt {
        return ChordAction::PassThrough;
    }
    match c.key {
        // Bare Escape interrupts a streaming turn, exactly like the Mac: the
        // renderer no-ops unless a session is running. Never swallowed, because
        // the page has first-class uses for it (close a dialog, cancel).
        ChordKey::Escape if !c.ctrl && !c.shift => ChordAction::Forward {
            js: dispatch_js("Escape", false, false),
            swallow: false,
        },
        // Ctrl+Tab / Ctrl+Shift+Tab cycle the tabs. The renderer branch reads
        // `e.ctrlKey || (e.metaKey && e.shiftKey)`, so Ctrl is what to send.
        ChordKey::Tab if c.ctrl => ChordAction::Forward {
            js: dispatch_js("Tab", true, c.shift),
            swallow: true,
        },
        // Ctrl+R reloads the APP, the one chord that wins over every focus
        // context. Not from the registry on purpose: the reload has no renderer
        // handler to forward to (the shell reloads all UI windows itself), and
        // Ctrl+Shift+R stays free for "record voice".
        ChordKey::Char('r') if c.ctrl && !c.shift => ChordAction::ReloadApp,
        // The registry's own list: Ctrl+W/K/B/P/N/T, Ctrl+1-9, Ctrl+/ and the
        // Shift-only ones. Ctrl+C/V/X/A/Z/F carry no `native` flag there, so a
        // focused page keeps them.
        ChordKey::Char(ch) if c.ctrl => {
            let mut buf = [0u8; 4];
            let chars = ch.encode_utf8(&mut buf);
            if is_forwarded_cmd_chord(c.shift, chars) {
                ChordAction::Forward { js: dispatch_js(chars, true, c.shift), swallow: true }
            } else {
                ChordAction::PassThrough
            }
        }
        _ => ChordAction::PassThrough,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(ctrl: bool, shift: bool, key: ChordKey) -> Chord {
        Chord { ctrl, shift, alt: false, key }
    }

    fn forwarded_key(a: &ChordAction) -> Option<(String, bool)> {
        match a {
            ChordAction::Forward { js, swallow } => Some((js.clone(), *swallow)),
            _ => None,
        }
    }

    #[test]
    fn app_chords_from_the_registry_are_forwarded() {
        for ch in ['w', 'k', 'b', 'p', 'n', 't', '1', '9', '/'] {
            let a = decide(&chord(true, false, ChordKey::Char(ch)));
            let (js, swallow) = forwarded_key(&a).unwrap_or_else(|| panic!("Ctrl+{ch} not forwarded"));
            assert!(js.contains(&format!("key:'{ch}'")), "{js}");
            assert!(js.contains("ctrlKey:true") && js.contains("metaKey:false"), "{js}");
            assert!(swallow);
        }
    }

    #[test]
    fn page_chords_stay_with_the_page() {
        for ch in ['c', 'v', 'x', 'a', 'z', 'f', 'l', 'y'] {
            assert_eq!(
                decide(&chord(true, false, ChordKey::Char(ch))),
                ChordAction::PassThrough,
                "Ctrl+{ch} must reach the page"
            );
        }
        // No modifier at all is plain typing.
        assert_eq!(decide(&chord(false, false, ChordKey::Char('w'))), ChordAction::PassThrough);
    }

    #[test]
    fn shift_only_chords_need_shift() {
        // 'u' is Shift-only in the registry (Ctrl+Shift+U), 'w' is not.
        assert_eq!(decide(&chord(true, false, ChordKey::Char('u'))), ChordAction::PassThrough);
        assert!(matches!(
            decide(&chord(true, true, ChordKey::Char('u'))),
            ChordAction::Forward { .. }
        ));
        let a = decide(&chord(true, true, ChordKey::Char('t')));
        let (js, _) = forwarded_key(&a).expect("Ctrl+Shift+T is a registry chord");
        assert!(js.contains("shiftKey:true"), "{js}");
    }

    #[test]
    fn ctrl_r_reloads_the_app_and_shift_r_does_not() {
        assert_eq!(decide(&chord(true, false, ChordKey::Char('r'))), ChordAction::ReloadApp);
        // Ctrl+Shift+R is "record voice", handled in the renderer.
        assert_eq!(decide(&chord(true, true, ChordKey::Char('r'))), ChordAction::PassThrough);
        assert_eq!(decide(&chord(false, false, ChordKey::Char('r'))), ChordAction::PassThrough);
    }

    #[test]
    fn escape_is_forwarded_but_not_swallowed() {
        let a = decide(&chord(false, false, ChordKey::Escape));
        let (js, swallow) = forwarded_key(&a).expect("bare Escape is forwarded");
        assert!(js.contains("key:'Escape'"), "{js}");
        assert!(!swallow, "the page must also see Escape");
        // With a modifier it is not ours (Ctrl+Escape opens the Start menu).
        assert_eq!(decide(&chord(true, false, ChordKey::Escape)), ChordAction::PassThrough);
    }

    #[test]
    fn tab_cycles_only_with_ctrl() {
        let a = decide(&chord(true, true, ChordKey::Tab));
        let (js, swallow) = forwarded_key(&a).expect("Ctrl+Shift+Tab cycles back");
        assert!(js.contains("key:'Tab'") && js.contains("shiftKey:true"), "{js}");
        assert!(swallow);
        assert!(matches!(decide(&chord(true, false, ChordKey::Tab)), ChordAction::Forward { .. }));
        // Bare Tab is the page's own focus traversal.
        assert_eq!(decide(&chord(false, false, ChordKey::Tab)), ChordAction::PassThrough);
    }

    #[test]
    fn alt_is_never_ours() {
        for key in [ChordKey::Char('w'), ChordKey::Char('r'), ChordKey::Tab, ChordKey::Escape] {
            let c = Chord { ctrl: true, shift: false, alt: true, key };
            assert_eq!(decide(&c), ChordAction::PassThrough, "{key:?} with Alt");
        }
    }

    #[test]
    fn unknown_keys_pass_through() {
        assert_eq!(decide(&chord(true, false, ChordKey::Other)), ChordAction::PassThrough);
    }

    #[test]
    fn virtual_keys_map_to_the_characters_the_registry_speaks() {
        assert_eq!(key_from_virtual_key(0x57, None), ChordKey::Char('w')); // 'W'
        assert_eq!(key_from_virtual_key(0x31, None), ChordKey::Char('1'));
        assert_eq!(key_from_virtual_key(0x61, None), ChordKey::Char('1')); // VK_NUMPAD1
        assert_eq!(key_from_virtual_key(0x09, None), ChordKey::Tab);
        assert_eq!(key_from_virtual_key(0x1B, None), ChordKey::Escape);
        // An OEM key is whatever the layout prints on it: US VK_OEM_2 is '/'.
        assert_eq!(key_from_virtual_key(0xBF, Some('/')), ChordKey::Char('/'));
        // Same key on a layout that prints something the registry ignores.
        assert_eq!(key_from_virtual_key(0xBF, Some('-')), ChordKey::Char('-'));
        // No layout character to be had, and keys with no character at all.
        assert_eq!(key_from_virtual_key(0xBF, None), ChordKey::Other);
        assert_eq!(key_from_virtual_key(0x70, None), ChordKey::Other); // VK_F1
    }

    #[test]
    fn a_letter_and_its_virtual_key_reach_the_same_verdict() {
        // The two halves in one line, which is the point of splitting them:
        // key press -> key -> action, all provable off Windows.
        let key = key_from_virtual_key(0x57, None); // Ctrl+W
        assert!(matches!(decide(&chord(true, false, key)), ChordAction::Forward { swallow: true, .. }));
    }
}
