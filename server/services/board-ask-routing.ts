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
import { boardTaskForSession } from "./agent-census";

/** Una domanda in attesa di risposta dal thread di un task. */
interface RoutedAsk {
  sessionKey: string;
  /** La chiave con cui il chiamante si aspetta la risposta (`answers[key]`). */
  questionKey: string;
  /** Le etichette offerte, per riconoscere una risposta che è una scelta. */
  options: string[];
  /** Chi ha chiesto: il coordinatore stesso o una sua figlia. */
  isChild: boolean;
  askedAt: number;
}

/**
 * taskId → domanda aperta. UNA per task, e non è una semplificazione: la card
 * mostra un blocco di risposta rapida solo, quindi due domande insieme
 * sarebbero due tasti sovrapposti sulla stessa riga. La seconda SOSTITUISCE la
 * prima, che è la stessa regola del rendez-vous (`waitForAnswer` supersede).
 */
const routed = new Map<string, RoutedAsk>();

export interface AskRoutingDeps {
  db: Database;
  /** Scrive il commento nel thread. Restituisce false se non ci è riuscito. */
  comment: (args: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => boolean;
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

/**
 * La domanda esce nel thread del task, se questa sessione ne ha uno.
 *
 * Restituisce il task su cui è uscita, o `null` quando la sessione non
 * appartiene a nessun task: una chat dell'umano continua a fare quello che ha
 * sempre fatto, cioè mostrare il pannello nel suo tab e basta.
 */
export function routeAskToTaskThread(
  deps: AskRoutingDeps,
  args: { sessionKey: string; questions: readonly AskQuestion[] },
): { taskId: string; projectId: string } | null {
  const owner = boardTaskForSession(deps.db, args.sessionKey);
  if (!owner) return null;
  // Già instradata. Il rendez-vous è a gambe corte: la stessa domanda ripassa
  // di qui ogni pochi secondi finché nessuno risponde, e senza questa riga
  // scriverebbe una copia per gamba.
  const open = routed.get(owner.taskId);
  if (open && open.sessionKey === args.sessionKey) return { taskId: owner.taskId, projectId: owner.projectId };
  const q = normalizeAsk(args.questions);
  if (!q) return null;
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
  if (!ok) return null;
  routed.set(owner.taskId, {
    sessionKey: args.sessionKey,
    questionKey: q.key,
    options: q.options,
    isChild: owner.isChild,
    askedAt: Date.now(),
  });
  return { taskId: owner.taskId, projectId: owner.projectId };
}

/** C'è una domanda instradata aperta su questo task? */
export function pendingRoutedAsk(taskId: string): { sessionKey: string; isChild: boolean } | null {
  const r = routed.get(taskId);
  return r ? { sessionKey: r.sessionKey, isChild: r.isChild } : null;
}

/**
 * Una persona ha risposto nel thread: la risposta torna a chi aspettava.
 *
 * Restituisce `true` se c'era davvero qualcuno in attesa e la risposta è stata
 * consegnata. `false` significa «questo commento non è la risposta a niente», e
 * il chiamante deve trattarlo come un commento normale: non è un errore, è il
 * caso quasi sempre.
 *
 * IL REGISTRO SI SVUOTA A PRESCINDERE dall'esito della consegna. Un rendez-vous
 * scaduto mentre il commento viaggiava lascerebbe altrimenti una riga che
 * trasforma OGNI commento successivo in un tentativo di risposta a una domanda
 * che non c'è più.
 */
export function answerRoutedAsk(deps: AskRoutingDeps, taskId: string, text: string): boolean {
  const r = routed.get(taskId);
  if (!r) return false;
  routed.delete(taskId);
  const body = String(text ?? "").trim();
  if (!body) return false;
  try {
    return deps.deliver(r.sessionKey, { [r.questionKey]: body });
  } catch {
    return false;
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
