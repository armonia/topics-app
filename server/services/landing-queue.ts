/**
 * Coda dei land — «landa» non deve poter sparire.
 *
 * Il guasto che la fa esistere: `POST …/tasks/:id/land` chiamava `void
 * landTask(...)` e rispondeva 200 con la card. Chi chiamava riceveva la card,
 * non l'esito — e con più chiamate insieme l'esito non arrivava proprio.
 * Misurato l'11/08 landando in blocco le card in review con un ciclo: ~20 POST
 * in raffica, 4 fusioni riuscite, le altre chiuse in `done` col codice ancora
 * sul loro branch, zero commenti e zero ragione. Le stesse card, una alla volta
 * e aspettando ognuna, sono atterrate tutte. Quindi non è la fusione a essere
 * rotta: è che le chiamate concorrenti si perdevano, e si perdevano in silenzio.
 *
 * Serializzare le fusioni ha senso (toccano tutte main nello stesso checkout) e
 * `task-automerge` già lo fa per le sue operazioni git. Ma un land è più della
 * fusione — commenti, timbro dell'esito, potatura del worktree, rebuild — e quei
 * pezzi restavano fuori dalla fila, ognuno con la sua promise fluttuante che
 * nessuno teneva: nessuna posizione, nessun esito, e alla morte del processo
 * nessuna traccia.
 *
 * Qui la fila diventa una COSA, con tre proprietà che il `void` non aveva:
 *
 *  · nessuno si perde — chi arriva mentre una fusione è in corso si mette in
 *    coda invece di sparire, e sa in quanti ha davanti;
 *  · ogni chiamata ha un ESITO interrogabile (`settled` / `failed` con il
 *    motivo), anche molto dopo che la richiesta HTTP si è chiusa;
 *  · un job che esplode chiude il SUO ticket e basta: la coda va avanti.
 *
 * Dedup per task: due click su «Landa» sulla stessa card sono UN land. Il
 * secondo riceve il ticket del primo — non una seconda fusione dello stesso
 * ramo, che nel migliore dei casi è un no-op rumoroso.
 *
 * Puro: nessun git, nessun db, nessun timer. Chi la usa passa la funzione che
 * fa il lavoro vero.
 */

// Il ticket attraversa il filo (è il corpo del `202` e della GET), quindi è
// dichiarato UNA volta in `shared/board.ts` e letto dai due lati.
export type { LandingTicket } from "../../shared/board";
import type { LandingTicket } from "../../shared/board";
import { makeSerialQueue } from "../lib/serial-queue";

export interface LandingQueueDeps {
  now?: () => string;
  log?: (msg: string) => void;
  /**
   * Quanti ticket GIÀ CHIUSI restano interrogabili (default 200). Serve a
   * rispondere «com'è andata?» dopo che la richiesta si è chiusa, senza far
   * crescere la mappa per sempre.
   */
  historyCap?: number;
}

interface Entry {
  ticket: LandingTicket;
  key: string;
  settled: Promise<LandingTicket>;
  finish: (t: LandingTicket) => void;
}

/** Il risultato opzionale che `run` puo' restituire per popolare il ticket. */
export interface LandOutcomeResult {
  outcome: LandingTicket['outcome'];
  reason?: string | null;
}

export interface LandingQueue {
  /**
   * Mette il land di `taskId` in fondo alla fila `key` (una per progetto: le
   * fusioni toccano tutte lo stesso checkout). Ritorna SUBITO il ticket, con la
   * posizione. Se un land per lo stesso task è già in fila o in corso, ritorna
   * QUELLO e non accoda niente.
   *
   * `run` puo' restituire un `LandOutcomeResult` per popolare `outcome` e
   * `reason` sul ticket, cosi' chi interroga GET /land ottiene l'esito
   * direttamente senza dover rileggere il task.
   */
  enqueue(key: string, taskId: string, run: () => Promise<LandOutcomeResult | void>): LandingTicket;
  /** L'ultimo ticket noto per il task — anche già chiuso. `null` se mai visto. */
  status(taskId: string): LandingTicket | null;
  /** Si risolve quando il land del task è finito. `null` se non ce n'è mai stato uno. */
  whenSettled(taskId: string): Promise<LandingTicket> | null;
  /** Quanti land sono in fila (compreso quello in corso) su `key`. */
  pending(key: string): number;
}

export function createLandingQueue(deps: LandingQueueDeps = {}): LandingQueue {
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const cap = deps.historyCap ?? 200;

  /** Task in fila per chiave, in ordine: l'indice 0 è quello che sta girando. */
  const lanes = new Map<string, string[]>();
  /** La coda che serializza i land: usa makeSerialQueue invece di tails inline. */
  const q = makeSerialQueue();
  const entries = new Map<string, Entry>();
  /** Ticket chiusi, dal più vecchio: la finestra da potare quando supera `cap`. */
  const history: string[] = [];

  function snapshot(e: Entry): LandingTicket {
    const lane = lanes.get(e.key);
    const at = lane ? lane.indexOf(e.ticket.taskId) : -1;
    return { ...e.ticket, ahead: at > 0 ? at : 0 };
  }

  function isOpen(t: LandingTicket): boolean {
    return t.phase === "queued" || t.phase === "running";
  }

  function retire(taskId: string): void {
    history.push(taskId);
    while (history.length > cap) {
      const old = history.shift();
      // Non si butta un ticket ancora aperto: un task ri-landato mentre la
      // finestra scorre avrebbe perso proprio l'esito che sta aspettando.
      if (old && old !== taskId) {
        const e = entries.get(old);
        if (e && !isOpen(e.ticket)) entries.delete(old);
      }
    }
  }

  return {
    enqueue(key, taskId, run) {
      const open = entries.get(taskId);
      if (open && isOpen(open.ticket)) return snapshot(open);

      let finish: (t: LandingTicket) => void = () => {};
      const settled = new Promise<LandingTicket>((res) => { finish = res; });
      const entry: Entry = {
        key,
        ticket: { taskId, phase: "queued", ahead: 0, queuedAt: now(), settledAt: null, error: null, outcome: null, reason: null },
        settled,
        finish,
      };
      entries.set(taskId, entry);

      const lane = lanes.get(key) ?? [];
      lane.push(taskId);
      lanes.set(key, lane);
      const ticket = snapshot(entry);

      // makeSerialQueue gestisce la coda di promise e la pulizia della mappa.
      // La fn wrappa tutto in try/catch, quindi non rifiuta mai: `void` è sicuro.
      void q.enqueue(key, async () => {
        entry.ticket.phase = "running";
        try {
          const result = await run();
          entry.ticket.phase = "settled";
          // Popola l'esito sul ticket se `run` lo ha restituito: chi interroga
          // GET /land lo legge direttamente, senza dover rileggere il task.
          if (result && typeof result === "object" && "outcome" in result) {
            entry.ticket.outcome = result.outcome ?? null;
            entry.ticket.reason = result.reason ?? null;
          }
        } catch (err) {
          // L'esito di UN land non contagia la fila: si chiude questo ticket col
          // motivo e si passa al prossimo. E' l'esatto contrario del `void`, che
          // lasciava una promise rifiutata e nient'altro.
          entry.ticket.phase = "failed";
          entry.ticket.error = err instanceof Error ? err.message : String(err);
          log(`[landing-queue] land fallito per ${taskId}: ${entry.ticket.error}`);
        }
        entry.ticket.settledAt = now();
        const cur = lanes.get(key);
        if (cur) {
          const i = cur.indexOf(taskId);
          if (i >= 0) cur.splice(i, 1);
          if (cur.length === 0) lanes.delete(key);
        }
        retire(taskId);
        entry.ticket.ahead = 0;
        entry.finish({ ...entry.ticket });
      });

      return ticket;
    },

    status(taskId) {
      const e = entries.get(taskId);
      return e ? snapshot(e) : null;
    },

    whenSettled(taskId) {
      const e = entries.get(taskId);
      if (!e) return null;
      return isOpen(e.ticket) ? e.settled : Promise.resolve(snapshot(e));
    },

    pending(key) {
      return lanes.get(key)?.length ?? 0;
    },
  };
}
