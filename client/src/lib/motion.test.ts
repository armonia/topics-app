/**
 * LE DUE COPIE DELLA STESSA TABELLA, e il test che le tiene uguali.
 *
 * Le durate e le curve vivono in TypeScript (`motion.ts`) perche' le animazioni
 * scritte in JavaScript le importano, e come custom property in `index.css`
 * perche' un keyframe non puo' importare un modulo. Due copie sono un debito:
 * si cambia un numero di qua, si dimentica di la', e da quel momento la stessa
 * cosa si muove a due velocita' a seconda di chi la anima.
 *
 * Il debito lo paga questo file: legge il CSS come TESTO e lo confronta con le
 * costanti. Non c'e' un modo piu' furbo (non c'e' un DOM in `bun test`, e non
 * serve: qui si controlla il SORGENTE, che e' quello che si sbaglia a mano).
  * @covers MOTION-01
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { MOTION, EASE, animateEl } from './motion';
import { resetReducedMotionCache } from './reducedMotion';

const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');

function tokenCss(nome: string): string | null {
  const m = new RegExp(`--${nome}:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : null;
}

describe('i token del movimento', () => {
  test('ogni durata di motion.ts esiste in index.css con lo stesso numero', () => {
    for (const [nome, ms] of Object.entries(MOTION)) {
      expect(tokenCss(`motion-${nome}`)).toBe(`${ms}ms`);
    }
  });

  test('ogni curva di motion.ts esiste in index.css con la stessa cubic-bezier', () => {
    for (const [nome, curva] of Object.entries(EASE)) {
      expect(tokenCss(`ease-${nome}`)).toBe(curva);
    }
  });

  // The two tests above read the FIRST declaration only. A later `:root` that
  // redeclares a token wins the cascade by source order while they stay green:
  // measured 2026-09-29, `--ease-standard` resolved at runtime to the Material
  // curve of a second block 2,800 lines further down. So each token must be
  // declared exactly once in the whole stylesheet.
  test('every motion token is declared exactly once in index.css', () => {
    const names = [
      ...Object.keys(MOTION).map((k) => `motion-${k}`),
      ...Object.keys(EASE).map((k) => `ease-${k}`),
    ];
    for (const name of names) {
      const declarations = css.match(new RegExp(`--${name}\\s*:`, 'g')) ?? [];
      expect({ name, count: declarations.length }).toEqual({ name, count: 1 });
    }
  });

  test('le durate sono in scala: un riscontro, una comparsa, uno spostamento, un viaggio', () => {
    expect(MOTION.instant).toBeLessThan(MOTION.fast);
    expect(MOTION.fast).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.slow);
  });
});

// A Tailwind `duration-150` in a component is a copy of a motion number that
// no token governs: change `--motion-fast` and that element keeps its old
// speed. The duration utilities read the tokens instead (`duration-fast`,
// index.css `@theme inline`); this walks the client sources and names every
// numeric or arbitrary-value duration class left.
describe('component durations', () => {
  const SRC = join(import.meta.dir, '..');
  const HARD_CODED = /(?<![\w-])duration-(?:\d+|\[[^\]]*\])(?![\w-])/g;
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(path);
      return /\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name) ? [path] : [];
    });
  }

  test('no component carries a hard-coded duration class: they use the motion tokens', () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(HARD_CODED)) found.push(`${relative(SRC, file)}:${i + 1} ${m[0]}`);
      });
    }
    expect(found).toEqual([]);
  });

  test('the four duration utilities are declared on the tokens', () => {
    for (const name of Object.keys(MOTION)) {
      expect(tokenCss(`transition-duration-${name}`)).toBe(`var(--motion-${name})`);
    }
  });
});

describe('animateEl', () => {
  test('senza Element.animate non anima e non esplode', () => {
    resetReducedMotionCache();
    const finto = {} as unknown as Element;
    expect(animateEl(finto, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fast })).toBeNull();
  });

  test('chi ha chiesto meno movimento non ne vede: l\'elemento non viene toccato', () => {
    resetReducedMotionCache();
    let chiamate = 0;
    const globale = globalThis as { window?: unknown };
    const prima = globale.window;
    globale.window = { matchMedia: () => ({ matches: true }) };
    try {
      const el = { animate: () => { chiamate += 1; return {}; } } as unknown as Element;
      expect(animateEl(el, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.fast })).toBeNull();
      expect(chiamate).toBe(0);
    } finally {
      if (prima === undefined) delete globale.window;
      else globale.window = prima;
      resetReducedMotionCache();
    }
  });
});
