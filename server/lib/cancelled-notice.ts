// cancelled-notice.ts — che cosa resta scritto in chat quando un turno viene
// ANNULLATO, e da chi dipende.
//
// PERCHÉ ESISTE. `finalizeStream` trattava «annullato» come una cosa sola, e
// per una ragione buona: chi preme Ferma sa già di aver premuto, quindi
// scrivergli «turno interrotto» sarebbe rumore, e la riga vuota che quel turno
// lascia viene giustamente buttata (`shared/empty-turn.ts`).
//
// Solo che l'utente non è l'unico che annulla. Il 20/08, su topic:9f9e9629, ad
// annullare è stato lo SPEGNIMENTO del server: fswatch ha visto un salvataggio
// in `server/`, `restart-when-idle` ha atteso i suoi 60 secondi di cap per le
// chat, poi SIGTERM → `stopAllProviders()` → `abort()` su ogni turno vivo. Il
// turno è morto a metà di un tool, la bolla si è chiusa così com'era — l'ultima
// frase scritta, nessuna spiegazione, nessun bottone — e nel log è rimasta la
// riga «stream aborted by user», che è la stessa bugia scritta altrove.
//
// Chi guardava ha visto una risposta che si interrompe e non riprende più.
//
// LA REGOLA. Se ad annullare è stato l'umano non si scrive niente: lo sa. In
// ogni altro caso si scrive PERCHÉ. Il prefisso ⚠️ è quello che il client già
// riconosce (`turnError.ts`): banner ambra, senza toccare una riga di client.
//
// COSA PUÒ FARCI CHI LEGGE non sta qui, e non è una dimenticanza. Il testo
// prometteva sempre «"Riprova" rimanda il tuo messaggio», ma quel bottone lo
// mostra `turnIsOnlyError` solo se il turno NON ha prodotto niente — regola
// giusta, perché rimandare un messaggio già risposto a metà ne farebbe un
// SECONDO, a pagamento, sopra uno che è già lì. Siccome il caso frequente è
// proprio il turno morto a METÀ lavoro, la promessa era quasi sempre falsa:
// «non vedo dall'app nessun riprova» (20/08). La coda giusta la sceglie
// `avvisoPerTurno`, in fondo a questo file.
//
// È una funzione pura perché è una DECISIONE, e le decisioni si provano senza
// avviare un server: `finalizeStream` è dentro una route di 3000 righe con un
// provider vero attaccato, e una regola che vive solo lì dentro è una regola
// che nessuno rimette in discussione.

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
    case "user": return "stream aborted by user";
    case "watchdog": return "stream aborted by watchdog";
    case "wall-clock": return "stream aborted by wall-clock cap";
    case "server-shutdown": return "stream aborted by server shutdown";
    case "session-reset": return "stream aborted by session reset";
    case "turn-in-flight": return "stream not started (turn already in flight)";
    case "superseded": return "stream aborted by a newer turn on the same session";
    default: return "stream aborted";
  }
}

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
 * autorevole resta `meritaRipresaAutomatica` (`ripresa-automatica.ts`), che
 * gira sulla `StopCause`; questa è la lettura di ripiego per le righe già
 * scritte, ed è volutamente STRETTA — un falso negativo lascia un cartello con
 * il bottone «Riprova», che è reversibile; un falso positivo brucia un turno.
 */
export function eCartelloDiInterruzione(testo: string | null | undefined): boolean {
  const t = (testo ?? "").trim().replace(/^⚠️\s*/, "");
  if (!t) return false;
  return CARTELLI_RIPRENDIBILI.some((c) => t.startsWith(c));
}

/**
 * The causes that come from an interruption of OURS, i.e. the same three
 * `CAUSE_DA_RIPRENDERE` admits. `cancelledNotice`'s `default` branch (cancelled
 * with no declared cause) stays OUT, for the same reason
 * `meritaRipresaAutomatica` excludes it: you do not guess who cancelled.
 */
export const CAUSE_NOSTRE = ["server-shutdown", "watchdog", "wall-clock"] as const;

/**
 * Is this stop cause one the machine owns, i.e. one the resume may act on?
 * Our three cuts, plus the two ends that are not deterministic faults: an API
 * limit that frees itself (`rate-limit`) and OUR budget of tool rounds
 * (`tool-budget`, whose live resume is in services/goal-continuation.ts; this
 * covers the row when a restart lands between the cut and that resume).
 *
 * Read off the block's `cause` FIELD, next to the text: the sentences change
 * wording (four different ones say "the server restarted"), the cause does not.
 * A `cancelled` with no cause stays out: you do not guess who cancelled.
 */
export function isResumableCause(cause: unknown): boolean {
  return typeof cause === "string"
    && ((CAUSE_NOSTRE as readonly string[]).includes(cause) || cause === "rate-limit" || cause === "tool-budget");
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
] as const;
