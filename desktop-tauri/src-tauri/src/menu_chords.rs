//! Which MENU ACTION a Windows accelerator chord means.
//!
//! The View and Topics menus declare accelerators (`CmdOrCtrl+Q`, `CmdOrCtrl+=`,
//! `CmdOrCtrl+-`, `CmdOrCtrl+0`) and on macOS AppKit honours them by itself. On
//! Windows nobody does: `muda` builds the `HACCEL` table, but no
//! `TranslateAcceleratorW` call exists in the message loop (checked in tao
//! 0.35.3, wry 0.55.1 and tauri-runtime-wry 2.11.3: zero occurrences), so the
//! table is dead weight and the chords listed in the shortcuts panel do nothing.
//!
//! The remedy is the WebView2 accelerator hook in [`crate::menu_chords_win`],
//! and what a press MEANS is decided here, away from the engine: a chord in,
//! a menu id out, no `unsafe`, no COM. That is the whole reason this file is
//! separate from the one that talks to WebView2 — the table is testable on any
//! machine, the plumbing is not.
//!
//! The ids returned are the ones `run_menu_action` already implements, so the
//! chord and the menu click cannot drift into two behaviours.

/// The menu id a chord stands for, or `None` when the press is not ours.
///
/// `key` is the character the key prints on the ACTIVE LAYOUT (see
/// [`menu_chord_key`]), lowercased. Rules, and each one is a decision:
///
/// - Ctrl is required and Alt must be up: `Ctrl+Alt+…` is a layout's AltGr on
///   many keyboards, i.e. someone typing a character, not asking for a menu.
/// - Quit and "actual size" refuse Shift. `Ctrl+Shift+Q` is not Quit anywhere,
///   and a stray Shift must not close the app.
/// - Zoom in accepts `=` and `+` because they are the same physical key: the
///   menu says `Ctrl+=`, the finger usually says `Ctrl+Shift+=`, which prints
///   `+`. Zoom out likewise accepts `-` and `_`.
pub(crate) fn menu_action_for_chord(
    ctrl: bool,
    shift: bool,
    alt: bool,
    key: char,
) -> Option<&'static str> {
    if !ctrl || alt {
        return None;
    }
    match key {
        'q' if !shift => Some("app-quit"),
        '=' | '+' => Some("zoom-in"),
        '-' | '_' => Some("zoom-out"),
        '0' if !shift => Some("zoom-reset"),
        _ => None,
    }
}

/// Normalise a virtual key into the character the chord table reads.
///
/// `layout` is what the key prints with no modifier on the active keyboard
/// layout (`MapVirtualKeyW(MAPVK_VK_TO_CHAR)` on the caller's side), which is
/// why an Italian or German layout works without a table per country: we ask
/// the layout instead of assuming the US one.
///
/// The numeric keypad is the exception, and it has to be: its keys carry no
/// layout character on some drivers, while `Ctrl+numpad-plus` / `Ctrl+numpad-0`
/// are exactly how a lot of people zoom. Those three are mapped by virtual key.
pub(crate) fn menu_chord_key(vk: u32, layout: Option<char>) -> Option<char> {
    match vk {
        VK_NUMPAD0 => return Some('0'),
        VK_ADD => return Some('+'),
        VK_SUBTRACT => return Some('-'),
        _ => {}
    }
    let c = layout?;
    // `to_ascii_lowercase` and not `to_lowercase`: the chords we answer to are
    // all ASCII, and a Turkish dotless-i style mapping has no business here.
    Some(c.to_ascii_lowercase())
}

/// `VK_NUMPAD0`, `VK_ADD`, `VK_SUBTRACT`. Written out instead of imported from
/// the `windows` crate so this file compiles (and is tested) on every platform.
const VK_NUMPAD0: u32 = 0x60;
const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_dead_chords_map_to_their_menu_ids() {
        assert_eq!(menu_action_for_chord(true, false, false, 'q'), Some("app-quit"));
        assert_eq!(menu_action_for_chord(true, false, false, '='), Some("zoom-in"));
        assert_eq!(menu_action_for_chord(true, false, false, '-'), Some("zoom-out"));
        assert_eq!(menu_action_for_chord(true, false, false, '0'), Some("zoom-reset"));
    }

    #[test]
    fn zoom_survives_the_shift_the_finger_adds() {
        // Ctrl+Shift+= prints '+' on a US layout: still zoom in.
        assert_eq!(menu_action_for_chord(true, true, false, '+'), Some("zoom-in"));
        assert_eq!(menu_action_for_chord(true, true, false, '='), Some("zoom-in"));
        assert_eq!(menu_action_for_chord(true, true, false, '_'), Some("zoom-out"));
    }

    #[test]
    fn quit_and_actual_size_refuse_a_stray_shift() {
        assert_eq!(menu_action_for_chord(true, true, false, 'q'), None);
        assert_eq!(menu_action_for_chord(true, true, false, '0'), None);
    }

    #[test]
    fn without_ctrl_or_with_alt_it_is_someone_typing() {
        assert_eq!(menu_action_for_chord(false, false, false, 'q'), None);
        // Ctrl+Alt is AltGr on many layouts: a character, not a menu.
        assert_eq!(menu_action_for_chord(true, false, true, 'q'), None);
        assert_eq!(menu_action_for_chord(true, false, true, '0'), None);
    }

    #[test]
    fn chords_we_do_not_own_pass_through() {
        for key in ['w', 'r', 'k', '1', 'f', 'c'] {
            assert_eq!(menu_action_for_chord(true, false, false, key), None, "{key}");
        }
    }

    #[test]
    fn the_keypad_answers_by_virtual_key_even_without_a_layout_char() {
        assert_eq!(menu_chord_key(VK_NUMPAD0, None), Some('0'));
        assert_eq!(menu_chord_key(VK_ADD, None), Some('+'));
        assert_eq!(menu_chord_key(VK_SUBTRACT, None), Some('-'));
    }

    #[test]
    fn a_normal_key_answers_by_layout_lowercased() {
        assert_eq!(menu_chord_key(0x51, Some('Q')), Some('q'));
        assert_eq!(menu_chord_key(0xBB, Some('=')), Some('='));
        assert_eq!(menu_chord_key(0xBD, Some('-')), Some('-'));
        // No character on this layout: nothing to decide on.
        assert_eq!(menu_chord_key(0x51, None), None);
    }
}
