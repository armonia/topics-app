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

/**
 * UNO SCADUTO NON SI DISEGNA COME UN ROSSO.
 *
 * `checks_state` ha tre esiti dal 18/08 (`checksVerdict` in
 * `server/services/review-checks.ts`) e la card deve tenerli distinti: rosso
 * dice «il codice e' rotto, non approvare», ambra dice «non lo sappiamo».
 * Misurato lo stesso giorno sul DB vivo: delle 15 card marcate `fail`, SEI
 * erano solo scadute al tetto dei 20 minuti — il 40% delle bocciature accusava
 * un codice sano.
 *
 * Sorgente e non render, per la stessa ragione dei casi qui sopra: `Card.tsx`
 * importa `@/lib/popoverStyles` e `bun test` non risolve l'alias. Cio' che si
 * sorveglia e' che i due chip restino DUE, con predicati disgiunti — collassare
 * `checksUnknown` dentro `checksRed` e' una modifica di una parola e non fa
 * rumore da nessuna parte.
 */
describe('il chip dei checks distingue rosso da non-misurato', () => {
  test('i due predicati esistono e sono disgiunti', () => {
    expect(src).toContain("const checksRed = task.checksState === 'fail';");
    expect(src).toContain("const checksUnknown = task.checksState === 'unknown';");
  });

  test("il chip «non misurati» ha un suo testid e un suo colore", () => {
    // Il testid serve all'E2E; il colore e' la meta' che l'occhio legge, e
    // riusare `rose` avrebbe rimesso in piedi il difetto lasciando i test verdi.
    expect(src).toContain('data-testid="card-checks-unknown"');
    const chip = src.slice(src.indexOf('data-testid="card-checks-unknown"'));
    expect(chip.slice(0, 400)).toContain('amber');
    expect(chip.slice(0, 400)).not.toContain('rose');
  });

  test('entrambi entrano nella riga dei chip: un chip che non si disegna non esiste', () => {
    // `hasMetaRow` decide se la riga si monta affatto. Dimenticarlo li' vuol
    // dire un chip corretto e invisibile — il difetto piu' silenzioso di tutti.
    const meta = src.slice(src.indexOf('const hasMetaRow'), src.indexOf('const hasMetaRow') + 700);
    expect(meta).toContain('checksRed');
    expect(meta).toContain('checksUnknown');
  });
});


/**
 * IL CHIP DEL TRIAGE, cioè i minuti in cui la card sembra ferma.
 *
 * Il primo turno di un agente comincia dall'inquadrare il lavoro: legge la
 * card, riscrive il titolo grezzo, giudica la priorità. Per chi guarda la board
 * non cambia niente — stesso titolo, nessun commento — e l'unica cosa che si
 * muove è un cronometro.
 *
 * Sorgente e non render, per la stessa ragione degli altri casi di questo file.
 * Ciò che si sorveglia sono le DUE condizioni insieme: il chip appartiene a un
 * turno vivo (`dispatchState === 'working'`) e alla fase iniziale (`triage`).
 * Perderne una lascerebbe il chip acceso su una card che non sta lavorando.
 */
describe('il chip del triage', () => {
  test('si disegna solo su un turno VIVO e ancora in inquadramento', () => {
    expect(src).toContain("live?.triage && task.dispatchState === 'working'");
    expect(src).toContain('data-testid="card-triage"');
  });

  test('ha un testo suo, non un titolo inventato nel markup', () => {
    const chip = src.slice(src.indexOf('data-testid="card-triage"'));
    expect(chip.slice(0, 400)).toContain("tr('board.card.triage')");
    expect(chip.slice(0, 400)).toContain("tr('board.card.triageTitle')");
  });
});
