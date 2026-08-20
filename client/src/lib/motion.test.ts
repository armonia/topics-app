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
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  test('le durate sono in scala: un riscontro, una comparsa, uno spostamento, un viaggio', () => {
    expect(MOTION.instant).toBeLessThan(MOTION.fast);
    expect(MOTION.fast).toBeLessThan(MOTION.base);
    expect(MOTION.base).toBeLessThan(MOTION.slow);
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
