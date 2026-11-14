/**
 * The status table: four states, one token per surface, every token over its
 * WCAG threshold on the real app grounds, and the numbers in the module's
 * docblock recomputed here from the Tailwind theme instead of trusted.
 *
 * The contrast is computed, not copied: the oklch of each Tailwind step is
 * read from `tailwindcss/theme.css`, converted to sRGB, and measured against
 * the surfaces of `index.css`. A docblock number that drifts from the
 * computation fails, and so does a token moved under its threshold.
 *
 * @covers STATUS-VISUAL-01, STATUS-VISUAL-01a, STATUS-VISUAL-01b, STATUS-VISUAL-01c, STATUS-VISUAL-01d
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CircleAlert } from 'lucide-react';
import { STATUS_CHIP, STATUS_DOT, STATUS_ICON, STATUS_INK, type StatusTone } from './statusVisual';
import { DANGER_TEXT, WARNING_TEXT } from './popoverStyles';
import { PALLINO_ATTESA, PALLINO_OK, SEGNALE_ATTESA, SEGNALE_GUASTO, SEGNALE_OK } from '../components/Sidebar/chromeSignals';

const TONES: readonly StatusTone[] = ['wait', 'working', 'danger', 'ok'];
const FAMILY: Record<StatusTone, string> = { wait: 'amber', working: 'sky', danger: 'red', ok: 'emerald' };

// A typo'd key must not compile: the `satisfies` keeps the literal keys.
// @ts-expect-error `waitt` is not a status
void STATUS_ICON.waitt;

const THEME = readFileSync(join(import.meta.dir, '../../node_modules/tailwindcss/theme.css'), 'utf8');
const INDEX_CSS = readFileSync(join(import.meta.dir, '../index.css'), 'utf8');
const MODULE_SRC = readFileSync(join(import.meta.dir, 'statusVisual.ts'), 'utf8');

type Rgb = readonly [number, number, number];

function tailwind(step: string): Rgb {
  const m = THEME.match(new RegExp(`--color-${step}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  if (!m) throw new Error(`no ${step} in the Tailwind theme`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const [r, g, bl] = linear.map((c) => {
    const v = Math.min(1, Math.max(0, c));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  });
  return [r!, g!, bl!];
}

function hsl(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => 255 * (lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function veil(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The surfaces the tokens sit on, as `index.css` declares them (light, dark). */
const SURFACES = {
  chrome: { light: [220, 5.6, 93], dark: [224, 26, 4.5], decl: ['--chrome-bg: hsl(220 5.6% 93%)', '--chrome-bg: hsl(224 26% 4.5%)'] },
  card: { light: [220, 4.9, 98.1], dark: [220, 4.5, 14], decl: ['--bg-elevated: hsl(220 4.9% 98.1%)', '--bg-elevated: hsl(220 4.5% 14%)'] },
} as const;
const ground = (s: keyof typeof SURFACES, theme: 'light' | 'dark'): Rgb => {
  const [h, sat, l] = SURFACES[s][theme];
  return hsl(h, sat, l);
};

/** `bg-amber-700 dark:bg-amber-400` -> { light: 'amber-700', dark: 'amber-400' } (the text step for a chip). */
function steps(cls: string, prefix: 'bg' | 'text'): { light: string; dark: string } {
  const light = cls.match(new RegExp(`(?:^|\\s)${prefix}-([a-z]+-\\d+)(?:\\s|$)`))?.[1];
  const dark = cls.match(new RegExp(`dark:${prefix}-([a-z]+-\\d+)`))?.[1];
  if (!light || !dark) throw new Error(`no ${prefix} pair in "${cls}"`);
  return { light, dark };
}

/** Every number the docblock prints, measured again. Row label -> numbers in print order. */
function measured(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const fmt = (n: number) => n.toFixed(2);
  for (const t of TONES) {
    const dot = steps(STATUS_DOT[t], 'bg');
    const ink = steps(STATUS_INK[t], 'text');
    const chip = steps(STATUS_CHIP[t], 'text');
    const both = (p: { light: string; dark: string }) => [
      fmt(contrast(tailwind(p.light), ground('chrome', 'light'))),
      fmt(contrast(tailwind(p.dark), ground('chrome', 'dark'))),
      fmt(contrast(tailwind(p.light), ground('card', 'light'))),
      fmt(contrast(tailwind(p.dark), ground('card', 'dark'))),
    ];
    const v500 = tailwind(`${FAMILY[t]}-500`);
    out.set(`DOT ${dot.light}/${dot.dark.split('-')[1]}`, both(dot));
    out.set(`INK ${ink.light}/${ink.dark.split('-')[1]}`, both(ink));
    out.set(`CHIP ${chip.light}/${chip.dark.split('-')[1]}`, [
      fmt(contrast(tailwind(chip.light), veil(v500, ground('card', 'light'), 0.15))),
      fmt(contrast(tailwind(chip.dark), veil(v500, ground('card', 'dark'), 0.15))),
    ]);
  }
  return out;
}

/** The rows of the docblock tables, keyed the same way as {@link measured}. */
function documented(): Map<string, string[]> {
  const doc = MODULE_SRC.slice(0, MODULE_SRC.indexOf('export type StatusTone'));
  const out = new Map<string, string[]>();
  let section = '';
  for (const raw of doc.split('\n')) {
    const line = raw.replace(/^\s*\*\s?/, '').trim();
    const head = line.match(/^(DOT|INK|CHIP)\b/);
    if (head) { section = head[1]!; continue; }
    const row = line.match(/^([a-z]+-\d+\/\d+)\s+(.*)$/);
    if (row && section) out.set(`${section} ${row[1]}`, row[2]!.match(/\d+\.\d+/g) ?? []);
  }
  return out;
}

describe('statusVisual', () => {
  test('STATUS-VISUAL-01a: four states, one token per surface, each in its own colour family', () => {
    for (const table of [STATUS_DOT, STATUS_INK, STATUS_CHIP, STATUS_ICON]) {
      expect(Object.keys(table).sort()).toEqual([...TONES].sort());
    }
    for (const t of TONES) {
      for (const cls of [STATUS_DOT[t], STATUS_INK[t], STATUS_CHIP[t]]) {
        // Every class of the token is the tone's own family: no rose, no stray 500.
        for (const c of cls.split(/\s+/)) expect(c, `${t}: ${cls}`).toContain(`-${FAMILY[t]}-`);
      }
      expect(STATUS_CHIP[t]).toContain(`bg-${FAMILY[t]}-500/15`);
    }
    // Rose is the Review column, never a state.
    expect(JSON.stringify([STATUS_DOT, STATUS_INK, STATUS_CHIP])).not.toMatch(/rose|pink/);
    // "Awaiting you" is a turn stopped on you, not time passing.
    expect(STATUS_ICON.wait).toBe(CircleAlert);
    expect(new Set(Object.values(STATUS_ICON)).size).toBe(TONES.length);
  });

  test('STATUS-VISUAL-01b: every token clears WCAG on the chrome and on the card, in both themes', () => {
    for (const [s, { decl }] of Object.entries(SURFACES)) {
      for (const d of decl) expect(INDEX_CSS, `${s} is no longer ${d}: re-measure`).toContain(d);
    }
    for (const t of TONES) {
      for (const theme of ['light', 'dark'] as const) {
        const dot = tailwind(steps(STATUS_DOT[t], 'bg')[theme]);
        const ink = tailwind(steps(STATUS_INK[t], 'text')[theme]);
        const chip = tailwind(steps(STATUS_CHIP[t], 'text')[theme]);
        for (const s of ['chrome', 'card'] as const) {
          expect(contrast(dot, ground(s, theme)), `dot ${t} ${s} ${theme}`).toBeGreaterThanOrEqual(3);
          expect(contrast(ink, ground(s, theme)), `ink ${t} ${s} ${theme}`).toBeGreaterThanOrEqual(4.5);
        }
        const onVeil = veil(tailwind(`${FAMILY[t]}-500`), ground('card', theme), 0.15);
        expect(contrast(chip, onVeil), `chip ${t} ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('STATUS-VISUAL-01c: the docblock prints the numbers the computation gives', () => {
    const want = measured();
    const have = documented();
    expect([...have.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [row, numbers] of want) expect(have.get(row), row).toEqual(numbers);
    // The anchor the review asked for: measured, not remembered.
    expect(want.get('INK amber-800/400')![1]).toBe('11.52');
    expect(want.get('INK red-700/400')![1]).toBe('6.84');
    expect(want.get('INK sky-800/400')![1]).toBe('9.06');
  });

  test('STATUS-VISUAL-01d: the chrome signals and the popover inks are the same tokens, not copies', () => {
    expect(SEGNALE_ATTESA).toBe(STATUS_INK.wait);
    expect(WARNING_TEXT).toBe(STATUS_INK.wait);
    expect(SEGNALE_GUASTO).toBe(STATUS_INK.danger);
    expect(DANGER_TEXT).toBe(STATUS_INK.danger);
    expect(SEGNALE_OK).toBe(STATUS_INK.ok);
    expect(PALLINO_OK).toBe(STATUS_DOT.ok);
    expect(PALLINO_ATTESA).toBe(STATUS_DOT.wait);
    // And they are aliases in the source, so the pair cannot be re-typed apart.
    for (const f of ['../components/Sidebar/chromeSignals.ts', 'popoverStyles.ts']) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8');
      expect(src, f).not.toMatch(/=\s*'text-(amber|red|emerald)-\d+ dark:text-/);
    }
  });
});
