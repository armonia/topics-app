/**
 * The shortcut caption must name a key that EXISTS on this keyboard.
 *
 * On Windows the interface wrote `⌘K`: the chord worked (the handlers accept
 * `metaKey || ctrlKey`, and Ctrl+K was verified opening the palette on the
 * installed build) but the caption pointed at a key that is not there. Reported
 * 2026-08-26.
 *
 * The captions are how shortcuts are LEARNED, and they are the first thing on the
 * welcome screen. A caption that names the wrong key does not slow you down: it
 * teaches you something false.
 */
import { describe, expect, it } from 'bun:test';

/** Re-import with `navigator.platform` simulated: the module reads it once. */
async function onPlatform<T>(platform: string, fn: (m: typeof import('./shortcutLabel')) => T): Promise<T> {
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent: platform },
    configurable: true,
    writable: true,
  });
  try {
    const mod = await import(`./shortcutLabel?p=${encodeURIComponent(platform)}-${Math.random()}`);
    return fn(mod);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true });
  }
}

describe('the modifier follows the system', () => {
  it('on a Mac it is the ⌘ glyph, with no separator', async () => {
    const out = await onPlatform('MacIntel', (m) => [m.MOD, m.shortcut('K'), m.shortcut('C', { shift: true })]);
    expect(out[0]).toBe('\u2318');
    expect(out[1]).toBe('\u2318K');
    // Glyphs sit together: a space would read them as two separate things.
    expect(out[2]).toBe('\u2318\u21e7C');
  });

  it('on Windows it is the word Ctrl, joined with +', async () => {
    const out = await onPlatform('Win32', (m) => [m.MOD, m.shortcut('K'), m.shortcut('C', { shift: true })]);
    expect(out[0]).toBe('Ctrl');
    expect(out[1]).toBe('Ctrl+K');
    // `CtrlShiftC` is unreadable: with words the system convention is the plus.
    expect(out[2]).toBe('Ctrl+Shift+C');
  });

  it('on Linux it behaves like Windows', async () => {
    expect(await onPlatform('Linux x86_64', (m) => m.shortcut('K'))).toBe('Ctrl+K');
  });

  it('no ⌘ glyph ever reaches a non-Mac caption', async () => {
    // The check that matters, and the one the defect would have failed: whatever
    // the chord, on Windows the output must not contain the Command glyph.
    const chords = await onPlatform('Win32', (m) => [
      m.shortcut('K'), m.shortcut('N'), m.shortcut('C', { shift: true }),
      m.shortcut('I', { alt: true }), m.MOD, m.SHIFT, m.ALT, m.ENTER,
    ]);
    for (const c of chords) {
      expect(c).not.toContain('\u2318');
      expect(c).not.toContain('\u21e7');
      expect(c).not.toContain('\u2325');
    }
  });

  it('iPad and iPhone stay on the Mac spelling', async () => {
    // They take a hardware keyboard, and that keyboard has a Command key.
    for (const p of ['iPhone', 'iPad']) {
      expect(await onPlatform(p, (m) => m.MOD)).toBe('\u2318');
    }
  });
});
