/**
 * THE VERTICAL LIST VIEW, source-checked.
 *
 * `KanbanBoardPane` does not mount under `bun test` (store, pane layout, API
 * and a dozen hooks — see `kanbanTopbar.test.ts` for the full reason), and
 * `Column` in `Card.tsx` pulls `@/lib/popoverStyles`, which `bun test` does
 * not resolve either (see `Card.test.ts`). Same house method: read the
 * structure that decides the behaviour instead of rendering it.
 *
 * What actually matters here, checked as three separate facts because each
 * one is independently easy to lose in a later edit: the toggle exists and
 * is wired to a persisted preference, `Column` actually changes shape under
 * `layout="list"`, and an empty section in that mode draws nothing instead
 * of a bare header.
 *
 * @covers KANBAN-94
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dir;
const PANE = readFileSync(join(DIR, 'KanbanBoardPane.tsx'), 'utf8');
const CARD = readFileSync(join(DIR, 'Card.tsx'), 'utf8');

describe('il tasto della vista lista, accanto alla ricerca', () => {
  test('esiste, ed è un aria-pressed booleano su boardLayout', () => {
    expect(PANE).toContain('data-testid="board-layout-toggle"');
    expect(PANE).toContain("aria-pressed={boardLayout === 'list'}");
  });

  test('la scelta è persistita, non solo in memoria del componente', () => {
    expect(PANE).toContain('localStorage.getItem(BOARD_LAYOUT_STORAGE_KEY)');
    expect(PANE).toContain('localStorage.setItem(BOARD_LAYOUT_STORAGE_KEY, boardLayout)');
  });

  test('la vista raggiunge davvero le colonne', () => {
    expect(PANE).toContain('layout={boardLayout}');
  });
});

describe('Column in modalità lista', () => {
  test('una sezione vuota e senza bozza non disegna niente', () => {
    expect(CARD).toContain("if (layout === 'list' && tasks.length === 0 && !draft) return null;");
  });

  test('piena larghezza fino a un tetto di lettura, non più la corsia fissa del carosello', () => {
    const widthBlock = CARD.slice(CARD.indexOf('const widthCls ='), CARD.indexOf('if (layout ==='));
    expect(widthBlock).toContain("layout === 'list'");
    expect(widthBlock).toContain('w-full max-w-3xl');
  });
});

describe('la colonna Review si allarga quando ha lavoro dentro', () => {
  test('un tasto dedicato distingue Review piena da Review vuota', () => {
    expect(CARD).toContain('const reviewHasWork = isReview && (tasks.length > 0 || !!draft);');
  });

  test('Review piena reclama più riga di Review vuota', () => {
    const widthBlock = CARD.slice(CARD.indexOf('const widthCls ='), CARD.indexOf('if (layout ==='));
    expect(widthBlock).toContain('reviewHasWork');
    expect(widthBlock).toContain("lg:basis-[35rem] lg:max-w-[42rem]");
    expect(widthBlock).toContain("lg:basis-[32rem] lg:max-w-[44rem]");
  });

  test('la larghezza cambia con una transizione, non a scatto', () => {
    const widthBlock = CARD.slice(CARD.indexOf('const widthCls ='), CARD.indexOf('if (layout ==='));
    expect(widthBlock).toContain('transition-[flex-basis,max-width]');
  });
});
