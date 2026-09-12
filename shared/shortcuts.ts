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
  /** A SECOND chord that does the same thing. It lives here and not inside the
   *  description because on Windows two chords can collapse onto one caption
   *  (`\u2303\u21e7Tab` and `\u2318\u21e7Tab` are both `Ctrl+Shift+Tab`), and a row
   *  that read "Ctrl+Shift+Tab (alias Ctrl+Shift+Tab)" would be nonsense. The
   *  renderer compares the two captions and shows the alias only when it says
   *  something. */
  alias?: string[];
  /** Exists only in the desktop shell (Tauri/Electron), not on web/PWA. */
  desktopOnly?: boolean;
  /** The MECHANISM exists only on macOS (the right-modifier tap is an NSEvent
   *  monitor). Listed elsewhere it would be a row that cannot work. */
  macOnly?: boolean;
  /** Present ⟺ the native shell must forward this chord past a focused browser
   *  pane. Absent ⟺ the page keeps the chord (⌘C/⌘V/⌘Z/⌘F/…) or it never
   *  reaches the native monitor (voice chords handled inside ChatInput). */
  native?: NativeForward;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

/**
 * THE KEYS ARE WRITTEN AS TOKENS, NOT AS MAC GLYPHS.
 *
 * The registry used to spell the primary modifier `⌘`, and the shortcuts
 * window printed it verbatim on every system: on Windows the list named a key
 * that is not on the keyboard. That is how "there are no shortcuts here" gets
 * reported for chords that DO work — every handler reads `metaKey || ctrlKey`,
 * twenty-two places already do. Reported 2026-08-26 on the installed build.
 *
 * The tokens below are resolved to the local spelling at render time by
 * `client/src/lib/shortcutLabel.ts`. Nothing else changes: the bindings are the
 * same keys, and the Rust generator reads `native.chars`, never `keys`.
 */

/** The primary modifier: `⌘` on a Mac, `Ctrl` everywhere else. */
export const MOD = 'Mod';
/** Shift. */
export const SHIFT = 'Shift';
/** Alt / Option. */
export const ALT = 'Alt';
/** Control PROPER (`⌃` on a Mac), which on a Mac is NOT the primary
 *  modifier. On Windows and Linux it renders the same as {@link MOD}, because
 *  there it IS the same key. */
export const CTRL = 'Ctrl';

/** The tokens above, for the renderer that maps them to the local spelling. */
export const MODIFIER_TOKENS = [MOD, SHIFT, ALT, CTRL] as const;

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: [MOD, 'K'], description: 'Command palette', native: { chars: ['k'] } },
      // ⌘F resta display-only: una pane browser a fuoco se la tiene per la
      // find-in-page, e il gestore web esce senza preventDefault quando il
      // fuoco è in un campo di testo, nel terminale o in un editor.
      { keys: [MOD, 'F'], description: 'Cerca nei progetti aperti' },
      // ⌘P e ⌘⇧P condividono il char "p": il renderer li separa sullo shiftKey,
      // come già fa per ⌘N/⌘⇧N.
      { keys: [MOD, 'P'], description: 'Apri un file per nome', native: { chars: ['p'] } },
      { keys: [MOD, SHIFT, 'P'], description: 'Trova un progetto', native: { chars: ['p'] } },
      // ⌘T e ⌘⇧T condividono il char "t": la prima apre una chat, la seconda
      // riapre l'ultima tab chiusa (più sotto, in «Panels & tabs»). Il renderer
      // li separa sullo shiftKey, come già fa per ⌘N/⌘⇧N e ⌘P/⌘⇧P.
      { keys: [MOD, 'T'], description: 'Nuova chat', native: { chars: ['t'] } },
      // ⌘N and ⌘⇧N share the char "n"; the renderer splits them on shiftKey.
      { keys: [MOD, 'N'], description: 'New… (add menu)', native: { chars: ['n'] } },
      { keys: [MOD, SHIFT, 'N'], description: 'New chat (with template)', native: { chars: ['n'] } },
      { keys: [MOD, 'B'], description: 'Toggle sidebar', native: { chars: ['b'] } },
      // ⌘Z/⌘⇧Z stay with the page (undo in a focused input/pane).
      { keys: [MOD, 'Z'], description: 'Undo (layout, tabs)' },
      { keys: [MOD, SHIFT, 'Z'], description: 'Redo' },
      { keys: [MOD, ','], description: 'Settings' },
      // Scritta `⌘/` e non `⌘?`: la scorciatoia risponde a tutte e due (vedi
      // `native.chars`, e l'handler in useKeyboardShortcuts), ma il `?` su una
      // tastiera italiana è Shift+' — un tasto che il promemoria non nominava,
      // e infatti: «vedo command punto interrogativo come shortcut, ma io non
      // ce l'ho da tastiera». `/` è la forma che si scrive uguale ovunque ed è
      // quella che scrivono anche gli altri.
      { keys: [MOD, '/'], description: 'Keyboard shortcuts', native: { chars: ['/', '?'] } },
    ],
  },
  {
    title: 'Panels & tabs',
    shortcuts: [
      { keys: [MOD, '1-9'], description: 'Switch panel', desktopOnly: true, native: { chars: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] } },
      { keys: [MOD, 'W'], description: 'Close focused panel', desktopOnly: true, native: { chars: ['w'] } },
      // ⌘E and ⌥⌘E share the char "e"; the renderer splits them on altKey, the
      // way ⌘N/⌘⇧N and ⌘P/⌘⇧P split on shiftKey. The `native` field is NOT
      // optional here, and it is the line to get right: `forwardedCmdChars()`
      // skips every shortcut without it, so without the field 'e' never enters
      // the generated table, the NSEvent monitor does not forward the chord, and
      // ⌘E dies in exactly "chat plus the browser the agent opened" - the layout
      // this command exists for (LAYOUT-41). No gate would notice: `gen:shortcuts`
      // and this file's test compare the committed .rs against the generator's
      // output, and a registry that never names 'e' matches a .rs that never
      // names it either. They prove COHERENCE, never coverage.
      // The list is ONE for both native sides, so Windows changes just as much:
      // from here on Ctrl+E with a page focused is forwarded and swallowed
      // instead of reaching that page. That is the wanted behaviour - there
      // Ctrl+E zooms just like ⌘E here - and `chords.rs` ASSERTS it in
      // `app_chords_from_the_registry_are_forwarded`.
      // ⌥ asks for no field of its own: 'e' is forwarded identically with and
      // without it, the way 'w' is Shift-agnostic. What tells the two scopes
      // apart is the renderer, on `e.altKey`; getting the real Option bit that
      // far is the native monitor's job (lib.rs), not the registry's.
      { keys: [MOD, 'E'], description: 'Enlarge the conversation', native: { chars: ['e'] } },
      { keys: [ALT, MOD, 'E'], description: 'Enlarge this cell only', native: { chars: ['e'] } },
      { keys: [MOD, SHIFT, 'T'], alias: [MOD, SHIFT, 'U'], description: 'Reopen closed tab', native: { chars: ['t', 'u'], requireShift: true } },
      // ⌃Tab / ⌃⇧Tab / ⌘⇧Tab key off keyCode 48 — forwarded by the hand-written
      // branch in lib.rs, not by the generated char table.
      { keys: [CTRL, 'Tab'], description: 'Next panel' },
      { keys: [CTRL, SHIFT, 'Tab'], alias: [MOD, SHIFT, 'Tab'], description: 'Previous panel' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: [SHIFT, 'Enter'], description: 'New line' },
      { keys: ['/'], description: 'Slash commands' },
      { keys: ['@'], description: 'Mention file (in project)' },
      // ⌘U (attach) is NOT forwarded — only ⌘⇧U is (reopen-tab alias above).
      { keys: [MOD, 'U'], description: 'Attach file' },
      // Bare Escape keys off keyCode 53 — hand-written branch in lib.rs.
      { keys: ['Esc'], description: 'Interrupt the running turn' },
    ],
  },
  {
    title: 'Voice',
    // Voice chords are handled inside ChatInput, never by the native monitor.
    shortcuts: [
      { keys: [MOD, SHIFT, 'R'], description: 'Record voice' },
      { keys: [MOD, SHIFT, 'C'], description: 'Voice call' },
      { keys: [MOD, SHIFT, 'D'], description: 'Dictation' },
      { keys: [MOD, SHIFT, 'S'], description: 'Auto TTS' },
    ],
  },
  {
    title: 'Board',
    shortcuts: [
      { keys: [MOD, 'tap'], description: 'Right modifier, tapped alone: focus the task composer', macOnly: true },
    ],
  },
  {
    title: 'Window',
    shortcuts: [
      { keys: [MOD, 'R'], description: 'Reload', desktopOnly: true },
      { keys: [MOD, '='], description: 'Zoom in', desktopOnly: true },
      { keys: [MOD, '-'], description: 'Zoom out', desktopOnly: true },
      { keys: [MOD, '0'], description: 'Actual size', desktopOnly: true },
      { keys: [MOD, ALT, 'T'], description: 'Always on top (works unfocused)', desktopOnly: true },
      { keys: [MOD, 'Q'], description: 'Quit Topics', desktopOnly: true },
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
