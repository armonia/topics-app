/**
 * @covers LAYOUT-22
 */
import { describe, expect, test } from 'bun:test';
import {
  SEZIONI,
  capSezione,
  clampSidebarWidth,
  projectSidebarWidthKey,
  readProjectSidebarWidth,
  DEFAULT_SIDEBAR_W,
  MAX_SIDEBAR_W,
  MIN_SIDEBAR_W,
} from './projectSidebarHeights';

/**
 * IL TETTO SI RICALCOLA, non si ricopia.
 *
 * `capSezione` produce una stringa CSS, e una stringa non diventa rossa da sola:
 * il rischio è che qualcuno aggiunga una quarta sezione alla colonna e lasci il
 * tetto a un terzo, dando a tre sezioni piene il 100% e a Files zero. Qui si
 * rilegge il numero DALLA lista, che è l'unica sorgente.
 */
describe('il tetto di una sezione aperta', () => {
  test('è 1/N, con N il numero di sezioni', () => {
    expect(capSezione()).toBe(`calc(100% / ${SEZIONI.length})`);
  });

  test('scende da sé se le sezioni aumentano', () => {
    // La prova che il conto è DERIVATO e non scritto: con quattro sezioni il
    // tetto deve essere un quarto senza che nessuno tocchi la funzione.
    expect(capSezione(4)).toBe('calc(100% / 4)');
    expect(capSezione(4)).not.toBe(capSezione(3));
  });

  test('le sezioni sono quelle che la colonna monta davvero', () => {
    // Se una sparisce o se ne aggiunge una, il tetto cambia: questo test è ciò
    // che rende la modifica una DECISIONE invece di un effetto collaterale.
    expect([...SEZIONI]).toEqual(['files', 'git', 'processes']);
  });

  test('la percentuale ha bisogno di un contenitore con altezza definita', () => {
    // Non è verificabile da qui, ma è la premessa su cui poggia tutto: si
    // blocca almeno la FORMA (una percentuale, non un pixel), così un passaggio
    // a `calc(100vh / n)` — che ignorerebbe il contenitore — non passa in
    // silenzio.
    expect(capSezione()).toContain('100%');
    expect(capSezione()).not.toContain('vh');
  });
});

/**
 * THE PLACEHOLDER MUST RESERVE THE SAME COLUMN THE SIDEBAR WILL OPEN AT.
 *
 * `ProjectSidebar` is a lazy chunk (it and `FileExplorer` were 52 kB of the
 * eager entry, parsed on every boot with or without a project window). That
 * means a frame in which its `Suspense` fallback stands where the column will
 * be, and a fallback of the wrong width is a layout shift on exactly the
 * surface this work exists to keep still. So the width has to be readable from
 * out here, before the component exists — and it has to agree with the value
 * the component itself restores.
 */
describe('readProjectSidebarWidth', () => {
  const PROJECT = '/Users/someone/Projects/thing';

  /** Fake globals for `body`, then exactly what was there before: the old
   *  property, or no property at all. A DOM global left behind poisons every
   *  test file that runs after this one (`scripts/check-test-globals.ts`).
   *  Deciding with `'localStorage' in globalThis` left the fake behind when an
   *  earlier file had left the key set to `undefined`
   *  (`focusBrowserContext.live.test.ts`, 08/10/2026): `in` said it was there,
   *  nothing was removed, and the preload guard turned the whole shard red. */
  function withGlobals(fakes: Record<string, unknown>, body: () => void): void {
    const g = globalThis as Record<string, unknown>;
    const found = Object.keys(fakes).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
    Object.assign(g, fakes);
    try {
      body();
    } finally {
      for (const [k, descriptor] of found) {
        if (descriptor) Object.defineProperty(g, k, descriptor);
        else delete g[k];
      }
    }
  }

  function withStorage(local: Record<string, string>, session: Record<string, string>, body: () => void): void {
    withGlobals({
      localStorage: { getItem: (k: string) => local[k] ?? null },
      sessionStorage: { getItem: (k: string) => session[k] ?? null },
    }, body);
  }

  test('restores the width the user dragged this project to', () => {
    withStorage({ [projectSidebarWidthKey(PROJECT)]: '318' }, {}, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(318);
    });
  });

  test('sessionStorage is the second store, where an E2E fixture seeds a layout', () => {
    withStorage({}, { [projectSidebarWidthKey(PROJECT)]: '260' }, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(260);
    });
  });

  test('the width is per PROJECT: another folder does not inherit this one', () => {
    withStorage({ [projectSidebarWidthKey(PROJECT)]: '318' }, {}, () => {
      expect(readProjectSidebarWidth('/Users/someone/Projects/other')).toBe(DEFAULT_SIDEBAR_W);
    });
  });

  test('a saved value out of range is clamped, not obeyed', () => {
    withStorage({ [projectSidebarWidthKey(PROJECT)]: '9000' }, {}, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(MAX_SIDEBAR_W);
    });
    withStorage({ [projectSidebarWidthKey(PROJECT)]: '10' }, {}, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(MIN_SIDEBAR_W);
    });
  });

  test('nothing saved, or garbage, is the default — never NaN as a CSS width', () => {
    withStorage({}, {}, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(DEFAULT_SIDEBAR_W);
    });
    withStorage({ [projectSidebarWidthKey(PROJECT)]: 'wide' }, {}, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(DEFAULT_SIDEBAR_W);
    });
  });

  test('storage denied (private mode) is answered, not thrown', () => {
    withGlobals({ localStorage: { getItem: () => { throw new Error('SecurityError'); } } }, () => {
      expect(readProjectSidebarWidth(PROJECT)).toBe(DEFAULT_SIDEBAR_W);
    });
  });

  test('the fakes leave globalThis as they found it, a key left undefined included', () => {
    const g = globalThis as Record<string, unknown>;
    const before = Object.getOwnPropertyDescriptor(g, 'localStorage');
    g.localStorage = undefined;
    try {
      withStorage({}, {}, () => {});
      expect(Object.getOwnPropertyDescriptor(g, 'localStorage')).toEqual({ value: undefined, writable: true, enumerable: true, configurable: true });
    } finally {
      if (before) Object.defineProperty(g, 'localStorage', before);
      else delete g.localStorage;
    }
  });

  test('the drag and the restore obey the same two ends', () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_W - 40)).toBe(MIN_SIDEBAR_W);
    expect(clampSidebarWidth(MAX_SIDEBAR_W + 40)).toBe(MAX_SIDEBAR_W);
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_W)).toBe(DEFAULT_SIDEBAR_W);
  });
});
