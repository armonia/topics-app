/**
 * A one-shot entry animation must not leave anything invisible when it is paused.
 *
 * Measured 2026-09-12 in a browser pane driven by an agent, so `document.hasFocus()`
 * was false and `<html>` carried `anims-paused`: the KANBAN BOARD was a black
 * rectangle. It was mounted, it was 644x958, its columns were laid out and full of
 * cards — and `[data-testid="kanban-board"]` carries `.reveal-in`, whose `revealIn`
 * animation sat `paused` at `currentTime` 0. With `animation-fill-mode: both` that
 * pins frame 0, `opacity: 0`, and nothing moves the clock while the window is away.
 *
 * `index.css` already stated the rule in prose — "Add new one-shot entry classes
 * HERE when you create them" — and three classes had been created since without
 * being added. Prose does not fail a build. This does.
 *
 * WHY BY PARSING THE STYLESHEET. The real symptom is a painted pixel, which this
 * suite does not render. But "one-shot + first keyframe at opacity 0 + not switched
 * off under .anims-paused" is wrong in itself however it ends up painted, it is
 * checkable here for nothing, and it would have caught the black board before it
 * reached a screen. Animations that LOOP are deliberately left alone: a pause there
 * leaves nothing invisible, because they resume by themselves.
 *
 * @covers MOTION-03
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const css = readFileSync(join(import.meta.dir, 'index.css'), 'utf8');

/** Keyframe name → opacity declared on its FIRST frame, or null when it declares none. */
function firstFrameOpacity(): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{([\s\S]*?)\n\}/g)) {
    const blocks = [...m[2].matchAll(/(from|to|\d+%)\s*\{([^}]*)\}/g)];
    if (blocks.length === 0) continue;
    const opacity = blocks[0][2].match(/opacity:\s*([0-9.]+)/);
    out.set(m[1], opacity ? opacity[1] : null);
  }
  return out;
}

/** The classes switched OFF (not merely paused) under `.anims-paused`. */
function switchedOff(): Set<string> {
  const block = css.match(/((?:\.anims-paused\s+\.[A-Za-z0-9_-]+,\s*(?:\/\*[\s\S]*?\*\/\s*)?)+\.anims-paused\s+\.[A-Za-z0-9_-]+)\s*\{\s*animation:\s*none/);
  if (!block) throw new Error('index.css: the `.anims-paused … { animation: none }` block is gone');
  return new Set([...block[1].matchAll(/\.anims-paused\s+\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
}

/** Every class whose `animation:` shorthand names a keyframe, with whether it loops. */
function animatedClasses(): { cls: string; keyframes: string; loops: boolean }[] {
  return [...css.matchAll(/\.([A-Za-z0-9_-]+)\s*\{[^}]*?animation:\s*([A-Za-z0-9_-]+)([^;]*);/g)]
    .map((m) => ({ cls: m[1], keyframes: m[2], loops: m[3].includes('infinite') }));
}

describe('one-shot entry animations under .anims-paused', () => {
  it('every one-shot class starting at opacity 0 is switched off, not paused', () => {
    const opacityByName = firstFrameOpacity();
    const off = switchedOff();
    const uncovered = animatedClasses()
      .filter((a) => !a.loops && opacityByName.get(a.keyframes) === '0' && !off.has(a.cls))
      .map((a) => `.${a.cls} (@keyframes ${a.keyframes})`);
    // The cure is NOT to widen this test: it is to add the class to the
    // `.anims-paused … { animation: none }` list in index.css, where the comment
    // above it explains what a paused entry costs.
    expect([...new Set(uncovered)]).toEqual([]);
  });

  it('the board entry that was found black is in the list', () => {
    // The regression itself, named: if `.reveal-in` ever leaves that block, the
    // kanban board goes back to being a black rectangle for anyone not focused.
    expect(switchedOff().has('reveal-in')).toBe(true);
    expect(firstFrameOpacity().get('revealIn')).toBe('0');
  });

  it('animations that LOOP are deliberately left paused', () => {
    const opacityByName = firstFrameOpacity();
    const off = switchedOff();
    const loopingAndOff = animatedClasses()
      .filter((a) => a.loops && opacityByName.get(a.keyframes) === '0' && off.has(a.cls))
      .map((a) => a.cls);
    // Pausing them is the whole point of `.anims-paused`: they resume on focus and
    // leave nothing invisible behind. Switching one off would spend the compositor
    // saving this rule exists to make.
    expect(loopingAndOff).toEqual([]);
  });
});
