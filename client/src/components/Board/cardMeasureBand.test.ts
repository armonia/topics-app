/**
 * @covers KANBAN-105
 * Contrast of the measure band (model, time, tokens, last update) against the card.
 *
 * The band is a translucent black (light) or white (dark) layer over the card
 * surface, and the text sits on top of it. The ratios are COMPUTED here from the
 * tokens in `index.css` and the classes written in `CardLive.tsx` and `Card.tsx`,
 * so a token change or a class change moves the number and the test says so.
 *
 * Two facts are checked, in both themes:
 * - the text on the band reaches WCAG AA (4.5:1 for small text);
 * - the band is visibly apart from the card (a band that merges with the card
 *   reads as a stray line of text again).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', '..', 'index.css'), 'utf8');
const CARD = readFileSync(join(HERE, 'Card.tsx'), 'utf8');
const LIVE = readFileSync(join(HERE, 'CardLive.tsx'), 'utf8');

type RGB = { r: number; g: number; b: number };

/** The body of the first top-level block that starts with `selector`. */
function block(selector: RegExp): string {
  const i = CSS.search(selector);
  if (i < 0) throw new Error(`block ${selector} not found in index.css`);
  const open = CSS.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++;
    else if (CSS[j] === '}') { depth--; if (depth === 0) return CSS.slice(open, j); }
  }
  throw new Error(`block ${selector} not closed`);
}

/** A token's color in a block, as written: hex or `hsl(H S% L%)`. */
function color(css: string, name: string): RGB {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found`);
  const v = m[1].trim();
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const hsl = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (!hsl) throw new Error(`token --${name} has an unknown value: ${v}`);
  return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

/** A translucent layer of `base` (black or white) at `alpha`, over `under`. */
function over(base: 'black' | 'white', alpha: number, under: RGB): RGB {
  const c = base === 'black' ? 0 : 255;
  const mix = (u: number) => Math.round(c * alpha + u * (1 - alpha));
  return { r: mix(under.r), g: mix(under.g), b: mix(under.b) };
}

function luminance({ r, g, b }: RGB): number {
  const lin = (x: number) => {
    const v = x / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Each theme: the card surface, the band's layer, and a reader for any token of that theme. */
function theme(selector: RegExp, layerClass: RegExp) {
  const css = block(selector);
  const layer = LIVE.match(layerClass);
  if (!layer) throw new Error(`the band has no translucent class for ${layerClass}`);
  // The static band in Card.tsx draws the same layer, so the number holds there too.
  expect(CARD).toContain(layer[0]);
  return {
    surface: color(css, 'bg-surface'),
    token: (name: string) => color(css, name),
    layer: { base: layer[1] as 'black' | 'white', alpha: Number(layer[2]) },
  };
}

const THEMES = {
  light: theme(/^:root\s*\{/m, /(?<!dark:)bg-(black|white)\/\[(0?\.\d+)\]/),
  dark: theme(/^\.dark\s*\{/m, /dark:bg-(black|white)\/\[(0?\.\d+)\]/),
};

/** The band text color: the `text-app-text-*` class in the band's own className. */
function bandText(): string {
  const text = LIVE.match(/rounded-lg bg-black\/\[0\.12\] [^"`]*?text-app-text-(\w[\w-]*)/);
  if (!text) throw new Error('the band text color is not read from CardLive.tsx');
  return text[1];
}

describe('the measure band', () => {
  const text = bandText();

  for (const [name, t] of Object.entries(THEMES)) {
    const band = over(t.layer.base, t.layer.alpha, t.surface);

    it(`${name}: the band text reaches WCAG AA (4.5:1) on the band`, () => {
      expect(ratio(t.token(`text-${text}`), band)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: the band is visibly apart from the card (at least 1.2:1)`, () => {
      expect(ratio(band, t.surface)).toBeGreaterThanOrEqual(1.2);
    });
  }

  it('the band text is the secondary token: the muted one falls under 4.5 on the band', () => {
    expect(text).toBe('secondary');
    const light = THEMES.light;
    const onMuted = over(light.layer.base, light.layer.alpha, light.surface);
    expect(ratio(light.token('text-muted'), onMuted)).toBeLessThan(4.5);
  });
});
