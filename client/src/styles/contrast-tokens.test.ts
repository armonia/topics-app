/**
 * Contrast of the text tokens: the threshold is COMPUTED, not eyeballed.
 *
 * These checks come from an axe-core pass inside Topics installed on Windows 11
 * on 2026-08-26, which found six elements under the threshold. They were not edge
 * cases: "No active items", "Persone", the version number at the bottom of the
 * column and the key captions (`⌘K`, `⌘B`) — all small type, 11-12px, i.e.
 * exactly the ones contrast matters most for.
 *
 * `--text-muted` gave 4.42 against the chrome background and `--kbd-text` 4.44
 * against the key background: under the 4.5 normal text requires, and by a margin
 * the eye cannot see. It is precisely the kind of gap a visual review never finds
 * and a calculation always does.
 *
 * The test reads the tokens from `index.css` and redoes the maths. It does not
 * render the app: a contrast ratio is a function of two colours, and those two
 * colours are declared there.
  *
 * @covers CONTRAST-01
*/
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');

/** The `:root` block (light theme), which is where the defects were. */
function rootBlock(): string {
  const i = CSS.indexOf(':root');
  const open = CSS.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++;
    else if (CSS[j] === '}') { depth--; if (depth === 0) return CSS.slice(open, j); }
  }
  return '';
}
const ROOT = rootBlock();

function token(name: string): string {
  const m = ROOT.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found in :root`);
  return m[1].trim();
}

/** `hsl(H S% L%)` o `#rrggbb` → canali 0-255. */
function toRgb(v: string): [number, number, number] {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hsl = v.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (!hsl) throw new Error(`unrecognised colour: ${v}`);
  const h = Number(hsl[1]) / 360, s = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100;
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** WCAG 2.1, the exact definition: no approximation. */
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const lum = ([r, g, b2]: [number, number, number]) => {
    const f = (c: number) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The backgrounds this text actually lands on, in the light theme. */
const BACKGROUNDS: Array<[string, string]> = [
  ['chrome', 'chrome-bg'],
  ['page', 'bg'],
  ['surface', 'bg-surface'],
];

describe('small-text tokens hold 4.5:1 on every light-theme background', () => {
  // 4.5 is the NORMAL text threshold (under 18px, or 14px bold). Every token below
  // is used at 11-12px: the 3:1 for large text does not apply to them.
  for (const name of ['text-muted', 'kbd-text', 'text-secondary']) {
    for (const [label, bg] of BACKGROUNDS) {
      it(`--${name} on --${bg} (${label})`, () => {
        const r = ratio(toRgb(token(name)), toRgb(token(bg)));
        // The message carries the number: a test that only says "false" forces you
        // to redo by hand the very calculation it just did.
        if (r < 4.5) {
          throw new Error(
            `--${name} (${token(name)}) on --${bg} (${token(bg)}) gives ${r.toFixed(2)}:1, needs 4.5:1`,
          );
        }
        expect(r).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/**
 * THE SAME CALCULATION ON THE FOUR STATES THE APP ACTUALLY HAS.
 *
 * The block above reads `:root` only, i.e. the light theme on a wide window.
 * That is how the defect this suite exists for came back on two more tokens:
 * `--text-placeholder` and `--text-faint` were retuned under 768px (with the
 * measurement written in the comment) and left alone on the desktop, which is
 * where nearly all the use is. The mobile value was the good one and the
 * desktop one the worst of the palette.
 *
 * So the resolver below rebuilds the token cascade for light and dark, wide and
 * narrow, and asks each token for 4.5 against the surfaces it really lands on.
 * A placeholder lives inside an input or on a popover, never on the chrome; the
 * faint text lives on panels, cards and the chrome, never inside an input.
 * Checking every token against every background would fail on pairs that never
 * touch, and a gate that is red for a pair nobody renders gets muted.
 */

/** Every block whose selector is EXACTLY this one, in file order. */
function blocksFor(selector: string): string[] {
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
        if (depth === 0) { out.push(CSS.slice(open, j)); break; }
      }
    }
  }
  return out;
}

/** The cascade of selectors that is in force in each of the four states. */
const STATES: Array<{ name: string; selectors: string[] }> = [
  { name: 'light desktop', selectors: [':root'] },
  { name: 'dark desktop', selectors: [':root', '.dark'] },
  {
    name: 'light mobile',
    selectors: [':root', 'html:not(.native-frost)', 'html:not(.dark):not(.native-frost)'],
  },
  {
    name: 'dark mobile',
    selectors: [':root', '.dark', 'html:not(.native-frost)', 'html.dark:not(.native-frost)'],
  },
];

/** Resolves a token in one state, following `var(--other)` to the end. */
function resolve(name: string, selectors: string[]): [number, number, number] {
  const declared = (want: string): string | null => {
    let found: string | null = null;
    for (const selector of selectors) {
      for (const block of blocksFor(selector)) {
        const m = block.match(new RegExp(`--${want}:\\s*([^;]+);`));
        if (m) found = m[1].trim();
      }
    }
    return found;
  };
  let value = declared(name);
  for (let hop = 0; value !== null && hop < 5; hop++) {
    const alias = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
    if (!alias) return toRgb(value);
    value = declared(alias[1]);
  }
  throw new Error(`token --${name} unresolved for [${selectors.join(', ')}]`);
}

/** The surfaces each token is painted on, and nothing else. */
const SURFACES: Record<string, string[]> = {
  // Composer, command palette, topic settings, new topic: an input or a popover.
  'text-placeholder': ['bg-input', 'bg-inset', 'bg-surface', 'popover-bg'],
  // Capacity reason, spend cap explanation, empty states, commit author on a card.
  'text-faint': ['bg-inset', 'bg-surface', 'bg', 'chrome-bg', 'bg-elevated'],
};

describe('the text tokens hold 4.5:1 in all four states', () => {
  for (const { name, selectors } of STATES) {
    for (const [tokenName, surfaces] of Object.entries(SURFACES)) {
      for (const surface of surfaces) {
        it(`--${tokenName} on --${surface}, ${name}`, () => {
          const r = ratio(resolve(tokenName, selectors), resolve(surface, selectors));
          if (r < 4.5) {
            throw new Error(
              `${name}: --${tokenName} on --${surface} gives ${r.toFixed(2)}:1, needs 4.5:1`,
            );
          }
          expect(r).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
