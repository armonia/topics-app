import { commentAuthorLabel } from './comment-author';
import { TaskStatus } from './board-base';
import { isBoardActionLabel } from './board-parking';

/** Le due primitive di collegamento dell'intake. */
export type LinkKind = "subtask" | "chain";

/**
 * La PROPOSTA dell'intake: dove andrebbe un testo nuovo.
 * Vive qui perche' la calcola il server e la disegna il client — due copie
 * libere di divergere erano esattamente cio' che il cancello sui doppioni
 * di tipo esiste per impedire.
 */
export interface LinkProposal {
  targetTaskId: string;
  targetText: string;
  targetStatus: TaskStatus;
  /**
   * Quale delle due primitive il motore consiglia. NON è una decisione: la UI
   * evidenzia questa e lascia l'altra a un click di distanza.
   * - `chain` quando la card sta ancora girando (in_progress/review): il testo
   *   nuovo è un SEGUITO, e riparte dentro la conversazione del bloccante.
   * - `subtask` quando la card non è ancora partita (backlog/todo): il testo
   *   nuovo è un PEZZO di quel lavoro.
   */
  recommended: LinkKind;
  /** 0..1 — copertura pesata dei termini del testo nuovo sulla card. */
  score: number;
  /** Le parole che hanno fatto il punteggio, dalla più rara alla più comune. */
  sharedTerms: string[];
  /** Frase leggibile: va sotto al composer E nel thread delle due card. */
  reason: string;
}

/**
 * Parse a task comment for an agent "question block" — the human-decision
 * request the board renders as a quick-reply:
 *
 *   ```question
 *   Which auth approach?
 *   - JWT in an httpOnly cookie
 *   - Short-lived bearer token
 *   ```
 *
 * The canonical block is composed SERVER-side (tasks service `questionOptions`)
 * so this layout is guaranteed for new comments — but the parser stays
 * tolerant of hand-written LLM variants: `\r\n`, missing newlines around the
 * fences, options inlined on one line. Returns the question + the (possibly
 * empty) option list, or null when the text has no such block.
 *
 * Sta in `shared/` e non più solo nel client perché ora ha un secondo lettore:
 * il SERVER, che deve sapere se il task che entra in review porta una domanda
 * per poterla mettere nei tasti della notifica (`emitReviewReadyEdge` →
 * `push-triggers`). Due parser sarebbero due verità: un'opzione che la board
 * mostra e il banner no è peggio di nessun banner.
 */
export function parseQuestionBlock(text: string): { question: string; options: string[] } | null {
  if (!text) return null;
  // \s+ (not \s*\n): tolerate a block whose newlines were lost/normalized —
  // '```question Question? - a - b```' still parses.
  const m = text.replace(/\r\n/g, '\n').match(/```question\s+([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  const options: string[] = [];
  const qLines: string[] = [];
  if (body.includes('\n')) {
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const opt = line.match(/^[-*]\s+(.*)$/);
      if (opt) options.push(opt[1].trim());
      else qLines.push(line);
    }
  } else {
    // Degenerate single-line body: split on ' - ' option markers. The first
    // segment is the question; a leading '- ' marks an option-only block.
    const segments = body.split(/\s+-\s+/);
    const first = segments.shift()?.trim() ?? '';
    if (first.startsWith('- ')) segments.unshift(first.slice(2));
    else if (first) qLines.push(first);
    for (const s of segments) { const v = s.trim(); if (v) options.push(v); }
  }
  const question = qLines.join(' ').trim();
  if (!question) return null;
  // "Landa e pubblica" (go online = merge + push + deploy) is NEVER a per-task
  // quick-reply: publishing is a SEPARATE, human-only board action (the "Pubblica"
  // control) with a diff preview to review before pushing. The dispatcher used to
  // make agents offer it at delivery; drop it from the rendered options so old
  // deliveries that still carry it don't show a one-click merge+push button.
  // "Landa su main" (local merge, no push) stays.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const filtered = options.filter((o) => norm(o) !== 'landa e pubblica');
  return { question, options: filtered };
}

/**
 * Does this parsed block ASK the human something, or is it a DELIVERY that
 * merely offers the next board action as a button?
 *
 * The presence of the fence answered neither question. The kickoff envelope
 * tells a delivering agent to attach `options=["Landa su main"]`, and the
 * server wraps any `options` in a ```question block, so EVERY landable delivery
 * came out shaped like a question. Measured on 13/08 against the live board db:
 * of the 437 agent comments carrying a question fence, 331 are deliveries, not
 * questions — three out of four.
 *
 * So read the OPTIONS instead. All of them board actions ⇒ delivery. A mixed
 * block ("Landa su main" + "Aspetta, ho un dubbio") is still a QUESTION: one
 * option the system cannot execute means a person has to choose.
 *
 * No options at all stays a question, which is this module's own reading
 * (`pendingQuestion`): a question with no buttons has nothing to click but is
 * still waiting for an answer. One legacy shape falls on that side and should
 * not — a delivery whose ONLY option was "Landa e pubblica", which
 * `parseQuestionBlock` filters out of the rendered list. The envelope no longer
 * prompts for that option, so that shape only survives on old cards.
 */
export function questionAsksHuman(q: { options: readonly string[] } | null | undefined): boolean {
  if (!q) return false;
  if (q.options.length === 0) return true;
  return !q.options.every(isBoardActionLabel);
}

/** Il minimo che serve per riconoscere una domanda in coda al thread. */
export type PendingQuestionComment = {
  content: string;
  kind?: string | null;
  author?: string | null;
  messageId?: string | null;
  /** Declared by the writer: a note, not an answer. See `TaskComment.quiet`. */
  quiet?: boolean | null;
};

/**
 * Is this row somebody's WORD, as opposed to the thread's plumbing?
 *
 * Two kinds are not: 'status' (transition history, written on every move, never
 * anybody's word) and 'service' (the dispatcher's own bookkeeping, marked at the
 * source). Both can land AFTER the agent has spoken, and every surface that asks
 * "what did the thread say last" has to skip them or it reads the plumbing as
 * the answer: the quick-reply buttons vanish because a queue-hold note took the
 * question's place, the card quotes "In attesa di uno slot" as the delivery.
 *
 * ONE predicate, because there are three readers of that question -
 * `pendingQuestion` here, the card's `selectCardComments`, the drawer's own
 * last-word - and a card whose buttons and whose text disagree is worse than
 * either being wrong: it looks answerable and answers something else.
 */
export function isThreadSpeech(comment: { kind?: string | null } | null | undefined): boolean {
  return !!comment && comment.kind !== 'status' && comment.kind !== 'service';
}

/**
 * The question at the end of the conversation, including one followed by its
 * own delivery summary. Only a shared, nonempty assistant-message anchor and
 * the same agent author prove that a delivery belongs to that question.
 * Ordinary prose, a human reply or a different turn stops the scan. Legacy
 * unanchored rows keep their old last-word behavior.
 *
 * Return the original row so callers can apply their parked-question guards
 * and keep the displayed delivery summary separate from the question to answer.
 */
export function pendingQuestionComment<T extends PendingQuestionComment>(
  comments: readonly T[] | null | undefined,
): T | null {
  let delivery: T | null = null;
  for (let i = (comments?.length ?? 0) - 1; i >= 0; i--) {
    const comment = comments![i]!;
    if (!isThreadSpeech(comment)) continue;
    // A NOTE IS NOT AN ANSWER, AND ONLY THE WRITER KNOWS WHICH IT WAS.
    //
    // The rule below — a human word after the question ends the scan — is the
    // right one: someone who speaks under a question is normally answering it.
    // But `quiet` exists to say the opposite out loud, and without this line
    // the two gestures were indistinguishable once stored: annotating a card
    // silently removed the buttons from the question above. Same collision the
    // flag was introduced to end, one surface further along.
    if (comment.quiet) continue;
    if (delivery && (comment.author !== delivery.author || comment.messageId !== delivery.messageId)) return null;
    if (parseQuestionBlock(comment.content)) return comment;
    if (comment.kind !== 'delivery'
      || !comment.messageId?.trim()
      || !comment.author?.trim()
      || commentAuthorLabel(comment.author).kind !== 'agent'
      || comment.content.includes('```question')) return null;
    delivery ??= comment;
  }
  return null;
}

/**
 * DID THIS COMMENT PRESS A QUICK REPLY OF A BLOCK THAT IS ALREADY OVER?
 *
 * The drawer sends `answerTo` on every reply typed under a question block, so
 * `answerTo` alone cannot tell a press from a sentence somebody wrote: it is the
 * CONTENT matching one of that block's own options that says the person clicked.
 * The distinction is the whole point of the caller - a note under a dead block
 * stays a note, a press gets told it reached nobody - and it is also what keeps
 * this away from the board's own labels («Landa su main» and the parked
 * answers), which are quick replies too and are intercepted before this is read.
 *
 * Pure and here rather than in the route because it is a rule about the shape of
 * a thread, and the same shape the buttons are drawn from.
 */
export function pressedADeadQuickReply(
  comments: readonly (PendingQuestionComment & { id?: string })[] | null | undefined,
  answerTo: string,
  content: string,
): boolean {
  const said = content.trim().toLowerCase();
  if (!said || !answerTo) return false;
  const row = comments?.find((c) => c?.id === answerTo);
  if (!row) return false;
  const parsed = parseQuestionBlock(row.content ?? '');
  if (!parsed) return false;
  return parsed.options.some((o) => o.trim().toLowerCase() === said);
}

/**
 * The pending question for review notifications, using the same original-row
 * resolver as the card and drawer. A delivery from that assistant message can
 * follow the question without answering it.
 *
 * Due lettori su due lati del filo: il server, che mette la domanda nel fronte
 * `task:review-ready`; e il client, che se la ricava da sé quando il fronte non
 * la porta (server più vecchio del client).
 */
export function pendingQuestion(
  comments: readonly PendingQuestionComment[] | null | undefined,
): { text: string; options: string[] } | null {
  const last = pendingQuestionComment(comments);
  if (!last) return null;
  const parsed = parseQuestionBlock(last.content ?? '');
  // Una domanda senza opzioni non ha tasti da offrire, ma resta una domanda: la
  // si dichiara comunque, così chi legge sa che il task ASPETTA una risposta e
  // non è una consegna da approvare.
  return parsed ? { text: parsed.question, options: parsed.options } : null;
}

/**
 * LA PASTIGLIA «NON SU MAIN» PARLA SOLO DI CIÒ CHE È STATO MISURATO.
 *
 * Diceva `status === 'done' && landingState === 'unlanded'`, cioè metà colonna e
 * metà verdetto. Misurate il 13/08 le 14 card che la portavano: 2 erano debito
 * vero, 2 avevano il contenuto su main (un verdetto scritto da un land fallito e
 * mai più riguardato), 3 erano state SUPERATE da lavoro atterrato dopo, e 4 non
 * hanno mai avuto uno sha di consegna — su quelle non è stato verificato niente,
 * mai, e il rosso era la parola di nessuno.
 *
 * Le prime tre righe le raddrizza il verdetto (l'audit periodico, che adesso
 * ricontrolla anche un `unlanded` testimoniato e non chiama debito ciò che
 * qualcuno ha rifatto). Questa funzione chiude l'ultima, ed è la regola che vale
 * per tutte: senza la FOTOGRAFIA della consegna — il commit registrato quando il
 * task è entrato in review — non c'è niente su cui una domanda sia stata posta,
 * quindi non c'è nessuna risposta da mostrare. Si tace.
 *
 * Vive in `shared/` perché la stessa pastiglia la disegnano in tre (la card, la
 * banda del drawer, e il primo gradino del controllo «Consegna» in barra), e tre
 * predicati copiati sono tre momenti diversi in cui uno dei tre smette di essere
 * vero.
 */
export function showsLandingDebt(task: {
  status: TaskStatus | string;
  landingState: string | null | undefined;
  deliveryCommit: string | null | undefined;
}): boolean {
  // Solo `done`: una card in review non è ancora atterrata per definizione, e
  // segnalarlo lì sarebbe rumore su ogni consegna.
  if (task.status !== 'done') return false;
  // `unverifiable` non è un'accusa più debole: è l'assenza di un verdetto.
  if (task.landingState !== 'unlanded') return false;
  return !!task.deliveryCommit;
}

/**
 * THE CARD HAS ALREADY PRODUCED WHAT IT WAS ASKED FOR.
 *
 * A card waiting to START and a card that has already DELIVERED are two
 * different things, and the board has three independent marks that say the
 * second one: the delivery snapshot (`deliveryCommit`), the landing verdict
 * (`landingState === 'landed'`), and the column itself (`review` = handed to a
 * human). Any one of them is enough.
 *
 * Measured on 28/08 on a landed parent: closing its last subtask released it as
 * if it were a peer blocker, and the parent went back to `in_progress` with an
 * agent on top of work that was already on main. Two damages, and the second is
 * the silent one: re-queueing wipes `landingState`, so the card stops saying it
 * landed while git still says it did.
 */
export function hasDeliveredWork(task: {
  status?: TaskStatus | string | null;
  landingState?: string | null;
  deliveryCommit?: string | null;
}): boolean {
  if (task.landingState === 'landed') return true;
  if (task.deliveryCommit) return true;
  return task.status === 'review';
}

/**
 * ITS WORK IS ON MAIN, and that is a fact about git, not about the card cycle.
 *
 * Narrower than `hasDeliveredWork` on purpose: sending a delivered card back to
 * the agent is the normal way to ask for more, but sending back a LANDED one
 * re-opens a cycle over content that is already merged — and the re-queue
 * clears the very field that recorded the merge.
 */
export function isLandedWork(task: { landingState?: string | null }): boolean {
  return task.landingState === 'landed';
}

/**
 * CAN THE COMPOSER ACTUALLY REACH THE AGENT.
 *
 * `/comments` keeps ANY message on a landed card a note (see tasks-board.ts,
 * same reasoning as `isLandedWork`): re-kicking the agent over content
 * already on main would reopen a cycle the merge already closed. A box that
 * still offered to send to the agent on that card promised a turn the server was
 * never going to run, and the person read the silence as a bug.
 */
export function canSendToAgent(task: {
  status?: TaskStatus | string | null;
  assignedTopicId?: string | null;
  landingState?: string | null;
  archived?: boolean | null;
}): boolean {
  return task.status === 'review' && !!task.assignedTopicId && !isLandedWork(task) && !task.archived;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy proposed at approve (board_settings.deployCommand) — analogue of
// `landingState`, but for running a command instead of a git merge.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a card stands relative to the deploy proposed at approve: `'proposed'
 *  | 'running' | 'deployed' | 'failed' | null` (`null` = never proposed —
 *  board with no `deployCommand`, or a card not yet approved). Kept as the
 *  literal union everywhere it is used (`Task.deployState`, this function's
 *  parameter): nothing validates it against a runtime list yet, so a named
 *  type here would be a second declaration nobody imports. */

/** The button's text — a reserved quick-reply, executed by the server and
 *  never by the agent (same treatment as `LAND_ACTION_LABEL` above). */
export const DEPLOY_ACTION_LABEL = 'Deploya ora';

/**
 * THE SAME PILL as `showsLandingDebt`, for deploy: persisted, not derived from
 * the thread, so a card reopened after a network error does not lose the
 * button just because the proposal comment has scrolled out of view.
 *
 * Holds on ANY status of the card (not just `done`): a post-approve `reject`
 * does not withdraw a deploy proposal already made, and that is intentional —
 * the deploy is an action on the BOARD (the main checkout), not a verdict on
 * the task.
 */
export function showsDeployProposal(task: { deployState: string | null | undefined }): boolean {
  return task.deployState === 'proposed';
}

/**
 * ARE THE REVIEW DECISIONS (approve, send back, land) STILL LIVE.
 *
 * `archive()` never touches `status`: a card archived straight out of
 * review keeps saying `review` forever after, because nothing else moves it.
 * A drawer left open on it kept drawing the three buttons as if the card
 * were still waiting for a verdict, and a click there changed nothing the
 * archive had not already decided. The archived banner is the only button
 * that card gets now; this is what gates the other three off.
 */
export function canDecideReview(task: { status: TaskStatus | string; archived?: boolean }): boolean {
  return task.status === 'review' && !task.archived;
}

/**
 * La ricevuta di un land — il server risponde `202` (accodato), non `200`
 * (fatto).
 *
 * Esiste perché `POST …/tasks/:id/land` rispondeva `200` con la card e faceva
 * la fusione dopo (`void landTask(...)`): chi chiamava riceveva la card, non
 * l'esito. Misurato l'11/08, ~20 land in raffica ⇒ 4 fusioni riuscite e 16 card
 * chiuse col codice ancora sul loro branch, senza una riga che lo dicesse.
 *
 * `ahead` è quante fusioni ci sono davanti sulla stessa board: toccano tutte
 * main nello stesso checkout, quindi vanno in fila — e mettersi in fila si dice.
 */
export type LandingPhase = 'queued' | 'running' | 'settled' | 'failed';

export interface LandingTicket {
  taskId: string;
  phase: LandingPhase;
  /** Quanti land ci sono DAVANTI a questo nella stessa fila. 0 = tocca a lui. */
  ahead: number;
  queuedAt: string;
  /** ISO in cui il ticket si è chiuso, `null` finché non è finito. */
  settledAt: string | null;
  /** Il motivo del `failed`. `null` in ogni altra fase. */
  error: string | null;
  /**
   * L'esito del land, disponibile su `phase === 'settled'`. `null` finche'
   * non e' finito o se l'esito non e' determinabile.
   * - `landed` il commit e' su main
   * - `unlanded` il merge e' stato rifiutato (checkout sporco, conflitto, ecc.)
   * - `unverifiable` il merge e' uscito zero ma non si e' potuto rileggere main
   * - `skipped` non c'era niente da atterrare (nessun ramo proprio)
   * - `nothing` il ramo non portava commit che main non avesse gia'
   */
  outcome: 'landed' | 'unlanded' | 'unverifiable' | 'skipped' | 'nothing' | null;
  /**
   * La ragione del rifiuto quando `outcome === 'unlanded'`. Corrisponde al
   * testo scritto nel thread della card dal sistema. `null` in tutti gli
   * altri casi.
   */
  reason: string | null;
}
