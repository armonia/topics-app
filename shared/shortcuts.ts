/**
 * The ONE source of truth for keyboard shortcuts.
 *
 * Before this file the shortcuts lived in two unlinked places:
 *   1. `client/src/components/Shared/KeyboardShortcuts.tsx` — the list the user
 *      sees in the "Keyboard Shortcuts" window.
 *   2. `desktop-tauri/src-tauri/src/lib.rs` (`app_chord_dispatch_js`) — the
 *      allowlist of ⌘-chords the native shell forwards into the main webview
 *      when a focused child browser pane would otherwise swallow them.
 * They drifted silently: add a chord in the client only and it never reaches
 * the desktop (the native monitor eats it); add it in the native only and the
 * shortcuts window lies to the user.
 *
 * Now both sides derive from `SHORTCUT_GROUPS`:
 *   - the client imports it directly to render the window;
 *   - `scripts/gen-shortcuts.ts` calls {@link renderRustModule} to emit
 *     `desktop-tauri/src-tauri/src/shortcuts_generated.rs`, which
 *     `app_chord_dispatch_js` consults for the ⌘-chord branch.
 * `shared/shortcuts.test.ts` fails if the committed `.rs` diverges from this
 * registry — so the next drift is caught by CI, not by a user.
 */

/** How the native desktop shell must forward a ⌘-chord (macOS NSEvent monitor).
 *  Only `⌘` (without `⌃`) *character* chords live here — the Tab cycle and bare
 *  Escape key off `keyCode`, so they stay hand-written in `lib.rs`. */
export interface NativeForward {
  /** `charactersIgnoringModifiers` (lowercase) that trigger the forward.
   *  Usually one entry; `['/','?']` covers a chord reachable with Shift, and
   *  `['t','u']` covers a primary + alias that share one displayed row. */
  chars: string[];
  /** Forward only while Shift is held (⌘⇧T / ⌘⇧U). Omitted ⇒ Shift-agnostic. */
  requireShift?: boolean;
}

export interface Shortcut {
  /** Keys as TOKENS, not a splittable string (a `<kbd>` per token). */
  keys: string[];
  description: string;
  /** Exists only in the desktop shell (Tauri/Electron), not on web/PWA. */
  desktopOnly?: boolean;
  /** Present ⟺ the native shell must forward this chord past a focused browser
   *  pane. Absent ⟺ the page keeps the chord (⌘C/⌘V/⌘Z/⌘F/…) or it never
   *  reaches the native monitor (voice chords handled inside ChatInput). */
  native?: NativeForward;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Command palette', native: { chars: ['k'] } },
      // ⌘F resta display-only: una pane browser a fuoco se la tiene per la
      // find-in-page, e il gestore web esce senza preventDefault quando il
      // fuoco è in un campo di testo, nel terminale o in un editor.
      { keys: ['⌘', 'F'], description: 'Cerca nei progetti aperti' },
      // ⌘P e ⌘⇧P condividono il char "p": il renderer li separa sullo shiftKey,
      // come già fa per ⌘N/⌘⇧N.
      { keys: ['⌘', 'P'], description: 'Apri un file per nome', native: { chars: ['p'] } },
      { keys: ['⌘', '⇧', 'P'], description: 'Trova un progetto', native: { chars: ['p'] } },
      // ⌘T e ⌘⇧T condividono il char "t": la prima apre una chat, la seconda
      // riapre l'ultima tab chiusa (più sotto, in «Panels & tabs»). Il renderer
      // li separa sullo shiftKey, come già fa per ⌘N/⌘⇧N e ⌘P/⌘⇧P.
      { keys: ['⌘', 'T'], description: 'Nuova chat', native: { chars: ['t'] } },
      // ⌘N and ⌘⇧N share the char "n"; the renderer splits them on shiftKey.
      { keys: ['⌘', 'N'], description: 'New… (add menu)', native: { chars: ['n'] } },
      { keys: ['⌘', '⇧', 'N'], description: 'New chat (with template)', native: { chars: ['n'] } },
      { keys: ['⌘', 'B'], description: 'Toggle sidebar', native: { chars: ['b'] } },
      // ⌘Z/⌘⇧Z stay with the page (undo in a focused input/pane).
      { keys: ['⌘', 'Z'], description: 'Undo (layout, tabs)' },
      { keys: ['⌘', '⇧', 'Z'], description: 'Redo' },
      { keys: ['⌘', ','], description: 'Settings' },
      // Scritta `⌘/` e non `⌘?`: la scorciatoia risponde a tutte e due (vedi
      // `native.chars`, e l'handler in useKeyboardShortcuts), ma il `?` su una
      // tastiera italiana è Shift+' — un tasto che il promemoria non nominava,
      // e infatti: «vedo command punto interrogativo come shortcut, ma io non
      // ce l'ho da tastiera». `/` è la forma che si scrive uguale ovunque ed è
      // quella che scrivono anche gli altri.
      { keys: ['⌘', '/'], description: 'Keyboard shortcuts', native: { chars: ['/', '?'] } },
    ],
  },
  {
    title: 'Panels & tabs',
    shortcuts: [
      { keys: ['⌘', '1-9'], description: 'Switch panel', desktopOnly: true, native: { chars: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] } },
      { keys: ['⌘', 'W'], description: 'Close focused panel', desktopOnly: true, native: { chars: ['w'] } },
      { keys: ['⌘', '⇧', 'T'], description: 'Reopen closed tab (alias ⌘⇧U)', native: { chars: ['t', 'u'], requireShift: true } },
      // ⌃Tab / ⌃⇧Tab / ⌘⇧Tab key off keyCode 48 — forwarded by the hand-written
      // branch in lib.rs, not by the generated char table.
      { keys: ['⌃', 'Tab'], description: 'Next panel' },
      { keys: ['⌃', '⇧', 'Tab'], description: 'Previous panel (alias ⌘⇧Tab)' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['⇧', 'Enter'], description: 'New line' },
      { keys: ['/'], description: 'Slash commands' },
      { keys: ['@'], description: 'Mention file (in project)' },
      // ⌘U (attach) is NOT forwarded — only ⌘⇧U is (reopen-tab alias above).
      { keys: ['⌘', 'U'], description: 'Attach file' },
      // Bare Escape keys off keyCode 53 — hand-written branch in lib.rs.
      { keys: ['Esc'], description: 'Interrupt the running turn' },
    ],
  },
  {
    title: 'Voice',
    // Voice chords are handled inside ChatInput, never by the native monitor.
    shortcuts: [
      { keys: ['⌘', '⇧', 'R'], description: 'Record voice' },
      { keys: ['⌘', '⇧', 'C'], description: 'Voice call' },
      { keys: ['⌘', '⇧', 'D'], description: 'Dictation' },
      { keys: ['⌘', '⇧', 'S'], description: 'Auto TTS' },
    ],
  },
  {
    title: 'Board',
    shortcuts: [
      { keys: ['⌘', 'tap'], description: 'Right ⌘, tapped alone: focus the task composer' },
    ],
  },
  {
    title: 'Window',
    shortcuts: [
      { keys: ['⌘', 'R'], description: 'Reload', desktopOnly: true },
      { keys: ['⌘', '='], description: 'Zoom in', desktopOnly: true },
      { keys: ['⌘', '-'], description: 'Zoom out', desktopOnly: true },
      { keys: ['⌘', '0'], description: 'Actual size', desktopOnly: true },
      { keys: ['⌘', '⌥', 'T'], description: 'Always on top (works unfocused)', desktopOnly: true },
      { keys: ['⌘', 'Q'], description: 'Quit Topics', desktopOnly: true },
    ],
  },
];

/** The ⌘-char chords the native shell forwards, split by Shift requirement.
 *  Deduped + sorted for a stable generated file. `?` is not a valid Rust match
 *  ambiguity here — every char is a distinct single-char literal. */
function forwardedCmdChars(): { always: string[]; shiftOnly: string[] } {
  const always = new Set<string>();
  const shiftOnly = new Set<string>();
  for (const group of SHORTCUT_GROUPS) {
    for (const s of group.shortcuts) {
      if (!s.native) continue;
      for (const c of s.native.chars) {
        (s.native.requireShift ? shiftOnly : always).add(c);
      }
    }
  }
  // A char that is Shift-agnostic somewhere wins over a Shift-only mention.
  for (const c of always) shiftOnly.delete(c);
  const byCodepoint = (a: string, b: string) => a.localeCompare(b, 'en');
  return { always: [...always].sort(byCodepoint), shiftOnly: [...shiftOnly].sort(byCodepoint) };
}

/** Emit `shortcuts_generated.rs`. Called by `scripts/gen-shortcuts.ts` (writes
 *  the file) and by the test (compares against the committed file). Keep the
 *  output byte-for-byte deterministic. */
export function renderRustModule(): string {
  const { always, shiftOnly } = forwardedCmdChars();
  const rustList = (cs: string[]) => cs.map(c => `"${c}"`).join(' | ');
  const arms: string[] = [];
  if (always.length) arms.push(`        ${rustList(always)} => true,`);
  if (shiftOnly.length) arms.push(`        ${rustList(shiftOnly)} => shift,`);
  arms.push('        _ => false,');
  // Underscore the param if no arm reads it, so Rust doesn't warn.
  const shiftParam = shiftOnly.length ? 'shift' : '_shift';
  return `// @generated by scripts/gen-shortcuts.ts from shared/shortcuts.ts. DO NOT EDIT.
// Run \`bun run gen:shortcuts\` after changing the keyboard-shortcut registry;
// \`shared/shortcuts.test.ts\` fails in CI if this file drifts from the registry.

/// Is \`chars\` (the character the key prints without Shift, lowercase) a
/// forwarded app chord? The caller has already checked the app modifier (⌘ on
/// macOS, Ctrl on Windows). Mirrors the \`native\` entries of the shortcut
/// registry; the re-dispatched \`key\` is \`chars\` itself.
///
/// No \`cfg\`: the macOS monitor (\`lib.rs\`) and the Windows decision table
/// (\`chords.rs\`, compiled everywhere so \`cargo test --lib\` can prove it off
/// Windows) both read this one list.
pub fn is_forwarded_cmd_chord(${shiftParam}: bool, chars: &str) -> bool {
    match chars {
${arms.join('\n')}
    }
}
`;
}
