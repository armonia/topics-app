import { STOP_CAUSES } from "../../shared/ws-outbound";
/**
 * PERCHÉ un turno è finito — detto una volta sola, con il vocabolario di ACP.
 *
 * Prima nessuno lo sapeva. Il dispatcher scriveva sulla card «Turno interrotto
 * senza arrivare a review (probabile timeout)» e «Turno caduto subito
 * (probabile problema momentaneo del provider)»: due INDOVINELLI, dedotti da
 * quanto era durato il turno, perché la vera ragione non arrivava mai fin lì —
 * il provider la conosceva e la buttava via.
 *
 * Indovinare non è gratis: le politiche di ripresa sono diverse per ragioni
 * diverse. Un contesto pieno va ripreso subito (la sessione compatta e
 * riparte), un rifiuto del modello NON va ripreso affatto (riprovare uguale
 * ottiene lo stesso rifiuto e brucia il budget), e uno stop premuto da un umano
 * non è un fallimento dell'agente e non deve costargli un tentativo. Con un
 * unico "probabile timeout" tutti e tre finivano nello stesso ramo.
 *
 * Il vocabolario è quello di ACP (Agent Client Protocol) perché è lo stesso che
 * la fase 3 del piano espone verso l'esterno: nominarlo qui in modo diverso
 * significherebbe tradurlo due volte.
 */

/** Le cinque ragioni di ACP. */
export type StopReason =
  /** L'agente ha finito il suo turno da solo. */
  | "end_turn"
  /** Limite di token raggiunto (contesto pieno o output troncato). */
  | "max_tokens"
  /** Il turno ha esaurito le richieste al modello che gli erano concesse. */
  | "max_turn_requests"
  /** Il modello si è rifiutato. */
  | "refusal"
  /** Qualcuno ha fermato il turno: l'umano, il watchdog, il tetto a orologio. */
  | "cancelled";

/**
 * Le cinque ACP più `error`. ACP un turno CRASHATO non lo chiama "fermato" —
 * risponde con un errore di protocollo, che è un'altra cosa. Noi però dobbiamo
 * distinguerlo (un crash si riprova, un rifiuto no) e il dispatcher legge un
 * campo solo: quindi vive qui, marcato per quello che è, e `isAcpStopReason` lo
 * tiene fuori da tutto ciò che parla ACP sul filo.
 */
export type TurnEnd = StopReason | "error";

export const ACP_STOP_REASONS: readonly StopReason[] = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
];

export function isAcpStopReason(value: unknown): value is StopReason {
  return typeof value === "string" && (ACP_STOP_REASONS as readonly string[]).includes(value);
}

/**
 * CHI ha fermato il turno. `cancelled` da solo non basta a decidere: uno stop
 * premuto da un umano e il nostro stesso tetto a orologio sono lo stesso
 * `reason` ACP ma due politiche opposte (vedi `consumesAttempt`).
 */
export type StopCause =
  /** L'umano ha premuto stop. */
  | "user"
  /** Il watchdog dello stream: nessun evento per troppo tempo, processo morto. */
  | "watchdog"
  /** Il tetto a orologio del dispatcher ha tagliato il turno. */
  | "wall-clock"
  /**
   * IL SERVER SI STA SPEGNENDO, e il turno viveva dentro di lui.
   *
   * Non è `user` e non è `watchdog`: nessuno ha premuto niente e niente si era
   * inchiodato. È il riavvio — pianificato (`restart-when-idle` dopo un
   * salvataggio su `server/`) o no — che passa da `stopAllProviders()` e
   * annulla ogni turno vivo.
   *
   * Perché ha una causa SUA, misurata il 20/08 su topic:9f9e9629. Il runtime
   * nativo `topics` esegue il turno DENTRO il processo del server: quando il
   * processo muore non resta nessun figlio nel broker da riadottare, quindi la
   * riadozione — che è la ragione per cui una chat può essere tagliata senza
   * troppi complimenti — non succede e non succederà. Quel turno finiva come
   * `cancelled` + causa `user`: una bugia in tre punti diversi (il registro
   * della fine, la riga `stream aborted by user` in `activity_log`, e
   * soprattutto `finalizeStream`, che su uno stop dell'UMANO tace di proposito
   * perché l'umano sa già di aver premuto). Risultato a schermo: una risposta a
   * metà frase, senza una parola che dicesse cosa fosse successo.
   */
  | "server-shutdown"
  /**
   * THE PASSIVE STALL DETECTOR RECYCLED THE TURN, not a timer.
   *
   * `dispatchTimeoutMin` no longer cuts anything by itself (see
   * `server/lib/stall-detector.ts`): once the session's transcript has been
   * silent for `dispatchIdleMin`, a cheap judge reads the transcript tail and
   * answers "alive" or "stuck". This cause exists only for a CONFIRMED
   * "stuck" verdict — an "alive" one rearms the watch and produces no
   * `TurnEndInfo` at all, the turn just keeps running.
   */
  | "stall"
  /** La sessione `--resume` non esisteva più: reset trasparente, si rispawna. */
  | "session-reset"
  /** Il processo figlio è uscito con codice diverso da zero. */
  | "process-died"
  /**
   * La sessione stava già rispondendo: la front-door ha respinto con 409
   * `stream_in_flight` e noi non abbiamo guidato NIENTE. Non è un guasto — è un
   * «riprova quando ha finito» — quindi non brucia un tentativo.
   */
  | "turn-in-flight"
  /** Il provider ha risposto errore (rete, credito, limite). */
  | "provider-error";

/**
 * THE TWO LISTS MUST MATCH, and the compiler is what checks it.
 *
 * The union above has nine members; the wire schema
 * (`shared/ws-outbound.ts`) carried six, copied by hand. The three missing
 * ones were really emitted, and every `stream:end` carrying one was thrown
 * away as a malformed broadcast: the chat never got the end of its turn and
 * stayed "running" forever.
 *
 * The two lines below fail the build if either list grows without the other -
 * in BOTH directions. It is not a test somebody has to remember to run: it is
 * `typecheck`, which already runs on every delivery.
 */
type SameMembers<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _causesAligned: SameMembers<StopCause, (typeof STOP_CAUSES)[number]> = true;
void _causesAligned;


export interface TurnEndInfo {
  end: TurnEnd;
  cause?: StopCause;
  /** Testo grezzo che ha portato alla classificazione — per il log, non per l'UI. */
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Classificazione

/**
 * Un limite di token si presenta con parole diverse a seconda di chi risponde
 * (CLI, API, gateway). Sono tutte varianti della stessa cosa e vanno nello
 * stesso ramo: il turno non è fallito, il contesto è pieno.
 */
const MAX_TOKENS_RE =
  /(max(imum)?[ _-]?tokens?)|(context[ _-]?(length|window)[^.]{0,24}exceed)|(prompt is too long)|(input length and `max_tokens`)|(too many tokens)/i;

/**
 * Un rifiuto è una POSIZIONE del modello, non un guasto: riprovare identico
 * ottiene lo stesso rifiuto. Deliberatamente stretto — un falso positivo qui
 * manda in review un task che si sarebbe ripreso da solo, ed è meglio un
 * ritentativo di troppo che una card parcheggiata per una parola.
 */
const REFUSAL_RE =
  /\b(refus(al|ed|es)|declined to (assist|answer|comply)|stop_reason["' :]+refusal)\b/i;

/** Il turno ha esaurito le richieste al modello concesse (`--max-turns`). */
const MAX_TURNS_RE = /error_max_turns|max[ _-]?turns? (exceeded|reached)/i;

/**
 * Dall'evento `result` finale della CLI Claude Code
 * (`--output-format stream-json`).
 *
 * Forma: `{ type: "result", subtype: "success" | "error_max_turns" |
 * "error_during_execution", is_error?: boolean, errors?: string[], result?: string }`.
 * `subtype` da solo non basta: `error_during_execution` è il cestino dove
 * finiscono contesto pieno, rifiuto e guasto vero, che sono tre politiche
 * diverse — quindi si guarda anche il testo.
 */
export function classifyResultEvent(event: {
  subtype?: unknown;
  is_error?: unknown;
  errors?: unknown;
  result?: unknown;
}): TurnEndInfo {
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  const errored = event.is_error === true || subtype.startsWith("error");
  const text = [
    subtype,
    ...(Array.isArray(event.errors) ? event.errors.map((e) => String(e)) : []),
    errored && typeof event.result === "string" ? event.result : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!errored) return { end: "end_turn" };
  if (MAX_TURNS_RE.test(text)) return { end: "max_turn_requests", detail: text };
  // Il contesto pieno prima del rifiuto: un messaggio di limite token può
  // contenere la parola "refuse" in una spiegazione, mai il contrario.
  if (MAX_TOKENS_RE.test(text)) return { end: "max_tokens", detail: text };
  if (REFUSAL_RE.test(text)) return { end: "refusal", detail: text };
  return { end: "error", cause: "provider-error", detail: text };
}

/** Un turno fermato da qualcuno: sempre `cancelled`, la causa dice da chi. */
export function cancelled(cause: StopCause, detail?: string): TurnEndInfo {
  return { end: "cancelled", cause, detail };
}

/**
 * La causa che viaggia dentro un `AbortSignal`, o `null` se non ce n'è una.
 *
 * PERCHÉ SI LEGGE DAL SEGNALE. La ragione di un annullamento e il segnale di
 * annullamento sono la stessa cosa e devono viaggiare insieme: `AbortController
 * .abort(reason)` è il posto che la piattaforma prevede per questo, e
 * `signal.reason` è dove finisce. Un campo scritto accanto al controller
 * sarebbe una seconda verità da tenere allineata a mano — cioè un posto in cui
 * le due possono divergere, che è esattamente il difetto da cui nasce questo
 * modulo.
 *
 * `null` NON è un ripiego travestito: è «non lo so», e chi lo riceve deve dirlo
 * invece di indovinare. Ci si arriva solo da un `abort()` chiamato senza
 * argomenti (allora `reason` è una `DOMException` della piattaforma, non una
 * nostra causa), e da lì in poi il turno resta `cancelled` SENZA causa — che è
 * il ramo per cui `cancelledNotice` scrive comunque un cartello. La regola sta
 * qui e non presso i chiamanti perché la domanda è una: quel valore è una
 * nostra causa, o è la scatola vuota della piattaforma?
 */
export function stopCauseFromSignal(signal: { reason?: unknown } | undefined): StopCause | null {
  const r = signal?.reason;
  return isStopCause(r) ? r : null;
}

/* The list lives in `shared/ws-outbound.ts` and is imported at the top: this
 * was the THIRD copy of it (union + array + wire enum), and the third one was
 * the one left behind. */

export function isStopCause(value: unknown): value is StopCause {
  return typeof value === "string" && (STOP_CAUSES as readonly string[]).includes(value);
}

/**
 * Dall'errore con cui è morta la promise del turno. È la strada che percorrono
 * i marcatori interni del provider (`ABORTED`, `SESSION_RESET`, `PROCESS_DIED_n`,
 * `RATE_LIMIT`) e il tetto a orologio del dispatcher.
 */
export function classifyTurnError(err: unknown, fallbackCause?: StopCause): TurnEndInfo {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/wall-clock/i.test(msg)) return cancelled("wall-clock", msg);
  if (/^ABORTED$/.test(msg)) return cancelled(fallbackCause ?? "user", msg);
  if (/^SESSION_RESET$/.test(msg)) return cancelled("session-reset", msg);
  if (/^PROCESS_DIED/.test(msg)) return { end: "error", cause: "process-died", detail: msg };
  if (MAX_TOKENS_RE.test(msg)) return { end: "max_tokens", detail: msg };
  if (MAX_TURNS_RE.test(msg)) return { end: "max_turn_requests", detail: msg };
  if (REFUSAL_RE.test(msg)) return { end: "refusal", detail: msg };
  return { end: "error", cause: fallbackCause ?? "provider-error", detail: msg };
}

// ─────────────────────────────────────────────────────────────────────────
// Politica del dispatcher — la tabella, in un posto solo

/**
 * Il turno va ripreso da solo, o il task deve fermarsi?
 *
 * `refusal` è l'unico "no": riprovare identico ottiene lo stesso rifiuto, e
 * ripeterlo fino al tetto dei tentativi brucia il budget per finire comunque
 * in mano all'umano — tanto vale arrivarci subito, con la ragione scritta.
 */
export function shouldResume(info: TurnEndInfo): boolean {
  return info.end !== "refusal";
}

/**
 * Il turno costa un tentativo?
 *
 * Il piano dice «cancelled → nessun tentativo consumato», e per uno stop premuto
 * da un umano è giusto: non è un fallimento dell'agente. Ma il tetto a orologio
 * e il watchdog emettono lo STESSO `cancelled`, e sono l'unico freno contro un
 * task che gira in tondo: se non consumassero un tentativo, `retryCap` non
 * verrebbe mai raggiunto e la card ripartirebbe per sempre. Quindi la regola è
 * più stretta di com'è scritta nel piano — non consuma solo ciò che ha fermato
 * l'UMANO — e la differenza sta tutta nella causa, che è esattamente il motivo
 * per cui `StopCause` esiste.
 *
 * `session-reset` non consuma per un motivo diverso: la sessione `--resume` era
 * sparita, il provider rispawna e rimanda da solo. Non è un turno andato male,
 * è lo stesso turno che riparte.
 */
export function consumesAttempt(info: TurnEndInfo): boolean {
  if (info.end !== "cancelled") return true;
  return (
    info.cause !== "user" &&
    info.cause !== "session-reset" &&
    // `turn-in-flight`: la front-door ci ha respinti perché la sessione stava
    // già rispondendo. Non abbiamo guidato nessun turno, quindi non c'è nessun
    // tentativo da consumare — contarlo significherebbe parcheggiare FAILED un
    // task solo perché è arrivato mentre l'agente parlava.
    info.cause !== "turn-in-flight"
  );
}

/** Serve l'umano: nessun ritentativo automatico può sbloccarlo. */
export function needsHuman(info: TurnEndInfo): boolean {
  return info.end === "refusal";
}

/** Riga leggibile per il commento sulla card — al posto di «probabile timeout». */
export function describeTurnEnd(info: TurnEndInfo): string {
  switch (info.end) {
    case "end_turn":
      return "Turno concluso dall'agente senza portare il task in review";
    case "max_tokens":
      return "Contesto pieno (limite di token)";
    case "max_turn_requests":
      return "Turno esaurito: raggiunto il tetto di richieste al modello";
    case "refusal":
      return "Il modello si è rifiutato di procedere";
    case "cancelled":
      switch (info.cause) {
        case "user": return "Turno fermato a mano";
        case "watchdog": return "Turno fermato dal watchdog (nessun segno di vita dallo stream)";
        // No longer "it took too long": since 2026-08-21 the cap counts
        // SILENCE (see server/lib/turn-deadline.ts). The id stays `wall-clock`
        // because that value is already written across thousands of history rows
        // and recognised by `ripresa-automatica`; it was the SENTENCE that had
        // become false, and the sentence is what a person reads.
        case "wall-clock": return "Turno fermo: nessun segno di vita fino allo scadere";
        case "server-shutdown": return "Il server si è riavviato mentre il turno era in corso";
        case "stall": return "Turno riciclato: transcript muto da dispatchIdleMin, il giudice l'ha valutato incastrato";
        case "session-reset": return "Sessione persa e riavviata: stesso turno, processo nuovo";
        case "turn-in-flight": return "La sessione stava già rispondendo: turno non avviato";
        default: return "Turno annullato";
      }
    case "error":
      switch (info.cause) {
        case "process-died": return "Il processo dell'agente è morto";
        case "provider-error": return "Errore del provider";
        default: return "Turno finito in errore";
      }
  }
}
