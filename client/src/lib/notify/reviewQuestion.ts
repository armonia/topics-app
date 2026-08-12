/**
 * La domanda pendente dietro un banner di review — e i tre stati che il fronte
 * `task:review-ready` può portare, che NON sono due.
 *
 *   · un oggetto  → l'agente sta chiedendo: le opzioni sono i tasti;
 *   · `null`      → il server ha guardato il thread, domanda non ce n'è: il
 *                   tasto giusto è "Approva";
 *   · ASSENTE     → un server che questo campo non lo manda. NON è «non c'è
 *                   domanda», ed è la distinzione che tiene in piedi tutto: il
 *                   guscio desktop si porta dietro il suo client e si aggiorna
 *                   per conto suo, mentre il server è il demone — un client
 *                   nuovo su un server vecchio è la normalità, non un caso di
 *                   scuola. Trattare «assente» come «nessuna domanda»
 *                   metterebbe un tasto "Approva" su un task che sta aspettando
 *                   una risposta: un click, e invece di rispondergli lo chiudi.
 *
 * Nel terzo caso questo modulo NON indovina: chiede il thread e applica la
 * stessa lettura del server (`pendingQuestion` in shared/board.ts), che è anche
 * quella della quick-reply sulla card. Costa una richiesta su un evento che
 * capita quando un task finisce, non in un ciclo — e solo contro un server
 * vecchio, perché quello nuovo la domanda ce l'ha già messa dentro.
 */
import { pendingQuestion, type PendingQuestionComment } from '../../../../shared/board';

export type ReviewQuestion = { text: string; options: string[] } | null;

/**
 * `'unknown'` = non si è potuto sapere (server vecchio E thread non
 * raggiungibile). Chi legge NON deve offrire tasti: meglio il banner-link di
 * sempre che un tasto scelto tirando a indovinare.
 */
export type ResolvedReviewQuestion = ReviewQuestion | 'unknown';

export interface ReviewQuestionDeps {
  /** Il thread del task. Solo per il ripiego: il server nuovo non lo fa chiamare. */
  fetchComments: (projectId: string, taskId: string) => Promise<readonly PendingQuestionComment[]>;
  /**
   * Tetto d'attesa del ripiego. Il banner è un'INTERRUZIONE che deve arrivare
   * quando l'evento accade: aspettare un server lento all'infinito lo farebbe
   * comparire quando non serve più. Scaduto, si notifica senza tasti.
   */
  timeoutMs?: number;
  /** Iniettabile per i test — di default `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveReviewQuestion(
  frame: { projectId?: string; taskId?: string; question?: ReviewQuestion },
  deps: ReviewQuestionDeps,
): Promise<ResolvedReviewQuestion> {
  // Il campo c'è (oggetto o `null`): il server ha già risposto, nessuna
  // richiesta. È la strada normale, e non costa niente.
  if (frame.question !== undefined) return frame.question;
  const { projectId, taskId } = frame;
  if (!projectId || !taskId) return 'unknown';

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wait = deps.delay ?? sleep;
  try {
    const comments = await Promise.race([
      deps.fetchComments(projectId, taskId),
      wait(timeoutMs).then(() => 'timeout' as const),
    ]);
    if (comments === 'timeout') return 'unknown';
    return pendingQuestion(comments);
  } catch {
    return 'unknown';
  }
}
