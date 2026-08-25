/**
 * `DISPATCH_CHIP` — il cancello di DERIVA fra i due lati del filo.
 *
 * Il server scrive `tasks.dispatch_state`, il client lo disegna leggendo questa
 * tabella, e `DispatchChip` restituisce `null` per una chiave che non c'è. Cioè
 * uno stato nuovo lato server, senza la sua riga qui, non dà nessun errore:
 * dà una card MUTA in Backlog, indistinguibile da una mai dispacciata. È
 * esattamente il difetto che `stopped` (shared/board.ts) è nato per togliere, e
 * ci si ricasca ogni volta che si aggiunge uno stato.
 *
 * Perciò l'elenco qui sotto è scritto a mano di proposito: è il contratto, non
 * una derivazione. Chi aggiunge uno stato lato server deve toccare due posti, e
 * questo test è il secondo.
 *
 * @covers KANBAN-07
 */
import { describe, test, expect } from 'bun:test';
import { DISPATCH_CHIP } from './constants';
import { PARKED_STOPPED, PARKED_WAITED_OUT } from '../../lib/board';

/** Ogni valore che il server può scrivere in `dispatch_state`. */
const STATI_DEL_SERVER = [
  'queued', 'starting', 'working',        // in volo
  'waiting',                              // attesa dichiarata, torna in coda
  'needs_input', 'delivered',             // in review
  'failed', 'blocked',                    // park
  PARKED_STOPPED, PARKED_WAITED_OUT,      // park, con la loro ragione
];

describe('DISPATCH_CHIP', () => {
  test('ogni stato che il server sa scrivere ha la sua riga: nessuna card muta', () => {
    for (const stato of STATI_DEL_SERVER) {
      expect(DISPATCH_CHIP[stato], `manca la chip per '${stato}'`).toBeDefined();
      expect(DISPATCH_CHIP[stato].text.trim().length).toBeGreaterThan(0);
      expect(DISPATCH_CHIP[stato].cls.trim().length).toBeGreaterThan(0);
    }
  });

  test("«troppa attesa» non è «fallito»: altro testo, altra tinta, altro glifo", () => {
    const atteso = DISPATCH_CHIP[PARKED_WAITED_OUT];
    const fallito = DISPATCH_CHIP.failed;
    expect(atteso.text).not.toBe(fallito.text);
    expect(atteso.text.toLowerCase()).not.toContain('fallit');
    // La tinta del fallimento è rosa/rossa: quella qui non ci deve stare, o il
    // colore direbbe «rotto» mentre il testo dice «aspetta».
    expect(atteso.cls).not.toContain('rose');
    expect(fallito.cls).toContain('rose');
    // Ma resta un PARK, non un chip di passaggio: l'anello lo distingue da
    // «in attesa», che è la stessa storia un capitolo prima.
    expect(atteso.cls).toContain('ring-1');
    expect(atteso.cls).not.toBe(DISPATCH_CHIP.waiting.cls);
  });

  test('i park che portano una ragione non hanno un titolo fisso: lo coprirebbe', () => {
    // `DispatchChip` fa `title={chip.title ?? error}`. Un titolo scritto qui
    // vince sempre su `task.dispatchError`, cioè nasconde PROPRIO la riga che
    // dice quante attese, per cosa e da quanto.
    for (const stato of ['failed', 'blocked', PARKED_STOPPED, PARKED_WAITED_OUT]) {
      expect(DISPATCH_CHIP[stato].title, `'${stato}' ha un titolo fisso`).toBeUndefined();
    }
  });
});
