/**
 * LA BANDIERA CHE ARMA LA POTATURA SI ALZA SOLO SU UN ROSTER ACCETTATO.
 *
 * ── Cosa protegge ───────────────────────────────────────────────────────────
 * `terminalSessionsLoadedRef` e' l'UNICO cancello di `pruneStaleTerminalPanes`,
 * che toglie le pane terminale dal layout. Finche' e' `false` non si pota
 * niente; da quando e' `true` ogni pane il cui id non compare nel roster
 * sparisce. Alzarla per sbaglio non produce un errore: produce pane sparite, e
 * chi le perde non ha modo di risalire al perche'.
 *
 * ── I tre modi in cui si alzava a sproposito ────────────────────────────────
 *   1. `fetch(...).then(r => r.json())` senza guardare `r.ok`: un 500 con un
 *      corpo JSON — e le rotte di questo server rispondono `{"error": "..."}` —
 *      passa da `.json()` senza un fiato.
 *   2. Quel corpo arrivava ad `applyRoster` come se fosse un elenco di sessioni,
 *      senza nessun `Array.isArray`.
 *   3. L'ORDINE: la bandiera si alzava PRIMA di applicare il roster, quindi
 *      restava alzata anche quando `decideRosterTrust` lo RIFIUTAVA. Ed e' il
 *      caso che conta: `rosterTrust` esiste apposta per NON credere a un vuoto
 *      sospetto, e la bandiera lo scavalcava.
 *
 * ── Perche' legge il sorgente ───────────────────────────────────────────────
 * La regola pura (`decideRosterTrust`) ha gia' i suoi test qui accanto. Cio' che
 * manca e' il CABLAGGIO, che vive dentro un hook React: montarlo vorrebbe dire
 * un renderer e un finto `fetch` per provare tre righe di ordine. Il sorgente
 * risponde alla stessa domanda in modo diretto — ed e' lo stesso mestiere che
 * fanno gia' `card-meta-row-completeness` e `board-settings-passthrough`: cio'
 * che manca non lascia tracce a runtime.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SORGENTE = readFileSync(resolve(import.meta.dir, 'useTerminalLifecycle.ts'), 'utf8');

/** Il corpo di `fetchTerminalSessions`, fino alla fine della sua `useCallback`. */
function corpoDellaFetch(): string {
  const inizio = SORGENTE.indexOf('const fetchTerminalSessions = useCallback(');
  expect(inizio, 'fetchTerminalSessions e cambiata di nome: aggiorna questo test').toBeGreaterThan(0);
  const fine = SORGENTE.indexOf('}, [applyRoster]);', inizio);
  expect(fine, 'la chiusura della useCallback non si trova piu').toBeGreaterThan(inizio);
  return SORGENTE.slice(inizio, fine);
}

describe('il roster dei terminali non si crede a scatola chiusa', () => {
  test('il corpo della fetch si trova (guardia contro un verde a vuoto)', () => {
    // Senza questa, un rinominare qualsiasi renderebbe i casi sotto verdi su una
    // stringa vuota: il modo piu comune in cui un cancello smette di guardare.
    expect(corpoDellaFetch().length).toBeGreaterThan(200);
  });

  test('una risposta non-2xx non diventa un roster', () => {
    expect(corpoDellaFetch()).toContain('r.ok');
  });

  test('un corpo che non e un array non diventa un roster', () => {
    expect(corpoDellaFetch()).toContain('Array.isArray(data)');
  });

  test('la bandiera si alza SOLO se applyRoster ha accettato', () => {
    const corpo = corpoDellaFetch();
    // L'unica scrittura della bandiera in questa funzione deve essere governata
    // dall'esito di `applyRoster`. La forma e pinnata: un `= true` nudo qui
    // dentro e' esattamente il difetto.
    const scritture = [...corpo.matchAll(/terminalSessionsLoadedRef\.current\s*=\s*true/g)];
    expect(scritture.length, 'una sola scrittura, e governata').toBe(1);
    expect(corpo).toContain('if (applyRoster(data)) terminalSessionsLoadedRef.current = true;');
  });

  test('applyRoster DICE se ha accettato: senza, la guardia sopra non esisterebbe', () => {
    // Il valore di ritorno e il perno di tutto: prima non c'era, e la bandiera
    // non aveva modo di sapere che `decideRosterTrust` aveva rifiutato.
    expect(SORGENTE).toContain('reconciled?: boolean): boolean =>');
    expect(SORGENTE).toContain('if (!d.accept) return false;');
  });
});
