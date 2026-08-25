/**
 * @covers LAYOUT-22
 */
import { describe, expect, test } from 'bun:test';
import { SEZIONI, capSezione } from './projectSidebarHeights';

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
