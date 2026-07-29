import { describe, expect, test } from 'bun:test';
import { decideOrphans, type RosterEntry } from './nativeBrowserRoster';

const NOW = 'epoca-corrente';

function e(id: string, epoch: string): RosterEntry {
  return { id, epoch };
}

describe('decideOrphans', () => {
  test("una webview aperta da questo caricamento non si tocca", () => {
    expect(decideOrphans([e('a', NOW), e('b', NOW)], NOW, new Set())).toEqual([]);
  });

  test("una webview di un caricamento precedente è un orfano", () => {
    // È la regola che chiude il buco del ⌘R: la pagina che l'aveva aperta non
    // esiste più, quindi nessun `browser_close` la nominerà mai.
    expect(decideOrphans([e('vecchia', 'epoca-1')], NOW, new Set())).toEqual(['vecchia']);
  });

  test('una pane rimontata la rivendica e la salva', () => {
    const entries = [e('ripresa', 'epoca-1'), e('davvero-orfana', 'epoca-1')];
    expect(decideOrphans(entries, NOW, new Set(['ripresa']))).toEqual(['davvero-orfana']);
  });

  test('più epoche vecchie cadono tutte insieme', () => {
    const entries = [e('a', 'e1'), e('b', 'e2'), e('c', 'e3'), e('viva', NOW)];
    expect(decideOrphans(entries, NOW, new Set()).sort()).toEqual(['a', 'b', 'c']);
  });

  test('nessun duplicato anche se il roster ne contiene', () => {
    const entries = [e('x', 'e1'), e('x', 'e2')];
    expect(decideOrphans(entries, NOW, new Set())).toEqual(['x']);
  });

  test("una voce con l'epoca corrente vince su una vecchia con lo stesso id", () => {
    // Riapertura dopo il reload: la scrittura nuova rimpiazza la vecchia, ma se
    // per una corsa restassero entrambe, chiuderla sarebbe uccidere una viva.
    const entries = [e('x', 'e1'), e('x', NOW)];
    expect(decideOrphans(entries, NOW, new Set(['x']))).toEqual([]);
  });

  test('roster vuoto: niente da fare, non un errore', () => {
    expect(decideOrphans([], NOW, new Set())).toEqual([]);
  });

  test("una webview elencata dal runtime e ignota al roster è un orfano", () => {
    // È il caso che il solo roster non copre: dati del sito puliti, oppure un
    // crash a metà apertura. `browser_list` la vede comunque, e senza una voce
    // di questa pagina non può essere di nessuno.
    const entries = [e('nota', NOW), e('ignota-al-roster', '__sconosciuta__')];
    expect(decideOrphans(entries, NOW, new Set())).toEqual(['ignota-al-roster']);
  });

  test("una webview ignota al roster ma VIVA non si tocca", () => {
    const entries = [e('appena-montata', '__sconosciuta__')];
    expect(decideOrphans(entries, NOW, new Set(['appena-montata']))).toEqual([]);
  });
});
