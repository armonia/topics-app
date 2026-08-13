/**
 * Le SCELTE di una card che non è chiusa.
 *
 * Una card ferma davanti a una casella di testo vuota è una card che resta
 * ferma: si scrive una frase lunga, o non si scrive niente. Le opzioni rapide
 * dell'agente (il blocco ```question```) ci sono solo se l'agente le ha
 * proposte — quando non lo fa, all'umano restava il solo commento libero.
 *
 * Qui le scelte si RICAVANO dallo stato della card, quindi ci sono sempre:
 * ogni voce è un'azione che il board sa già fare (land, review, stop, patch,
 * archive), nominata. Il commento libero resta, in coda: l'ultima opzione, non
 * l'unica.
 *
 * Modulo PURO — nessuna chiamata, nessun React: decide solo COSA si può fare.
 * L'esecuzione sta in `TaskChoices.tsx`, uno solo per card e drawer.
 */

import { isAgentWorking, type BoardTask } from '../../lib/board';
import { taskActionWord, unblockWord, type TaskActionId, type Translate } from './taskActionWords';

export type { Translate };

/**
 * Le parole NON stanno qui: stanno in `taskActionWords.ts`, una sola volta,
 * perché le stesse azioni le disegnano anche il menu contestuale della card e i
 * bottoni propri del drawer. Qui si decide COSA si può fare, non come si chiama.
 */
export type TaskChoiceId = TaskActionId;

export interface TaskChoice {
  id: TaskChoiceId;
  /** Etichetta del bottone — è l'azione, detta come la direbbe una persona. */
  label: string;
  /** Cosa succede davvero, per esteso (tooltip). */
  title: string;
  tone: 'primary' | 'neutral' | 'danger';
  /**
   * Non è un click-e-via: la scelta ha senso solo con una riga di testo, quindi
   * porta il fuoco sul commento libero invece di agire (label con «…»).
   */
  needsText?: boolean;
}

/** Lo stato da cui nascono le scelte — uno solo per card, in quest'ordine. */
export type TaskChoiceState = 'review-branch' | 'review-plain' | 'working' | 'blocked' | null;

/**
 * In quale dei quattro casi siamo. La precedenza NON è arbitraria:
 * - `review` vince su tutto (è la superficie di decisione, e un
 *   `dispatch_state` stantio non deve farci comparire «Ferma»);
 * - «in corso» vale solo con un turno DAVVERO vivo (`isAgentWorking`): un task
 *   in_progress preso in mano da una persona non ha un agente da fermare;
 * - «bloccata» è l'ultima, perché un task che aspetta non sta né in review né
 *   sotto un agente.
 */
export function taskChoiceState(task: Pick<BoardTask,
  'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'>): TaskChoiceState {
  if (task.status === 'review') {
    return task.assignedTopicId && task.deliveryBranch ? 'review-branch' : 'review-plain';
  }
  if (task.status === 'done') return null;
  if (isAgentWorking(task.dispatchState)) return 'working';
  // Stesso predicato del chip «in attesa di» (e del gate di dispatch): un
  // bloccante chiuso o archiviato non blocca più, quindi non offre scelte.
  if (task.blockedByTaskId && !(task.blockedBy && (task.blockedBy.status === 'done' || task.blockedBy.archived))) return 'blocked';
  return null;
}

/** Il titolo del bloccante, accorciato per stare su un bottone. */
function blockerLabel(task: Pick<BoardTask, 'blockedBy'>): string | null {
  const text = task.blockedBy?.text?.trim();
  if (!text) return null;
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/**
 * Le scelte della card, nell'ordine in cui vanno disegnate (la più probabile
 * per prima). `exclude` serve al drawer, che alcune azioni le ha già come
 * bottoni suoi e non le vuole doppie.
 */
export function taskChoices(
  task: Pick<BoardTask,
    'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'>,
  opts?: { exclude?: TaskChoiceId[]; t?: Translate },
): TaskChoice[] {
  const state = taskChoiceState(task);
  const tr = opts?.t;
  /** Words from the one table; only the tone and `needsText` belong to this file. */
  const say = (id: TaskChoiceId, tone: TaskChoice['tone'], needsText?: true): TaskChoice =>
    ({ id, tone, ...(needsText ? { needsText } : {}), ...taskActionWord(id, tr) });
  let out: TaskChoice[] = [];
  switch (state) {
    case 'review-branch':
      out = [say('land', 'primary'), say('send-back', 'neutral'), say('take-over', 'neutral')];
      break;
    case 'review-plain':
      out = [say('accept', 'primary'), say('redo', 'neutral', true), say('drop', 'danger')];
      break;
    case 'working':
      out = [say('stop', 'neutral'), say('deliver-now', 'primary')];
      break;
    case 'blocked':
      out = [
        { id: 'unblock', tone: 'primary', ...unblockWord(blockerLabel(task), tr) },
        // Quando è GIA' in Todo le due voci scriverebbero la stessa cosa
        // («Sblocca» lo lascerebbe dov'è): un doppione non è una scelta.
        ...(task.status === 'todo' ? [] : [say('unlink', 'neutral')]),
        say('drop', 'danger'),
      ];
      break;
    default:
      return [];
  }
  const excluded = opts?.exclude;
  return excluded && excluded.length ? out.filter((c) => !excluded.includes(c.id)) : out;
}

/** Normalised form used to compare a quick-reply option with a choice label. */
function sameLabel(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.trim().toLowerCase().replace(/[.!…]+$/u, '').replace(/\s+/gu, ' ');
  return norm(a) === norm(b);
}

/**
 * The agent's quick-reply options, minus the ones that collide with a real
 * choice for this task.
 *
 * A quick reply and a choice look identical and do OPPOSITE things: the reply is
 * a reject carrying that text, so the agent restarts; the choice performs the
 * action. Measured on card c57e1aa4 (2026-08-13): the agent's question block
 * offered "Landa su main" as its only option, and the card drew it right above
 * the green "Landa su main" that actually merges the branch. Pressing the top
 * one did not land anything, it bounced the card back to the agent with the
 * words "Landa su main" as an instruction.
 *
 * Dropping the collision is safe by construction: the real button is already
 * there, one row below, doing what its label says.
 *
 * `exclude` means "this surface does not render that action from the choice
 * row". It is NOT the same as "the surface does not draw it": the drawer
 * excludes `land`, `accept` and `send-back` from the row precisely BECAUSE it
 * draws them itself, bigger, right above. Reading `exclude` alone therefore
 * looked at the wrong screen — the drawer offered a quick reply that said
 * «Approva» next to the real Approva, and pressing the wrong one rejected the
 * card (still in the DB, comment 2eff6a44).
 *
 * So a surface also passes `surfaceLabels`: the words IT draws on its own. The
 * de-duplicator can only be right about what is on the screen if it is told
 * everything that is on the screen.
 */
export function usableQuestionOptions(
  task: Pick<BoardTask,
    'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'>,
  options: readonly string[],
  opts?: { exclude?: TaskChoiceId[]; surfaceLabels?: readonly string[]; t?: Translate },
): string[] {
  const labels = [
    ...taskChoices(task, opts).map((c) => c.label),
    ...(opts?.surfaceLabels ?? []),
  ];
  return options.filter((o) => !labels.some((l) => sameLabel(o, l)));
}
