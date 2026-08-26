/**
 * Contrasto dei token di testo: la soglia si CALCOLA, non si guarda.
 *
 * Questi controlli nascono da una passata di axe-core dentro Topics installato su
 * Windows 11 il 2026-08-26, che ha trovato sei elementi sotto la soglia. Non
 * erano casi limite: «No active items», «Persone», il numero di versione in fondo
 * alla colonna e le scritte dei tasti (`⌘K`, `⌘B`) — tutte scritte piccole,
 * 11-12px, cioè proprio quelle per cui il contrasto conta di più.
 *
 * `--text-muted` dava 4,42 contro il fondo del chrome e `--kbd-text` 4,44 contro
 * il fondo dei tasti: sotto il 4,5 richiesto dal testo normale, e per una
 * differenza che a occhio non si vede. È esattamente il tipo di scarto che una
 * revisione a vista non trova e un calcolo trova sempre.
 *
 * Il test legge i token da `index.css` e rifà il conto. Non rende l'app: il
 * rapporto di contrasto è una funzione di due colori, e quei due colori sono
 * dichiarati lì.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');

/** Il blocco `:root` (tema chiaro), che è quello dove i difetti stavano. */
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

/** WCAG 2.1, la definizione esatta: nessuna approssimazione. */
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
