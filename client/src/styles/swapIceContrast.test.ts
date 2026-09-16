/**
 * F22 - WHY THE FROST GROWS AROUND THE WORDS, in numbers.
 *
 * The first design painted the crystals at 0.51-0.755 alpha straight over the
 * card. On the real tokens that is 2.93:1 under `--text` in the dark theme and
 * 1.57:1 under `--text-muted`: text the person cannot read, on the card that is
 * telling them something went wrong. The alternative - an alpha low enough to be
 * safe - is 0.066 under `--text-muted`, which is a texture nobody can see.
 *
 * So the texture is strong and it keeps out of the text boxes, and these are the
 * numbers that make that the only honest option. They are computed from
 * `index.css`, the way `contrast-tokens.test.ts` does: a contrast ratio is a
 * function of two colours, and those colours are declared there.
 *
 * @covers KANBAN-85
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');
type Rgb = [number, number, number];

/** Every declaration of a token, in file order, restricted to one selector. */
function declarations(selector: string, token: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\n}])\\s*${escaped}\\s*\\{`, 'g');
  const out: string[] = [];
  for (let m = re.exec(CSS); m !== null; m = re.exec(CSS)) {
    const open = CSS.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    for (let j = open; j < CSS.length; j++) {
      if (CSS[j] === '{') depth++;
      else if (CSS[j] === '}') {
        depth--;
        if (depth === 0) {
          const hit = CSS.slice(open, j).match(new RegExp(`--${token}:\\s*([^;]+);`));
          if (hit) out.push(hit[1]!.trim());
          break;
        }
      }
    }
  }
  return out;
}

/** A token in one theme: the last declaration of the cascade wins. */
function token(name: string, dark: boolean): string {
  const chain = dark ? [':root', '.dark'] : [':root'];
  let value: string | undefined;
  for (const selector of chain) value = declarations(selector, name).pop() ?? value;
  if (!value) throw new Error(`token --${name} is not declared for ${dark ? 'dark' : 'light'}`);
  const alias = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  return alias ? token(alias[1]!, dark) : value;
}

function toRgb(v: string): Rgb {
  const triplet = v.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
  if (triplet) return [+triplet[1]!, +triplet[2]!, +triplet[3]!];
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hsl = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (!hsl) throw new Error(`unrecognised colour: ${v}`);
  const h = Number(hsl[1]) / 360, sat = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100;
  const k = (n: number) => (n + h * 12) % 12;
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function ratio(a: Rgb, b: Rgb): number {
  const lum = ([r, g, bl]: Rgb): number => {
    const f = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour a crystal at this alpha leaves behind it. */
const over = (top: Rgb, bottom: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(top[i as 0]! * alpha + bottom[i as 0]! * (1 - alpha))) as Rgb;

/** lucide `Snowflake` at `text-sky-600` / `dark:text-sky-300`, Tailwind's own values. */
const SNOWFLAKE: Record<'light' | 'dark', string> = { light: '#0284c7', dark: '#7dd3fc' };

describe('the frozen label is readable in both themes', () => {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    it(`the pill's text on --bg-surface (${theme})`, () => {
      const r = ratio(toRgb(token('text', dark)), toRgb(token('bg-surface', dark)));
      expect(r, `${r.toFixed(2)}:1, needs 4.5:1`).toBeGreaterThanOrEqual(4.5);
    });

    it(`the snowflake on --bg-surface (${theme})`, () => {
      const r = ratio(toRgb(SNOWFLAKE[theme]), toRgb(token('bg-surface', dark)));
      expect(r, `${r.toFixed(2)}:1, a glyph needs 3:1`).toBeGreaterThanOrEqual(3);
    });

    it(`the frost's own border is visible against the surface (${theme})`, () => {
      const edge = over(toRgb(token('swap-ice-edge', dark)), toRgb(token('bg-surface', dark)), 0.6);
      const r = ratio(edge, toRgb(token('bg-surface', dark)));
      expect(r, `${r.toFixed(2)}:1`).toBeGreaterThan(1.2);
    });
  }
});

describe('the keep-out is not a preference: the arithmetic leaves no other option', () => {
  it('a crystal at the first design\'s 0.51 alpha puts the dark theme\'s own text under 4.5:1', () => {
    const behind = over(toRgb(token('swap-ice-crystal', true)), toRgb(token('bg-surface', true)), 0.51);
    const r = ratio(toRgb(token('text', true)), behind);
    expect(r, `${r.toFixed(2)}:1 - this is why frost never forms over the words`).toBeLessThan(4.5);
  });

  it('the alpha that WOULD be safe under --text-muted is invisible', () => {
    const crystal = toRgb(token('swap-ice-crystal', true));
    const surface = toRgb(token('bg-surface', true));
    const muted = toRgb(token('text-muted', true));
    let strongest = 0;
    for (let alpha = 0; alpha <= 1; alpha += 0.001) {
      if (ratio(muted, over(crystal, surface, alpha)) >= 4.5) strongest = alpha;
      else break;
    }
    expect(strongest, `the strongest readable crystal is ${strongest.toFixed(3)} alpha`).toBeLessThan(0.15);
  });

  it('with the keep-out in force the text sits on the bare surface, whatever the texture does', () => {
    // The mask is 0 inside every text box (`swapIceTexture.test.ts` measures the
    // pixels): the colour behind the words is the surface itself.
    for (const dark of [false, true]) {
      const r = ratio(toRgb(token('text', dark)), toRgb(token('bg-surface', dark)));
      expect(r).toBeGreaterThanOrEqual(4.5);
    }
  });
});
