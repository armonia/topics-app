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
// The column width classes moved to `boardGeometry.ts` so the loading
// skeleton draws the same columns; the width assertions read them there.
const GEOMETRY = readFileSync(join(DIR, 'boardGeometry.ts'), 'utf8');
const WIDTH_BLOCK = GEOMETRY.slice(GEOMETRY.indexOf('export const COLUMN_WIDTH'), GEOMETRY.indexOf('/** The column frame'));

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
    const widthBlock = WIDTH_BLOCK;
    expect(widthBlock).toContain("layout === 'list'");
    expect(widthBlock).toContain('w-full max-w-3xl');
  });
});

describe('la colonna Review si allarga quando ha lavoro dentro', () => {
  test('un tasto dedicato distingue Review piena da Review vuota', () => {
    expect(CARD).toContain('const reviewHasWork = isReview && (tasks.length > 0 || !!draft);');
  });

  test('Review piena reclama più riga di Review vuota', () => {
    const widthBlock = WIDTH_BLOCK;
    expect(widthBlock).toContain('reviewHasWork');
    expect(widthBlock).toContain("lg:basis-[35rem] lg:max-w-[44rem]");
    expect(widthBlock).toContain("lg:basis-[32rem] lg:max-w-[44rem]");
  });

  test('Review piena non ha mai un tetto più basso di Review vuota', () => {
    const widthBlock = WIDTH_BLOCK;
    const caps = [...widthBlock.matchAll(/lg:max-w-\[(\d+)rem\]/g)].map((m) => Number(m[1]));
    // The first lg cap is the Review with work, the second the empty one.
    expect(caps.length).toBeGreaterThanOrEqual(2);
    expect(caps[0]).toBeGreaterThanOrEqual(caps[1]);
  });

  // The claim and release still move, but by transform, not by layout: a
  // `flex-basis` transition re-ran layout every frame while the card FLIP
  // measured a moving target (fluidity audit panes:F8). The width lands in one
  // pass and `slideLanes` glides the columns it shifted.
  test('the width change is not a layout transition, and the shifted columns slide', () => {
    const widthBlock = WIDTH_BLOCK;
    expect(widthBlock).not.toMatch(/transition-\[[^\]]*(flex-basis|max-width)/);
    const motion = readFileSync(join(DIR, 'useBoardMotion.ts'), 'utf8');
    expect(motion).toContain('slideLanes(root, previous.lanes, now.lanes)');
  });
});
