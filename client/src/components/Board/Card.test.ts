/**
 * LA COLONNA DISEGNA LA FETTA, NON LA LISTA.
 *
 * Misurato sulla macchina viva il 15/08/2026: 449 dei 467 task radice sono
 * `done`, e ognuno era un sottoalbero `Card` vivo — memo, chip, anteprima, il
 * nodo che dnd-kit registra — in una colonna che nessuno guarda. La regola su
 * quanto si disegna (e perché vale solo su Review e Done) è pura e provata in
 * `lib/boardOrder.test.ts`: `columnSlice`. Qui si controlla l'unica metà che
 * quella non può vedere, cioè che la colonna la USI.
 *
 * È un controllo sul SORGENTE, con lo stesso metodo e lo stesso motivo di
 * `GlobalCapControl.test.tsx` e `ThreadRuns.test.tsx`: `Card.tsx` importa
 * `@/lib/popoverStyles` e `bun test` non risolve l'alias `@/`, quindi la
 * colonna qui non si monta. Tornare a `tasks.map` è una modifica di una parola,
 * e non fa rumore da nessuna parte: la board resta corretta, diventa solo
 * lentissima di nuovo.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');

describe('il corpo della colonna', () => {
  test('mappa la fetta calcolata, non la colonna intera', () => {
    expect(src).toContain('columnSlice(');
    expect(src).toContain('slice.rows.map(');
    expect(src.includes('{tasks.map(')).toBe(false);
  });

  test('gli id di SortableContext sono quelli DISEGNATI', () => {
    // Un id nel registro di dnd-kit senza un nodo sotto è un bersaglio di drop
    // che non esiste: il gesto muore in silenzio, che è il modo peggiore.
    const itemIds = src.slice(src.indexOf('const itemIds'), src.indexOf('\n', src.indexOf('const itemIds')));
    expect(itemIds).toContain('slice.rows');
  });

  test('la coda dice quante card restano e come tirarle su', () => {
    // Una colonna tagliata in silenzio è una colonna che sembra senza storia.
    expect(src).toContain('kanban-column-more-');
    expect(src).toContain('setShown((n) => n + COLUMN_PAGE)');
  });

  test('il contatore in testa resta il TOTALE, non la fetta', () => {
    // Il numero accanto al nome della colonna risponde a «quanti ce ne sono»,
    // non a «quanti se ne vedono».
    expect(src).toContain('{tasks.length}');
  });
});
