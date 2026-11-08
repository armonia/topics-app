/**
 * The modifier key, SPELLED THE WAY THE SYSTEM IN FRONT OF YOU CALLS IT.
 *
 * The interface wrote `⌘K` everywhere. On Windows that symbol does not exist: the
 * shortcut works (the handlers have always accepted `ctrlKey` — verified live,
 * Ctrl+K opens the palette), but the label names a key that is not on the
 * keyboard. Reported 2026-08-26 while trying the installed build.
 *
 * It is not a small slip: key captions are how shortcuts are LEARNED, and they
 * are the first thing anyone sees on the welcome screen, before opening anything.
 *
 * This file carries the NAME only. The key bindings do not change and must not:
 * someone moving from a Mac to a PC keeps pressing what they press, because the
 * handlers look at `metaKey || ctrlKey` — twenty-two places already do.
 */

/**
 * True on Windows and Linux, i.e. where the modifier is Ctrl.
 *
 * True OUTSIDE Tauri as well: the same interface runs in a browser and as a PWA,
 * and whoever opens it from Edge on Windows has exactly the same problem. That is
 * why it does not reuse `isTauriWindows`, which is about the shell.
 *
 * Both routes are read because engines expose them differently:
 * `userAgentData.platform` is the modern one, `navigator.platform` the deprecated
 * but still present one, and relying on a single one means being wrong on half
 * the browsers. The Mac is the case to recognise POSITIVELY (its values are few
 * and stable: `macOS`, `MacIntel`); everything else uses Ctrl, iOS included when
 * a keyboard is attached.
 */
export const usesCtrl: boolean = (() => {
  if (typeof navigator === 'undefined') return false;
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    '';
  return !/mac|iphone|ipad|ipod/i.test(p);
})();

/** The primary modifier: `⌘` on a Mac, `Ctrl` elsewhere. */
export const MOD = usesCtrl ? 'Ctrl' : '\u2318';
/** Shift. `⇧` on a Mac, the word elsewhere: on Windows the glyph is not used. */
export const SHIFT = usesCtrl ? 'Shift' : '\u21e7';
/** Alt / Option. */
export const ALT = usesCtrl ? 'Alt' : '\u2325';
/** Return.
 *  @knipignore used via `await import()` in shortcutLabel.test.ts, which reloads
 *  the module with `navigator.platform` simulated and reads its members through a
 *  namespace (`m.ENTER`): the reference is not static and knip cannot see it. */
export const ENTER = usesCtrl ? 'Enter' : '\u21b5';

/**
 * The separator between the keys of a chord.
 *
 * On a Mac there is none: the glyphs sit together (`⌘⇧C`) because they are
 * symbols, and a space between them would read as two separate things. On Windows
 * the modifiers are WORDS, and `CtrlShiftC` is unreadable: the system convention
 * is the plus sign (`Ctrl+Shift+C`).
 */
const SEP = usesCtrl ? '+' : '';

/**
 * Spell ONE key token of the shortcut registry (`shared/shortcuts.ts`) the way
 * this system spells it.
 *
 * The registry writes modifiers as tokens (`Mod`, `Shift`, `Alt`, `Ctrl`),
 * never as glyphs, so the same row reads `⌘⇧T` on a Mac and
 * `Ctrl+Shift+T` on Windows. `Ctrl` is Control PROPER — on a Mac `⌃`, a
 * different key from `⌘`; on Windows and Linux it collapses onto the primary
 * modifier, because there it IS the same key. Anything that is not a modifier
 * (a letter, `Esc`, `1-9`) passes through untouched.
 */
export function keyLabel(token: string): string {
  switch (token) {
    case 'Mod': return MOD;
    case 'Shift': return SHIFT;
    case 'Alt': return ALT;
    case 'Ctrl': return usesCtrl ? 'Ctrl' : '\u2303';
    default: return token;
  }
}

/**
 * The whole chord as one caption, e.g. `⌘⇧T` or `Ctrl+Shift+T`.
 *
 * Used to compare two chords, which is not decoration: on Windows `⌃⇧Tab`
 * and `⌘⇧Tab` are the SAME caption, and a row that names one as the alias
 * of the other would read "Ctrl+Shift+Tab (alias Ctrl+Shift+Tab)".
 */
export function chordLabel(keys: readonly string[]): string {
  return keys.map(keyLabel).join(SEP);
}

/**
 * Compose a shortcut with the right names for this system.
 *
 *   shortcut('K')                  → `⌘K`   / `Ctrl+K`
 *   shortcut('C', { shift: true }) → `⌘⇧C`  / `Ctrl+Shift+C`
 *
 * The final key is passed already spelled the way it should read (`K`, `↵`, `,`):
 * this function decides the MODIFIERS, not the letter.
 */
export function shortcut(
  key: string,
  opts: { shift?: boolean; alt?: boolean; mod?: boolean } = {},
): string {
  const { shift = false, alt = false, mod = true } = opts;
  const parts: string[] = [];
  if (mod) parts.push(MOD);
  // The order is the canonical one on both systems (mod, alt, shift): not a
  // preference, it is how the respective manuals write them.
  if (alt) parts.push(ALT);
  if (shift) parts.push(SHIFT);
  parts.push(key);
  return parts.join(SEP);
}
