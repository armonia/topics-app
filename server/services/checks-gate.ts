/**
 * Le corse dei check pre-review, FUORI dalla richiesta che le ha chieste.
 *
 * PERCHE' ESISTE. Il gate girava dentro la `PATCH .../tasks/:id {status:"review"}`
 * e la richiesta durava quanto i comandi: misurato il 13/08, `test:unit` da solo
 * ci mette ~10 minuti su macchina carica, ma la connessione muore a 255,6s netti
 * perche' `idleTimeout` di `Bun.serve` non puo' salire oltre 255 (server.ts lo
 * tiene gia' al massimo). Il client vedeva cadere il socket, la transizione non
 * veniva applicata, e `checks_state` restava «running» per sempre sulla card.
 *
 * LA FORMA. La stessa gia' collaudata qui per `ask_user_question` e
 * `approval_prompt`: la corsa vive nel processo, la richiesta aspetta al massimo
 * una GAMBA e, se non e' finita, risponde «pending» e il client richiama. Nessun
 * socket resta aperto piu' di una gamba, e chi aspetta non e' piu' chi esegue.
 *
 * QUELLO CHE IL REGISTRO GARANTISCE, ed e' il motivo per cui non basta un
 * `void run()` sparso nella rotta:
 *  · UNA corsa per chiave. Dieci gambe della stessa consegna si agganciano alla
 *    stessa promise, non fanno partire dieci giri di test.
 *  · L'esito sopravvive alla gamba. Se il socket cade proprio mentre i comandi
 *    finiscono, la gamba dopo trova il verdetto gia' pronto invece di rifare
 *    dieci minuti di lavoro. La ritenzione e' legata al COMMIT: una consegna
 *    nuova (commit diverso) non eredita mai il verdetto della precedente.
 *  · Una corsa che esplode non lascia una chiave avvelenata: si cancella, e il
 *    tentativo dopo riparte pulito.
 *
 * LA SERIALIZZAZIONE (aggiunta il 18/08). Sei card consegnate nello stesso
 * quarto d'ora lanciavano sei barre di check IN PARALLELO. `test:unit` da solo
 * costa 322 secondi e satura piu' core: sei barre insieme portavano il loadavg
 * a 78,83 su 12 core. Il reviewer non guarda sei card nello stesso secondo, e
 * ritardare la sesta barra non costa niente a nessuno.
 *
 * Con `maxConcurrent` (default 1) il registro tiene un semaforo: chi non trova
 * un posto libero si mette in coda (accodata, non avviata) e si prenota la
 * gamba piu' lunga disponibile. Appena una corsa finisce sblocca la prima della
 * coda. Il comportamento verso l'esterno e' identico: `{pending:true}` fino al
 * verdetto, indipendente dal fatto che la corsa stia girando o aspettando.
 *
 * Il numero di corse in volo e' letto dal dispatcher (via `runningCount()`) per
 * contarle nel freno del dispatch: ogni barra viva vale uno slot perche' satura
 * la stessa CPU che l'agente userebbe.
 *
 * Quello che il registro NON fa e' sopravvivere a un riavvio del processo: le
 * corse in volo muoiono col server, ed e' per questo che al boot la spia
 * «running» va spenta a mano (vedi `clearStaleChecksRuns` in services/tasks.ts).
 */

/** L'esito di un giro di check: quello che la rotta rimanda all'agente. */
export type ChecksVerdict = { ok: boolean; comment: string };

/**
 * Cosa ha visto UNA gamba: il verdetto se la corsa e' finita, `pending` se sta
 * ancora girando, `null` se la corsa e' morta senza produrre un verdetto (in
 * quel caso il gate non ha misurato niente e non deve scriverne uno).
 */
export type ChecksLeg = ChecksVerdict | { pending: true } | null;

type Corsa = {
  commit: string | null;
  promise: Promise<ChecksVerdict | null>;
  verdict: ChecksVerdict | null;
  endedAt: number | null;
};

export type ChecksGate = {
  /**
   * Avvia la corsa (se non c'e' gia') e aspetta al massimo `legMs`.
   * `run` viene chiamata SOLO quando la corsa parte davvero.
   * Se il numero di corse in volo ha raggiunto `maxConcurrent`, la corsa e'
   * accodata: la risposta resta `{pending:true}` fino a quando un posto si
   * libera e il giro finisce.
   */
  leg(key: string, opts: {
    commit: string | null;
    legMs: number;
    run: () => Promise<ChecksVerdict | null>;
  }): Promise<ChecksLeg>;
  /** C'e' una corsa viva (girando o accodata) su questa chiave? (sonde e test) */
  isRunning(key: string): boolean;
  /**
   * Quante corse stanno GIRANDO adesso (non conteggiate quelle in coda).
   * Letto dal dispatcher per includere le barre di check nel freno del dispatch:
   * ogni barra viva vale uno slot di capacita'.
   */
  runningCount(): number;
};

/**
 * Quanto una richiesta aspetta prima di rispondere «sta ancora girando».
 * Venticinque secondi come le gambe di `ask_user_question`: abbastanza corte da
 * non avvicinarsi mai al tetto di Bun, abbastanza lunghe da non trasformare un
 * gate di dieci minuti in una raffica di richieste.
 */
export const CHECKS_LEG_MS = 25_000;

/**
 * Il tetto di una gamba, comunque la chieda il client. `idleTimeout` di
 * `Bun.serve` non puo' superare 255s: una gamba che ci si avvicina rimette in
 * piedi esattamente il guasto che questo modulo esiste per chiudere.
 */
export const CHECKS_LEG_MS_MAX = 120_000;

/** La gamba chiesta dal client, riportata dentro i limiti. */
export function clampLegMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return CHECKS_LEG_MS;
  return Math.min(Math.max(Math.round(raw), 100), CHECKS_LEG_MS_MAX);
}

/** Quanto un verdetto resta disponibile a chi torna dopo che la corsa e' finita. */
export const CHECKS_RESULT_RETAIN_MS = 5 * 60_000;

/**
 * Quante barre possono girare IN PARALLELO di default.
 *
 * UNO, non piu'. La barra completa (`typecheck + lint + deadcode + emdash +
 * migrations + test:unit`) satura piu' core per centinaia di secondi: sei barre
 * insieme sul 18/08 hanno portato il loadavg a 78,83 su 12 core. Il reviewer
 * non apre sei card nello stesso secondo, quindi ritardare la sesta non ha
 * nessun costo visibile.
 *
 * Chi vuole parallelismo esplicito puo' passare `maxConcurrent > 1` a
 * `createChecksGate`, ma il default conservativo vale per tutte le installazioni
 * nuove senza richiedere nessuna configurazione.
 */
export const DEFAULT_MAX_CONCURRENT_CHECKS = 1;

export function createChecksGate(opts: {
  retainMs?: number;
  now?: () => number;
  /**
   * Quante corse possono girare IN PARALLELO. Le corse oltre questa soglia
   * vengono accodate: si avviano nell'ordine in cui sono arrivate, appena un
   * posto si libera. Il default e' 1 (barre serializzate).
   */
  maxConcurrent?: number;
} = {}): ChecksGate {
  const retainMs = opts.retainMs ?? CHECKS_RESULT_RETAIN_MS;
  const now = opts.now ?? Date.now;
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHECKS);
  const corse = new Map<string, Corsa>();
  // Chiavi delle corse che stanno GIRANDO adesso (non in coda).
  let activeCount = 0;
  // Coda di chi aspetta un posto: risolto con il verdetto della propria corsa
  // appena il semaforo si libera.
  const coda: Array<() => void> = [];

  /** Sblocca il prossimo in coda, se c'e' posto. */
  function drain(): void {
    while (activeCount < maxConcurrent && coda.length > 0) {
      const next = coda.shift()!;
      next();
    }
  }

  function start(key: string, commit: string | null, run: () => Promise<ChecksVerdict | null>): Corsa {
    const corsa: Corsa = { commit, promise: Promise.resolve(null), verdict: null, endedAt: null };
    // Il wrapper non rigetta MAI: una promise memorizzata che nessuno sta
    // aspettando (la gamba puo' essere gia' scaduta) e che rigetta diventa un
    // unhandled rejection, cioe' un processo che muore per un test rosso.
    corsa.promise = new Promise<ChecksVerdict | null>((resolveCorsa) => {
      const execute = () => {
        activeCount += 1;
        (async () => {
          try {
            const verdict = await run();
            corsa.verdict = verdict;
            corsa.endedAt = now();
            if (!verdict) corse.delete(key); // niente verdetto = niente da ricordare
            resolveCorsa(verdict);
          } catch (err) {
            corsa.endedAt = now();
            corse.delete(key);
            console.error(`[checks-gate] corsa ${key} esplosa`, err);
            resolveCorsa(null);
          } finally {
            activeCount -= 1;
            drain();
          }
        })();
      };

      if (activeCount < maxConcurrent) {
        // Posto subito disponibile.
        execute();
      } else {
        // Posto pieno: si accoda. La corsa non e' ancora partita, ma esiste
        // gia' nel registro (corse.set sotto), cosi' le gambe che arrivano nel
        // frattempo si agganciano alla stessa promise invece di creare doppioni.
        coda.push(execute);
      }
    });
    corse.set(key, corsa);
    return corsa;
  }

  return {
    runningCount() {
      return activeCount;
    },
    isRunning(key) {
      const corsa = corse.get(key);
      return !!corsa && corsa.endedAt === null;
    },
    async leg(key, { commit, legMs, run }) {
      let corsa = corse.get(key);
      // Il verdetto vale per il commit su cui e' stato misurato, e non piu' a
      // lungo di `retainMs`: oltre, un agente che riconsegna la stessa cosa si
      // merita una misura fresca invece di un timbro vecchio.
      if (corsa && corsa.endedAt !== null
        && (corsa.commit !== commit || now() - corsa.endedAt > retainMs)) {
        corse.delete(key);
        corsa = undefined;
      }
      // Una corsa VIVA non si scarta mai, nemmeno se il commit e' cambiato:
      // ammazzarla a meta' significherebbe due giri di test in parallelo sullo
      // stesso worktree, che si disturbano a vicenda.
      if (corsa && corsa.endedAt !== null && corsa.verdict) return corsa.verdict;
      if (!corsa) corsa = start(key, commit, run);

      let timer: ReturnType<typeof setTimeout> | null = null;
      const gamba = new Promise<ChecksLeg>((resolve) => {
        timer = setTimeout(() => resolve({ pending: true }), legMs);
      });
      try {
        return await Promise.race([corsa.promise, gamba]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
