/**
 * F20 - THE FROST IS A TEXTURE WITH RULES, and two of them are not aesthetic.
 *
 * The first: it grows from the edges inward and stops at its reach, so the
 * middle of a card is never covered however long the freeze lasts.
 *
 * The second, and the one this file exists for: NO crystal, at any progress,
 * melting included, over the text. Computed on the real tokens, the dark theme
 * allows a crystal alpha of at most 0.066 under `--text-muted` before contrast
 * falls under 4.5:1 - which is invisible. The texture therefore stays strong and
 * the words stay clear, and this test is what stops somebody "simplifying" the
 * keep-out into a global alpha.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from 'bun:test';
import { iceFields, keepOutMask, paintIce, glintPoints, type IceTheme } from './swapIceTexture';

const THEME: IceTheme = { crystal: [226, 240, 255], wash: [140, 180, 225], edge: [170, 210, 245] };

/** A board card at its real size, at 1x so pixels and CSS px coincide. */
const card = (seed = 'tree-1') => iceFields({ w: 320, h: 140, scale: 1, seed, reach: 58, depth: 3 });

function image(f: { width: number; height: number }): ImageData {
  return { data: new Uint8ClampedArray(f.width * f.height * 4), width: f.width, height: f.height, colorSpace: 'srgb' } as ImageData;
}

const alphaAt = (img: ImageData, f: { width: number }, x: number, y: number): number => img.data[(y * f.width + x) * 4 + 3]!;

function frostedPixels(img: ImageData): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
  return n;
}

describe('the same freeze frosts the same way everywhere', () => {
  test('one seed, one texture: byte for byte', () => {
    const a = card('tree-42');
    const b = card('tree-42');
    expect(Array.from(a.front.slice(0, 500))).toEqual(Array.from(b.front.slice(0, 500)));
    expect(Array.from(a.crystal.slice(0, 500))).toEqual(Array.from(b.crystal.slice(0, 500)));
    const other = card('tree-43');
    expect(Array.from(other.crystal)).not.toEqual(Array.from(a.crystal));
  });
});

describe('it grows from the edges, and it stops', () => {
  const f = card();

  test('an edge pixel is frosted early, the centre never', () => {
    const img = image(f);
    paintIce(img, f, { progress: 0.3, melting: false, theme: THEME });
    // A band along the top edge: at a third of the way in, some of it is frost.
    let edge = 0;
    for (let x = 0; x < f.width; x++) for (let y = 0; y < 4; y++) if (alphaAt(img, f, x, y) > 0) edge++;
    expect(edge).toBeGreaterThan(0);
    expect(alphaAt(img, f, Math.floor(f.width / 2), Math.floor(f.height / 2))).toBe(0);
  });

  test('the centre stays clear even fully grown', () => {
    const img = image(f);
    paintIce(img, f, { progress: 1, melting: false, theme: THEME });
    expect(alphaAt(img, f, Math.floor(f.width / 2), Math.floor(f.height / 2))).toBe(0);
  });

  test('the frosted area only grows with progress', () => {
    let previous = -1;
    for (const progress of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const img = image(f);
      paintIce(img, f, { progress, melting: false, theme: THEME });
      const n = frostedPixels(img);
      expect(n, `progress ${progress}`).toBeGreaterThanOrEqual(previous);
      previous = n;
    }
    expect(previous).toBeGreaterThan(0);
  });

  test('melting brightens the rim and leaves the rest as it was', () => {
    const still = image(f);
    const melting = image(f);
    paintIce(still, f, { progress: 0.6, melting: false, theme: THEME });
    paintIce(melting, f, { progress: 0.6, melting: true, theme: THEME });
    let wetter = 0;
    let changedDeepInside = 0;
    for (let i = 0; i < f.front.length; i++) {
      const a = still.data[i * 4 + 3]!;
      const b = melting.data[i * 4 + 3]!;
      const rim = 0.6 - f.front[i]! < 0.03;
      if (b > a) wetter++;
      if (!rim && b !== a) changedDeepInside++;
    }
    expect(wetter, 'the wet rim of a thaw').toBeGreaterThan(0);
    expect(changedDeepInside, 'only the front melts').toBe(0);
  });
});

describe('frost never forms over the words', () => {
  const f = card();
  // The label pill and a title line, as `Range.getClientRects` would give them.
  const rects = [{ x: 8, y: 8, w: 180, h: 16 }, { x: 8, y: 116, w: 120, h: 14 }];
  const keepOut = keepOutMask({ w: 320, h: 140, scale: 1, rects });

  test('every pixel of every text box reads alpha 0, at every progress, melting included', () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      for (const melting of [false, true]) {
        const img = image(f);
        paintIce(img, f, { progress, melting, theme: THEME, keepOut });
        for (const r of rects) {
          for (let y = r.y; y < r.y + r.h; y++) {
            for (let x = r.x; x < r.x + r.w; x++) {
              expect(alphaAt(img, f, x, y), `progress ${progress}, melting ${melting}, pixel ${x},${y}`).toBe(0);
            }
          }
        }
      }
    }
  });

  test('the mask is 0 inside, ramps over the feather, and 1 away from the text', () => {
    const at = (x: number, y: number) => keepOut[y * 320 + x]!;
    expect(at(100, 15)).toBe(0);
    // Just outside the inflated box: something between 0 and 1.
    const ramp = at(100, 8 - 2 - 3);
    expect(ramp).toBeGreaterThan(0);
    expect(ramp).toBeLessThan(1);
    expect(at(300, 70)).toBe(1);
  });

  test('a glint never sits over the text', () => {
    for (const p of glintPoints(f, keepOut)) {
      for (const r of rects) {
        const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
        expect(inside).toBe(false);
      }
    }
  });
});

describe('the mini variant is rime along an edge, not a pattern nobody can see', () => {
  test('a 220x28 row frosts its edges and leaves its middle band clear', () => {
    const f = iceFields({ w: 220, h: 28, scale: 1, seed: 'row', reach: 8, depth: 1 });
    const img = image(f);
    paintIce(img, f, { progress: 1, melting: false, theme: THEME });
    expect(alphaAt(img, f, 110, 14)).toBe(0);
    let edge = 0;
    for (let x = 0; x < f.width; x++) if (alphaAt(img, f, x, 0) > 0) edge++;
    expect(edge).toBeGreaterThan(0);
  });
});
