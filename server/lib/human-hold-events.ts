/**
 * «Questa sessione ha appena cominciato — o smesso — di aspettare una persona.»
 *
 * `human-hold.ts` risponde a chi CHIEDE («sta aspettando?»). Questo modulo serve
 * a chi non può chiedere di continuo perché non ha un ciclo: la board.
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 * Un agente dispatchato ha DUE modi di chiedere qualcosa, e solo uno arrivava
 * sulla card:
 *
 *   (a) `comment_task(options=[…])` + `status=review` — il server compone il
 *       blocco ```question, la card mostra i bottoni, il chip diventa
 *       `needs_input`. Un click e l'agente riparte.
 *   (b) `mcp__topics__ask_user_question` (o una richiesta di permesso) A METÀ
 *       TURNO — il pannello si apre nella chat della sessione, il turno resta
 *       vivo perché `isHumanHold` disarma watchdog, reaper e tetto di vita…
 *       ma il task resta `working` e la board non mostra NIENTE.
 *
 * Il canale (b) non è un abuso: tenere vivo il turno è meglio che chiuderlo per
 * chiedere e pagare un resume. Il difetto è che l'attesa non arrivava alla
 * superficie da cui si guarda il lavoro. E un'attesa che non si vede è la
 * peggiore delle attese: la card dice «sto lavorando» mentre nessuno sta
 * lavorando, e l'unico modo per accorgersene è aprire il tab per caso.
 *
 * ── Perché un emitter e non una `import` diretta ────────────────────────────
 * Chi SA dell'attesa sono i due bridge (`ask-user-bridge`, `permission-bridge`).
 * Chi deve REAGIRE è il dispatcher. Se i bridge importassero il dispatcher
 * avremmo un ciclo (il dispatcher già li raggiunge via `human-hold`), e i bridge
 * smetterebbero di essere due Map pure e testabili a vuoto. Qui non c'è nessuna
 * dipendenza: un array di funzioni, e un `try` intorno a ognuna perché un
 * ascoltatore che lancia non deve poter far fallire l'apertura di un pannello.
 */

export type HumanHoldPhase = "held" | "released";

export interface HumanHoldChange {
  sessionKey: string;
  /** `held` = da adesso si aspetta una persona · `released` = non più. */
  phase: HumanHoldPhase;
  /** Quale delle due sorgenti ha mosso lo stato. Utile nei log, non nel chip:
   *  per chi guarda la board «domanda» e «permesso» sono lo stesso fatto. */
  source: "ask" | "permission";
}

type Listener = (change: HumanHoldChange) => void;

const listeners: Listener[] = [];

/** Registra un ascoltatore. Torna la funzione per disiscriversi. */
export function onHumanHoldChange(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * Annuncia il cambio. Best-effort per costruzione: un ascoltatore che lancia
 * viene ignorato, perché il pannello dell'utente vale più della notifica.
 */
export function emitHumanHoldChange(change: HumanHoldChange): void {
  for (const fn of [...listeners]) {
    try {
      fn(change);
    } catch {
      /* un ascoltatore rotto non blocca né il pannello né gli altri */
    }
  }
}

/** Solo per i test: svuota la lista fra un caso e l'altro. */
export function resetHumanHoldListeners(): void {
  listeners.length = 0;
}
