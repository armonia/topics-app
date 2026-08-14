/**
 * Una raffica di eventi, una lettura sola.
 *
 * Il feed globale della board (`GET /api/all-boards/tasks`) si rilegge a ogni
 * evento `task:created|updated|deleted` del WebSocket, e finora uno a uno: N
 * eventi, N riletture. Misurato il 2026-08-14 su questa macchina: il feed pesa
 * 1,44 MB e costa 175 ms al server, e il minuto più affollato degli ultimi tre
 * giorni ha 24 aggiornamenti di task — cioè 34,6 MB scaricati e 4,2 s di server
 * per mostrare uno stato che alla fine è UNO. Ogni risposta riscrive anche lo
 * store, quindi ogni superficie della board si ridisegna 24 volte.
 *
 * La raffica non è un caso raro: è la forma normale del lavoro di questa app,
 * dove sono gli agenti a muovere le card.
 *
 * ## Come coalesce, e perché così
 *
 * Fronte di SALITA più coda: il primo evento parte subito, quelli che arrivano
 * entro la finestra diventano UNA sola rilettura dopo. Un debounce puro
 * (aspetta-e-poi-leggi) sarebbe più semplice e sbagliato: ritarderebbe anche
 * l'evento singolo, che è il caso in cui l'umano ha appena mosso una card e
 * guarda lo schermo. Così il singolo resta immediato e la raffica costa due
 * letture invece di ventiquattro.
 *
 * L'ultimo stato non si perde mai: se durante la finestra è arrivato anche un
 * solo evento, la coda riparte. Il tetto è una lettura per finestra, il
 * pavimento è che l'ultima lettura è sempre POSTERIORE all'ultimo evento.
 *
 * ## Fuori ordine
 *
 * Due letture sovrapposte possono tornare invertite (la prima più lenta della
 * seconda), e chi scrive per ultimo vince: lo schermo resterebbe indietro senza
 * che nessun evento successivo lo corregga. Il coalescer numera le corse e
 * scarta il risultato di una corsa già superata.
 *
 * `now`/`schedule` sono iniettabili perché il test possa guidare il tempo senza
 * dormire: un test che aspetta davvero 400 ms per verificare una finestra da
 * 400 ms è un test che si spegne il giorno che la macchina è carica.
 */

export interface CoalescerOptions {
  /** Millisecondi in cui gli eventi successivi al primo si fondono in uno. */
  windowMs: number;
  /** Il lavoro da fare. Se lancia, l'errore è del chiamante: qui si ignora. */
  run: () => Promise<void>;
  /** Iniettabile per i test. Default: `setTimeout` del documento. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Iniettabile per i test. Default: `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

export interface Coalescer {
  /** Segnala che c'è qualcosa di nuovo da leggere. */
  trigger: () => void;
  /** Spegne la coda in sospeso (da chiamare allo smontaggio). */
  dispose: () => void;
}

export function createBurstCoalescer(opts: CoalescerOptions): Coalescer {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let pending = false;
  let disposed = false;

  const fire = (): void => {
    if (disposed) return;
    void opts.run().catch(() => { /* il chiamante decide cosa fare di un errore */ });
    handle = schedule(() => {
      handle = null;
      if (!pending || disposed) return;
      pending = false;
      fire();
    }, opts.windowMs);
  };

  return {
    trigger(): void {
      if (disposed) return;
      // Finestra aperta: questo evento si fonde con gli altri e riparte dopo.
      if (handle !== null) { pending = true; return; }
      fire();
    },
    dispose(): void {
      disposed = true;
      pending = false;
      if (handle !== null) { cancel(handle); handle = null; }
    },
  };
}

/**
 * Il guardiano dell'ordine: avvolge una lettura asincrona in modo che il
 * risultato di una corsa SUPERATA non scriva mai sopra a uno più recente.
 *
 * Serve perché `fetch` non promette l'ordine di arrivo: con una lettura da
 * 175 ms e una finestra da 400 ms la sovrapposizione è rara, ma sotto carico
 * (o su una rete lenta) succede — ed è esattamente la condizione in cui lo
 * schermo resta indietro senza più nessun evento che lo corregga.
 */
export function latestWins<T>(apply: (value: T) => void): (load: () => Promise<T>) => Promise<void> {
  let ultima = 0;
  return async (load) => {
    const mia = ++ultima;
    const value = await load();
    if (mia !== ultima) return;
    apply(value);
  };
}
