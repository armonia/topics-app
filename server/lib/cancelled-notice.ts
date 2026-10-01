// cancelled-notice.ts — what stays written in chat when a turn gets
// CANCELLED, and what that depends on.
//
// WHY THIS EXISTS. `finalizeStream` treated "cancelled" as one single thing,
// and for a good reason: whoever presses Stop already knows they pressed it,
// so writing them "turn interrupted" would be noise, and the empty line that
// turn leaves behind is rightly discarded (`shared/empty-turn.ts`).
//
// Except the user is not the only one who cancels. On 20/08, on
// topic:9f9e9629, what did the cancelling was the server SHUTTING DOWN:
// fswatch saw a save in `server/`, `restart-when-idle` waited its 60-second
// cap for chats, then SIGTERM → `stopAllProviders()` → `abort()` on every
// live turn. The turn died mid-tool, the bubble closed exactly as it was —
// the last sentence written, no explanation, no button — and the log kept
// the line "stream aborted by user", the same lie written elsewhere.
//
// Whoever was watching saw a response cut off that never resumes.
//
// THE RULE. If a human did the cancelling, nothing gets written: they know.
// In every other case, WHY gets written. The ⚠️ prefix is what the client
// already recognizes (`turnError.ts`): amber banner, without touching a
// single line of client code.
//
// WHAT THE READER CAN DO ABOUT IT is not handled here, and that's not an
// oversight. The text used to always promise «"Retry" resends your
// message», but `turnIsOnlyError` only shows that button when the turn
// produced NOTHING — the right rule, because resending a message that was
// already half-answered would make a SECOND one, at a cost, on top of one
// that's already there. Since the frequent case is exactly a turn that died
// MID-work, the promise was almost always false: "I don't see any retry
// from the app" (20/08). `avvisoPerTurno`, at the bottom of this file,
// picks the right closing line.
//
// It is a pure function because it is a DECISION, and decisions get tested
// without starting a server: `finalizeStream` sits inside a 3000-line route
// with a real provider attached, and a rule that only lives in there is a
// rule nobody ever questions again.

import type { TurnEndInfo } from "../providers/stop-reason";

/**
 * Il cartello da lasciare su un turno annullato, o `null` se il silenzio è la
 * risposta giusta.
 *
 * `null` significa DUE cose insieme, ed è voluto: niente da scrivere, e niente
 * che impedisca di buttare la riga se è rimasta vuota. Un turno fermato a mano
 * prima di qualsiasi output non deve lasciare traccia; ogni altro deve.
 */
export function cancelledNotice(info: TurnEndInfo): string | null {
  if (info.end !== "cancelled") return null;
  switch (info.cause) {
    // L'ha fermato lui. Dirglielo sarebbe raccontargli cos'ha appena fatto.
    case "user":
      return null;
    // La sessione `--resume` era sparita e il provider rispawna da solo
    // rimandando lo stesso turno: non è una fine, è una ripartenza. Un cartello
    // qui annuncerebbe un guasto a chi sta per ricevere la risposta.
    case "session-reset":
      return null;
    // Non abbiamo guidato nessun turno: la front-door ha respinto perché la
    // sessione stava già rispondendo. Non c'è niente di interrotto da spiegare.
    case "turn-in-flight":
      return null;
    case "server-shutdown":
      return (
        "⚠️ Turno interrotto: il server si è riavviato mentre la risposta era in corso."
      );
    case "watchdog":
      return (
        "⚠️ Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa."
      );
    case "wall-clock":
      return (
        "⚠️ Turno interrotto: era fermo da troppo, senza un segno di vita dallo stream."
      );
    // Un annullamento senza causa dichiarata. NON si tace: il silenzio è
    // riservato ai casi che sappiamo innocui, e questo non è tra quelli — è
    // esattamente la forma che aveva il difetto del 20/08, un `cancelled` di
    // provenienza ignota trattato come se l'avesse chiesto l'utente.
    default:
      return (
        "⚠️ Turno interrotto prima della fine."
      );
  }
}

/**
 * La frase corta per il registro (`activity_log`), che prima diceva sempre
 * «stream aborted by user».
 *
 * Un registro che attribuisce a una persona ciò che ha fatto una macchina non
 * è impreciso: è la ragione per cui, cercando quel turno, si guarda dalla parte
 * sbagliata. Rimane volutamente in inglese come le altre voci di categoria.
 */
export function abortLogTitle(info: TurnEndInfo): string {
  if (info.end !== "cancelled") return "stream aborted";
  switch (info.cause) {
    case "user": return USER_ABORT_LOG_TITLE;
    case "watchdog": return "stream aborted by watchdog";
    case "wall-clock": return "stream aborted by wall-clock cap";
    case "server-shutdown": return "stream aborted by server shutdown";
    case "session-reset": return "stream aborted by session reset";
    case "turn-in-flight": return "stream not started (turn already in flight)";
    case "stall": return "stream aborted by the stall judge";
    case "superseded": return "stream aborted: superseded (landed, revoked, or a newer turn)";
    default: return "stream aborted";
  }
}

/**
 * The two `activity_log` titles that say a PERSON stopped a turn, and the only
 * durable trace of it: the turn-end registry lives in memory and the server
 * reloads on every save. `finalizeStream` writes the first through
 * `abortLogTitle`, but only if it is still open when the provider reports the
 * abort; `/api/chat/abort` writes the second itself, before telling anyone.
 * The resume sweep reads both (`lib/ripresa-boot.ts`).
 */
export const USER_ABORT_LOG_TITLE = "stream aborted by user";
export const STOP_PRESSED_LOG_TITLE = "stop pressed by user";

/**
 * Il cartello COMPLETO: il perché, più l'unica cosa che chi legge può fare.
 *
 * Sono due frasi diverse a seconda che il turno abbia prodotto qualcosa, perché
 * è esattamente quello che decide se il bottone «Riprova» compare. Prometterlo
 * a chi non ce l'ha è peggio che tacere: lo manda a cercare un bottone che non
 * esiste.
 *
 * `riprendeDaSolo` vince su tutto: se il server si riprenderà il turno da sé
 * (`lib/ripresa-boot.ts`), chiedere all'utente un gesto è rumore — e rischia di
 * fargli spendere un turno in più per una cosa che stava già succedendo.
 */
export function avvisoPerTurno(
  info: TurnEndInfo,
  opts: { haProdotto: boolean; riprendeDaSolo?: boolean },
): string | null {
  // THE API STAYED SATURATED. Not a verdict on the message and not the
  // agent's doing: the same turn goes through once the account's limit frees,
  // so the notice is one of ours and the resume (`ripresa-boot.ts` for a chat,
  // the dispatcher for a card) picks it up. One sentence for both cases: what
  // was produced stays, nobody is asked to press anything.
  if (info.end === "error" && info.cause === "rate-limit") return rateLimitNotice(info.detail);
  // AN OUTAGE OUTSIDE THE TURN, the API or the daemon hosting the agent.
  // Nobody's doing and not deterministic: the sweep resends it (the API's once
  // it answers again), and then nobody is asked to press. Only the direct
  // answer to the person's message is resent (`outageCutNotResent`); any other
  // row cut that way gets a notice that promises nothing.
  if (info.end === "error" && info.cause === "api-unavailable") {
    return opts.riprendeDaSolo ? API_UNAVAILABLE_NOTICE : `${API_UNAVAILABLE_OPENING} ${OUTAGE_NO_RESUME}`;
  }
  if (info.end === "error" && info.cause === "broker-died") {
    return opts.riprendeDaSolo ? BROKER_DIED_NOTICE : `${BROKER_DIED_OPENING} ${OUTAGE_NO_RESUME}`;
  }
  // A TURN CUT BY THE OUTPUT CAP IS NOT A FINISHED TURN.
  //
  // Measured on 2026-08-28 on topic:4c935add, three times out of three. The model
  // was writing a whole document INSIDE the argument of a `write_file`, blew
  // through `max_tokens` halfway into the JSON, and from there: the truncated
  // arguments would not parse, the tool never ran, and the round exited as if it
  // had finished. Nothing appeared in the chat — no notice, no "Retry" — and the
  // tool kept a green tick on a write that never happened. What the user saw was
  // a chat stopping for no reason and a file that does not exist.
  //
  // "Retry" would be the wrong advice here: resending the same message blows
  // through the same cap. The tail says the only thing that changes the outcome.
  if (info.end === "max_tokens") {
    const perche = "⚠️ Risposta tagliata: ha raggiunto il limite di lunghezza di un singolo turno.";
    return opts.haProdotto
      ? `${perche} Quello che era già arrivato resta qui sotto: chiedi il resto un pezzo alla volta.`
      : `${perche} Richiedila divisa in più pezzi, o falla scrivere su file a blocchi invece che tutta in una volta.`;
  }
  // THE MODEL SAID NO, AND THE REASON IS THE ONLY USEFUL PART.
  //
  // A refusal comes back as HTTP 200 with zero content blocks, so before this
  // it was indistinguishable from an empty turn and got the generic «no
  // answer — Retry resends your message» notice. That advice is wrong twice
  // over: an identical request buys the identical refusal, and the verdict is
  // on the CONVERSATION, not on the last message. Measured on topic:06519a5d,
  // where the trigger was a passage the history repeated verbatim: the person
  // pressed Retry six times over two days against a wall nobody had named.
  // allow-italian: quotes the notice this branch replaces
  //
  // `info.detail` is the API's own sentence (`stop_details.explanation`), kept
  // by `native/agent-loop.ts`. When it is missing the notice still says what
  // happened: a refusal without a reason beats a silence.
  if (info.end === "refusal") {
    const perche = info.detail?.trim()
      ? `⚠️ Richiesta rifiutata dal modello: ${info.detail.trim()}`
      : "⚠️ Richiesta rifiutata dal modello, senza spiegazione.";
    // "BELOW" SENT THE READER LOOKING FOR CONTENT THAT IS ABOVE.
    //
    // The notice is the LAST block in the bubble, so everything already
    // produced precedes it. The reported turn had 18 blocks above and none
    // below. This applies to every productive-notice branch here: the verdict
    // closes the bubble. The recovery path still matters because waiting does
    // not clear a refusal and retrying the same message cannot help.
    return opts.haProdotto
      ? `${perche} Quello che era già arrivato resta qui sopra: rimandare lo stesso messaggio ottiene lo stesso rifiuto, riformulalo.`
      : `${perche} Rimandare lo stesso messaggio ottiene lo stesso rifiuto: riformulalo, oppure continua in una chat nuova se è la conversazione intera a essere rifiutata.`;
  }
  const perche = cancelledNotice(info);
  if (!perche) return null;
  if (opts.riprendeDaSolo) return `${perche} Riprendo da solo: non serve che tu faccia niente.`;
  return opts.haProdotto
    ? `${perche} Quello che era già arrivato resta qui sotto: se ti serve il resto, chiedilo con un nuovo messaggio.`
    : `${perche} «Riprova» rimanda il tuo messaggio.`;
}

/**
 * Questo testo è un CARTELLO DI INTERRUZIONE scritto da noi?
 *
 * Serve a chi deve decidere se un turno merita una ripresa automatica leggendo
 * la riga già salvata, cioè quando la `StopCause` non c'è più: nel database
 * resta il blocco `error` col testo, non la causa che l'ha prodotto.
 *
 * PERCHÉ NON BASTA `kind === "error"`, ed è un difetto misurato. In quel blocco
 * ci finisce OGNI verdetto di guasto, e sul database vivo gli ultimi messaggi
 * con un blocco `error` erano: 25 «ai-bridge: ack timeout», 4 «Process exited
 * with code», 1 «API 400». Nessuno di questi è un'interruzione nostra: sono
 * guasti deterministici, e rimandare il messaggio ricompra lo stesso
 * fallimento — su un turno lungo, riaprendo tutti i giri di tool che aveva già
 * fatto.
 *
 * I testi sono quelli di `cancelledNotice` qui sopra e stanno nello stesso
 * file APPOSTA: chi cambia una frase vede subito chi la legge. La regola
 * autorevole resta `isResumableCause` (qui sotto), che legge il campo `cause`
 * del blocco; questa è la lettura di ripiego per le righe già
 * scritte, ed è volutamente STRETTA — un falso negativo lascia un cartello con
 * il bottone «Riprova», che è reversibile; un falso positivo brucia un turno.
 */
export function eCartelloDiInterruzione(testo: string | null | undefined): boolean {
  const t = (testo ?? "").trim().replace(/^⚠️\s*/, "");
  if (!t) return false;
  return CARTELLI_RIPRENDIBILI.some((c) => t.startsWith(c));
}

/**
 * Does this notice say the SERVER restarted under the turn? The two openings
 * that do, both already in `CARTELLI_RIPRENDIBILI`: the graceful shutdown's
 * and the boot sweep's (`RESTART_INTERRUPTED_MARKER`, written with no `cause`
 * and a timestamp after the boot, so only its text tells a hard kill apart).
 */
export function isRestartNotice(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().replace(/^⚠️\s*/, "");
  return RESTART_OPENINGS.some((opening) => t.startsWith(opening));
}

const RESTART_OPENINGS = [
  "Turno interrotto: il server si è riavviato",
  "Turno interrotto da un riavvio del server",
] as const;

/**
 * The causes that come from an interruption of OURS: the shutdown, the
 * watchdog and the silence cap. `cancelledNotice`'s `default` branch (cancelled
 * with no declared cause) stays OUT: you do not guess who cancelled.
 */
export const CAUSE_NOSTRE = ["server-shutdown", "watchdog", "wall-clock"] as const;

/**
 * Is this stop cause one the machine owns, i.e. one the resume may act on?
 * Our three cuts, plus the ends that are not deterministic faults: an API
 * limit that frees itself (`rate-limit`), an API or a daemon that went away
 * (`api-unavailable`, `broker-died`), and OUR budget of tool rounds
 * (`tool-budget`, whose live resume is in services/goal-continuation.ts; this
 * covers the row when a restart lands between the cut and that resume).
 *
 * Read off the block's `cause` FIELD, next to the text: the sentences change
 * wording (four different ones say "the server restarted"), the cause does not.
 * A `cancelled` with no cause stays out: you do not guess who cancelled.
 */
export function isResumableCause(cause: unknown): boolean {
  return typeof cause === "string"
    && ((CAUSE_NOSTRE as readonly string[]).includes(cause) || isOutsideCause(cause));
}

/**
 * The ends that are not ours and not deterministic either: the API's limit, an
 * API that stopped answering, the daemon hosting the agent going away (card
 * e30f35e4 and 51fb9359, 25/09), and our own budget of tool rounds. Each one
 * ends the turn in `error`, which is what the dispatcher resumes on a card
 * after its backoff (`resumeVerdict` leaves those to it).
 */
const OUTSIDE_CAUSES = ["rate-limit", "tool-budget", "api-unavailable", "broker-died"] as const;

/** A resumable cut that ended the turn in error (`OUTSIDE_CAUSES`). */
export function isOutsideCause(cause: unknown): boolean {
  return typeof cause === "string" && (OUTSIDE_CAUSES as readonly string[]).includes(cause);
}

/** The two outages outside the turn: the API stopped answering, the ai-bridge daemon died. */
export function isOutage(cause: unknown): boolean {
  return cause === "api-unavailable" || cause === "broker-died";
}

/**
 * AN OUTAGE'S CUT IS RESENT ONLY WHERE IT IS THE DIRECT ANSWER TO THE PERSON'S
 * MESSAGE (cards e30f35e4, 51fb9359).
 *
 * The resend is the person's last message. The outages made rows resumable
 * that never were, and any of them that is not that message's own answer (a
 * wake a background task or a Monitor opened after the answer, a turn under a
 * regenerated reply) runs an answered message a second time when resent: a
 * paid turn and every effect again. Telling them apart by the thread's shape
 * did not converge: each shape it closed opened another. So the rule is
 * narrow on purpose: an outage's cut is resent only when `directAnswer` says
 * the cut row answers the person's message (its parent is a user row the
 * person wrote, not a row the machine wrote nor a /compact already carried
 * out) and is the chat's last word as the sweep picks it
 * (lib/ripresa-boot.ts). A `woken` mark on the row still says no on its own.
 * Every other shape asks the person, who retries. A cut of ours (a restart, a
 * stall) keeps the rule it always had.
 *
 * The sweep (`resumeVerdict`) and every writer of the notice
 * (`resumesByItself`) read this one rule. A writer's `directAnswer` is also
 * true on the chat of a card in progress (`outageCutPickedUp`): the
 * dispatcher resumes that turn, and the sweep leaves it to it. `directAnswer`
 * is asked only for an outage, since it reads the database. The notice reads it when the cut is
 * written, so a row that lands under the cut afterwards leaves a promise the
 * sweep does not keep, accepted: a sub-agent's report, or a wake the CLI opens
 * when background work the turn launched ends (a Bash in the background, a
 * Monitor) while the CLI, alive after an `api-unavailable`, waits. The sweep
 * judges that row and never resends the message, and the failure push stayed
 * muted by the promise; the person retries. `broker-died` has no such wake:
 * the child and its background work die with the daemon.
 */
export function outageCutNotResent(
  cause: unknown, blocks: readonly unknown[] | null | undefined, directAnswer: () => boolean,
): boolean {
  if (!isOutage(cause)) return false;
  // A `run_command` wake's banner is not the CLI's wake: that turn answers a
  // row of Topics, which resends it itself after an outage (process-exit-wake.ts).
  return !!blocks?.some((b) => {
    const mark = b as { kind?: unknown; source?: unknown } | null;
    return mark?.kind === "woken" && mark.source !== "command";
  }) || !directAnswer();
}

/** The sweep resends a turn cut with this cause, on a row with these blocks. */
export function resumesByItself(
  cause: unknown, blocks: readonly unknown[] | null | undefined, directAnswer: () => boolean,
): boolean {
  return isResumableCause(cause) && !outageCutNotResent(cause, blocks, directAnswer);
}

const API_UNAVAILABLE_OPENING = "⚠️ Turno interrotto: l'API di Claude non rispondeva più.";
const BROKER_DIED_OPENING = "⚠️ Turno interrotto: si è fermato il processo che ospitava l'agente (ai-bridge).";
const OUTAGE_NO_RESUME = "Se ti serve che continui, scriviglielo in un nuovo messaggio.";

/** The notice for a turn the API left unanswered (`api-unavailable`). */
export const API_UNAVAILABLE_NOTICE = `${API_UNAVAILABLE_OPENING} Riprende da solo appena torna a rispondere.`;

/** The notice for a turn whose ai-bridge daemon died under it (`broker-died`). */
export const BROKER_DIED_NOTICE = `${BROKER_DIED_OPENING} Riprende da solo.`;

/** Whether a turn's notice is an outage's that promises the resume: the same
 *  outage anywhere but the direct answer asks the person instead
 *  (`outageCutNotResent`). */
export function outageNoticeResumes(text: string): boolean {
  return text === API_UNAVAILABLE_NOTICE || text === BROKER_DIED_NOTICE;
}

/**
 * The notice for a turn that died with the API's limit still saturated after
 * every retry. Written by `avvisoPerTurno` in place of the raw "API 429 ..."
 * text (which stays in the server log), and recognised below so the resume
 * resends the message once the limit frees.
 */
export const RATE_LIMIT_NOTICE =
  "⚠️ Turno interrotto: il limite di richieste dell'API è rimasto saturo per tutti i tentativi. Riprende da solo appena si libera.";

/**
 * The same notice with the HOUR on it, when the runtime knew one: a spent
 * usage window ends at a published time (`usage-window.ts`), and the hour is
 * the one thing the reader wants to know. The opening is the same prefix, so
 * the resume recognises both.
 */
export function rateLimitNotice(detail: string | undefined): string {
  const m = /resets at (\S+)/.exec(detail ?? "");
  const at = m ? Date.parse(m[1]) : NaN;
  if (!Number.isFinite(at)) return RATE_LIMIT_NOTICE;
  const ora = new Date(at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  return `⚠️ Turno interrotto: il limite di richieste dell'API è esaurito fino alle ${ora} (finestra di utilizzo del piano). Riprende da solo dopo quell'ora.`;
}

/**
 * The recognised openings. An EXPLICIT list, and it has to be.
 *
 * Deriving it from `cancelledNotice` looks cleaner and is wrong: rows already in
 * the database carry OLDER wordings of the same notice, and a list derived from
 * today's text stops recognising yesterday's. Auto-resume would quietly skip
 * every turn interrupted before the last rewrite. So history stays written here,
 * and entries are only ever ADDED.
 *
 * What keeps this list honest is not the list, it is the test next to it: it
 * asserts that every notice `cancelledNotice` produces today is recognised. That
 * is the check that caught the 2026-08-21 rewording, when the cap stopped
 * counting elapsed time and its sentence had to change. Without that test the
 * only symptom would have been turns that silently never restart.
 *
 * Prefixes stop at the stable part of each sentence, before the tail that gets
 * reworded.
 */
const CARTELLI_RIPRENDIBILI = [
  "Turno interrotto: il server si è riavviato",
  "Turno interrotto: il processo dell'agente non dava più segni di vita",
  // Wording up to 2026-08-21, when the cap counted elapsed time.
  "Turno interrotto: ha superato il limite di tempo",
  // From 2026-08-21: the cap counts silence, so the sentence had to say so.
  "Turno interrotto: era fermo da troppo",
  // The BOOT wording, and it is a different sentence for the same fact: this
  // one is written by `boot-partial-sweep.ts` when the server comes back and
  // finds a turn that died with it. It was missing here, so the notice the
  // boot wrote was the one notice the resume could not act on - which is the
  // exact case the resume exists for.
  "Turno interrotto da un riavvio del server",
  // From 2026-09-04: the API's rate limit exhausted every retry. The turn is
  // resumable BECAUSE the failure is not deterministic - see `RATE_LIMIT_NOTICE`.
  "Turno interrotto: il limite di richieste dell'API",
  // The stale-stream sweeper's own notice (`INTERRUPTED_MARKER` in
  // lib/stale-stream-sweep.ts): the one cut that is entirely ours and was NEVER
  // resumed, because this list did not know its opening words. Measured
  // 05/09/2026: every chat the sweeper closed sat under the retry button until
  // somebody clicked. Rows written before this date carry only the text (the
  // `cause` field on the block exists since 2026-09-03), so the prefix is what
  // reaches them; newer rows are also recognised by cause (`isResumableCause`).
  "Risposta interrotta: nessuna attività per",
  // The tool-round budget of the native runtime (`MAX_ITERATIONS` in
  // providers/native/agent-loop.ts). Rows written before 05/09/2026 carry this
  // text with no `cause`: topic 514354ce sat idle for hours on it while its
  // goal was still open. Newer rows also carry `cause: "tool-budget"`.
  "il turno ha esaurito i",
  // From 25/09/2026: the resume sweep's notice for a person's message nobody
  // answered, when no restart happened (`UNANSWERED_NO_RESTART_NOTICE` in
  // lib/resume-notices.ts). It becomes the row the resend is traced on, so the
  // next sweep has to read it as ours.
  "Turno interrotto: la risposta non è mai arrivata",
  // From 27/09/2026: an API that stopped answering, and the daemon hosting the
  // agent that died (`API_UNAVAILABLE_NOTICE`, `BROKER_DIED_NOTICE`).
  "Turno interrotto: l'API di Claude non rispondeva",
  "Turno interrotto: si è fermato il processo che ospitava l'agente",
  // The claude-code send watchdog's bare text, up to 27/09/2026: no cause on
  // the block, so no sweep resent it (row 5e92d06e, topic 3019832f, 25/09: 52
  // minutes stopped until a person resent by hand).
  "Nessuna attività dal modello per 30 minuti",
] as const;
