// board-ask-routing.ts — una domanda posta DENTRO un task esce nel THREAD del task.
//
// IL DIFETTO CHE CHIUDE. Un agente che chiede a metà turno (`ask_user_question`,
// o una figlia che si ferma su un bivio) si SEGNALA sulla card: chip
// `needs_input`, badge «aspetta te». Ma il pannello con la domanda vive nel tab
// della sessione, quindi per RISPONDERE bisogna aprire quel tab. Sulla board si
// vede che qualcuno aspetta e non si vede cosa vuole: il posto dove si guarda e
// il posto dove si risponde sono due, e il secondo lo si trova solo se si sa
// che esiste. Col modello del coordinatore diventa peggio, perché la sessione
// che si ferma può essere una FIGLIA, e il suo tab non lo apre mai nessuno.
//
// COSA FA. Quando una sessione che appartiene a un task apre una domanda, la
// domanda viene scritta nel thread del task come commento con `options` — cioè
// nella forma che la card già rende come tasti di risposta rapida. Quando una
// persona risponde da lì, la risposta torna al rendez-vous della sessione che
// aveva chiesto (`deliverAnswer`), e quella riparte. Nessun tab da aprire, e la
// domanda resta scritta nel thread accanto alla decisione che ha prodotto.
//
// PERCHÉ UN MODULO E NON DUE RIGHE ALLE DUE ROTTE. I due lati del giro stanno
// in due file lontani (la gamba dell'attesa in `routes/permission.ts`, il
// commento umano in `routes/tasks.ts`) e devono concordare su una cosa sola: il
// registro di chi sta aspettando. Un registro tenuto da una delle due rotte
// sarebbe un accoppiamento nascosto fra loro; qui è il perno dichiarato, e si
// prova senza alzare un server.

import type { Database } from "bun:sqlite";
import { cancelAsk, hasPendingAsk } from "../lib/ask-user-bridge";
import { boardTaskForSession } from "./agent-census";

/** Una domanda in attesa di risposta dal thread di un task. */
interface RoutedAsk {
  /**
   * THE ID OF THIS QUESTION, and it is the thread row that carries it.
   *
   * Not a counter of our own: whoever answers CLICKS a comment, so the only id
   * both sides can NAME is that comment's. The card sends it back (`answerTo`)
   * and `answerRoutedAsk` compares the two: a yes read on a question that is no
   * longer the open one does not count as a yes.
   */
  askId: string;
  sessionKey: string;
  /** La chiave con cui il chiamante si aspetta la risposta (`answers[key]`). */
  questionKey: string;
  /** The text already in the thread: two legs of one ask repeat it verbatim. */
  text: string;
  /** Le etichette offerte, per riconoscere una risposta che è una scelta. */
  options: string[];
  /** Chi ha chiesto: il coordinatore stesso o una sua figlia. */
  isChild: boolean;
  askedAt: number;
}

/**
 * taskId -> the open question. ONE per task, and not as a simplification: the
 * card draws a single quick-reply block, so two questions at once would be two
 * rows of buttons piled on the same line.
 *
 * WHO REPLACES WHOM, and why it is no longer "always the second one". This
 * registry is keyed by TASK, and two sessions of one task exist BY
 * CONSTRUCTION: `boardTaskForSession` maps a coordinator and its children onto
 * the same taskId on purpose. While a second question evicted the first without
 * looking, two open send confirmations collapsed into ONE block of buttons and
 * `answerRoutedAsk` delivered under the CURRENT key: the person read
 * the first message on screen, answered with the confirm button, and a
 * different message left for a different recipient. Reproduced.
 *
 * The rule now asks whether the old one is ALIVE, and that fact belongs to the
 * rendez-vous (`hasPendingAsk`), not to this module:
 *
 *   - SAME SESSION -> always replaces. The CLI blocks a turn on one question at
 *     a time, so a new question from the same session says by construction that
 *     the previous one is over (an interrupted turn, for instance).
 *   - ANOTHER SESSION, and somebody is still waiting on the old one -> the new
 *     one does NOT come out and its caller gets `busy`. Two open questions on
 *     one card are the defect, not the case to handle.
 *   - ANOTHER SESSION, and nobody waits on the old one -> it is replaced, with
 *     a line of its own in the thread and a `cancelAsk` on the session that
 *     lost the card, so a straggler leg fails with its own reason instead of
 *     collecting the yes given to another question.
 */
const routed = new Map<string, RoutedAsk>();

/** The line that closes a replaced question: the text changes, and says so. */
const SUPERSEDED_LINE =
  "La domanda qui sopra non aspetta più una risposta: la sostituisce quella qui sotto.";

/** Why a session that lost the card must not collect a yes any more. */
const SUPERSEDED_CANCEL =
  "the question was replaced on the card: nobody was waiting on it any more";

export interface AskRoutingDeps {
  db: Database;
  /**
   * Writes the comment in the thread and returns its ID; `null` when it could
   * not.
   *
   * THE ID IS NOT A LUXURY: it is what the card sends back when a person clicks
   * a quick reply, and it is the only way to know WHICH question they answered.
   * While this returned a boolean, the registry only knew that ONE question was
   * open, and the yes always went to the latest entry.
   */
  comment: (args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => string | null;
  /** Consegna la risposta al rendez-vous della sessione che aspetta. */
  deliver: (sessionKey: string, answers: Record<string, string>) => boolean;
}

/** Una domanda come la porta il bridge: testo + opzioni, la chiave è la sua id. */
export interface AskQuestion {
  key?: unknown;
  header?: unknown;
  question?: unknown;
  options?: unknown;
}

/** Normalizza la prima domanda di un `ask_user_question` in testo + opzioni. */
export function normalizeAsk(questions: readonly AskQuestion[]): {
  key: string;
  text: string;
  options: string[];
} | null {
  const q = questions[0];
  if (!q) return null;
  const text = typeof q.question === "string" && q.question.trim() ? q.question.trim() : "";
  if (!text) return null;
  const key = typeof q.key === "string" && q.key ? q.key : typeof q.header === "string" && q.header ? q.header : "answer";
  const options = Array.isArray(q.options)
    ? q.options
        .map((o) => (typeof o === "string" ? o : (o as { label?: unknown })?.label))
        .filter((l): l is string => typeof l === "string" && !!l.trim())
        .map((l) => l.trim())
    : [];
  return { key, text, options };
}

/** Where the question went, and whether it is REALLY there. */
export interface RoutedAskOutcome {
  taskId: string;
  projectId: string;
  /**
   * The question is in the thread: written just now, or written by an earlier
   * leg of the same rendez-vous.
   *
   * IT EXISTS BECAUSE THE RETURN VALUE USED TO LIE. Callers read it as "the
   * person was asked" - the outbound gate sets `asked = true` on it - while
   * this function also returned the task when it wrote NOTHING, i.e. whenever
   * the registry still held an entry for this session. One question left open
   * by an interrupted turn therefore made every later confirmation mute: the
   * POST answered `pending`, the card kept showing the old question, and the
   * tool burnt its 600 legs on a confirmation nobody could see.
   */
  shown: boolean;
  /**
   * The id an answer must carry to reach THIS question. Present when `shown`,
   * absent when there is no open question to name.
   */
  askId?: string;
  /**
   * THE CARD IS ALREADY TAKEN by a live question of ANOTHER session, and this
   * one did not come out. The caller decides what to do, and the two right
   * answers differ:
   *
   *   - `ask_user_question` (routes/permission.ts) WAITS ITS TURN. The bridge
   *     comes back through here every 25 seconds with the same question until
   *     somebody answers the first one: the turn is already parked on a person,
   *     so waiting loses nothing and costs no extra line in the thread.
   *   - a send confirmation (lib/outbound-gate.ts) REFUSES. Something
   *     irreversible must not sit queued in silence behind another question for
   *     hours: the agent gets a refusal it can report, and the person keeps ONE
   *     confirmation to read.
   */
  busy?: { sessionKey: string; askedAt: number };
}

/**
 * La domanda esce nel thread del task, se questa sessione ne ha uno.
 *
 * Restituisce il task su cui è uscita, o `null` quando la sessione non
 * appartiene a nessun task: una chat dell'umano continua a fare quello che ha
 * sempre fatto, cioè mostrare il pannello nel suo tab e basta.
 *
 * WHO REPLACES WHOM is written on `routed`, and in short: the same session
 * always replaces (the CLI blocks on one question at a time), another session
 * replaces only when nobody waits on the old one, and otherwise this returns
 * `busy` without writing anything. The replaced question is closed with a line
 * of its own - a quick-reply block whose text changes under the reader without
 * a word is worse than silence - and with a `cancelAsk`, because its send must
 * fail with its own trace instead of hanging.
 */
export function routeAskToTaskThread(
  deps: AskRoutingDeps,
  args: { sessionKey: string; questions: readonly AskQuestion[] },
): RoutedAskOutcome | null {
  const owner = boardTaskForSession(deps.db, args.sessionKey);
  if (!owner) return null;
  const q = normalizeAsk(args.questions);
  if (!q) return null;
  const open = routed.get(owner.taskId);
  // Già instradata. Il rendez-vous è a gambe corte: la stessa domanda ripassa
  // di qui ogni pochi secondi finché nessuno risponde, e senza questa riga
  // scriverebbe una copia per gamba.
  // Same question means same key AND same text: two questions in a row under
  // the default key would otherwise be one, and the second would never come out.
  if (open && open.sessionKey === args.sessionKey && open.questionKey === q.key && open.text === q.text) {
    return { taskId: owner.taskId, projectId: owner.projectId, shown: true, askId: open.askId };
  }
  if (open) {
    // THE OLD ONE IS ALIVE AND NOT OURS: the card stays hers. No write, no
    // change to the registry - a `routed.set` here IS the defect, because the
    // yes the person is about to give to the question on screen would be
    // delivered to this one instead.
    if (open.sessionKey !== args.sessionKey && hasPendingAsk(open.sessionKey)) {
      return {
        taskId: owner.taskId,
        projectId: owner.projectId,
        shown: false,
        busy: { sessionKey: open.sessionKey, askedAt: open.askedAt },
      };
    }
    deps.comment({
      taskId: owner.taskId,
      projectId: owner.projectId,
      content: SUPERSEDED_LINE,
      options: [],
      // Anchored to WHO asked it, not to who replaces it: the line closes the
      // old question, and under the new session it would sit in the wrong
      // place. This branch used to exist for the same session only, so a
      // replacement across sessions left no line at all.
      sessionKey: open.sessionKey,
    });
    routed.delete(owner.taskId);
    // The other session's leftover must not collect a yes given to us: if it
    // comes back, it fails with its own reason. Not on the same session - the
    // rendez-vous about to open is its own.
    if (open.sessionKey !== args.sessionKey) cancelAsk(open.sessionKey, SUPERSEDED_CANCEL);
  }
  // Chi chiede va detto: «la sessione di lavoro chiede» e «il coordinatore
  // chiede» portano a due risposte diverse, e nel thread si vede solo il testo.
  const intro = owner.isChild ? "Una sessione di lavoro di questo task chiede:" : "Domanda a meta' turno:";
  const ok = deps.comment({
    taskId: owner.taskId,
    projectId: owner.projectId,
    content: `${intro}\n\n${q.text}`,
    options: q.options,
    // The session the question came from: the writer turns it into the anchor
    // of the assistant row that asked.
    sessionKey: args.sessionKey,
  });
  if (!ok) return { taskId: owner.taskId, projectId: owner.projectId, shown: false };
  routed.set(owner.taskId, {
    askId: ok,
    sessionKey: args.sessionKey,
    questionKey: q.key,
    text: q.text,
    options: q.options,
    isChild: owner.isChild,
    askedAt: Date.now(),
  });
  return { taskId: owner.taskId, projectId: owner.projectId, shown: true, askId: ok };
}

/** C'è una domanda instradata aperta su questo task? */
export function pendingRoutedAsk(taskId: string): { sessionKey: string; isChild: boolean; askId: string } | null {
  const r = routed.get(taskId);
  return r ? { sessionKey: r.sessionKey, isChild: r.isChild, askId: r.askId } : null;
}

/** How an attempt to answer a routed question ended. */
export interface RoutedAnswer {
  /** The answer reached whoever was waiting. */
  delivered: boolean;
  /**
   * The answer NAMED another question: it was not delivered and nothing left.
   * The caller has to say so in the thread - the comment is already saved, and
   * without that line the person believes they confirmed.
   */
  stale?: { askId: string; open: string };
}

/**
 * A person answered in the thread: the answer goes back to whoever waited.
 *
 * `delivered` is true when somebody really was waiting and the answer reached
 * them. False without `stale` means "this comment is the answer to nothing",
 * and the caller must treat it as an ordinary comment: not an error, the case
 * almost every time.
 *
 * THE YES BELONGS TO THE QUESTION THE PERSON READ. `opts.askId` is the id of
 * the thread row they clicked: if it is not the one open now, the answer is NOT
 * delivered, because the question open now is a different one and handing it
 * over under its key is a yes given for one message and spent on another -
 * reproduced across two sessions of one task. With `askId` absent (a route that
 * does not send it, a comment written by hand) it is delivered to the open
 * question, which is the only one there can be: `routeAskToTaskThread` refuses
 * to open a second one while the first is alive.
 *
 * THE REGISTRY IS EMPTIED WHATEVER the delivery does. A rendez-vous that
 * expired while the comment travelled would otherwise leave an entry that turns
 * EVERY later comment into an attempt to answer a question that is gone. A
 * STALE answer empties nothing: the open question is not involved and stays
 * open.
 */
export function answerRoutedAsk(
  deps: AskRoutingDeps,
  taskId: string,
  text: string,
  opts: { askId?: string } = {},
): RoutedAnswer {
  const r = routed.get(taskId);
  if (!r) return { delivered: false };
  const named = typeof opts.askId === "string" ? opts.askId.trim() : "";
  if (named && named !== r.askId) return { delivered: false, stale: { askId: named, open: r.askId } };
  routed.delete(taskId);
  const body = String(text ?? "").trim();
  if (!body) return { delivered: false };
  try {
    return { delivered: deps.deliver(r.sessionKey, { [r.questionKey]: body }) };
  } catch {
    return { delivered: false };
  }
}

/** La domanda è finita per altre vie (annullata, scaduta, risposta nel tab). */
export function clearRoutedAskForSession(sessionKey: string): void {
  for (const [taskId, r] of routed) {
    if (r.sessionKey === sessionKey) routed.delete(taskId);
  }
}

/** Solo per i test: il registro è memoria di processo. */
export function _resetRoutedAsks(): void {
  routed.clear();
}
