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

import { isAgentWorking, normalizeActionLabel, type BoardTask } from '../../lib/board';
import {
  fallbackTranslate, redoWord, sendBackWord, stopWord, taskActionWord, unblockWord,
  type TaskActionId, type Translate,
} from './taskActionWords';

export type { Translate };

/**
 * The words are NOT here: they live in `taskActionWords.ts`, once, because the
 * card's context menu and the drawer's own buttons draw the same actions. This
 * file decides WHAT can be done, not what it is called.
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
export type TaskChoiceState = 'review-branch' | 'review-plain' | 'queued' | 'working' | 'blocked' | null;

/**
 * In quale dei cinque casi siamo. La precedenza NON è arbitraria:
 * - `review` vince su tutto (è la superficie di decisione, e un
 *   `dispatch_state` stantio non deve farci comparire «Ferma»);
 * - «in corso» vale solo con un turno DAVVERO vivo (`starting`/`working`): un
 *   task in_progress preso in mano da una persona non ha un agente da fermare;
 * - «in coda» è il terzo stato, e non è un dettaglio: `isAgentWorking` include
 *   `queued`, quindi una card che aspetta il suo turno offriva «Consegna quello
 *   che hai» — un bottone che scrive un commento all'agente. Ma l'agente non
 *   esiste ancora: il commento passa dal gate di `routes/tasks.ts`, che consegna
 *   solo a un task con un topic legato e in review o in corso, quindi resta una
 *   nota che nessuno legge. Chiedere una consegna a chi non è ancora nato è la
 *   promessa più vuota della card;
 * - «bloccata» è l'ultima, perché un task che aspetta non sta né in review né
 *   sotto un agente.
 */
export function taskChoiceState(task: Pick<BoardTask,
  'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'>): TaskChoiceState {
  if (task.status === 'review') {
    return task.assignedTopicId && task.deliveryBranch ? 'review-branch' : 'review-plain';
  }
  if (task.status === 'done') return null;
  // `isAgentWorking` risponde alla domanda «il dispatcher ha questa riga in
  // mano», che è la domanda giusta per il tetto di concorrenza e quella
  // sbagliata qui: le scelte parlano a un AGENTE, e in `queued` non c'è.
  if (task.dispatchState === 'starting' || task.dispatchState === 'working') return 'working';
  if (isAgentWorking(task.dispatchState)) return 'queued';
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
  /** Same, for the two whose TOOLTIP depends on there being an agent to go back to. */
  const toAgent = !!task.assignedTopicId;
  let out: TaskChoice[] = [];
  switch (state) {
    case 'review-branch':
      out = [
        say('land', 'primary'),
        { id: 'send-back', tone: 'neutral', ...sendBackWord(toAgent, tr) },
        say('take-over', 'neutral'),
      ];
      break;
    case 'review-plain':
      out = [
        say('accept', 'primary'),
        // «Rifai così…» on a review a human filed by hand has no agent to hand
        // anything to: same word, and a tooltip that names where the task
        // really goes instead of an agent that is not there.
        { id: 'redo', tone: 'neutral', needsText: true, ...redoWord(toAgent, tr) },
        say('drop', 'danger'),
      ];
      break;
    case 'working':
      out = [{ id: 'stop', tone: 'neutral', ...stopWord(true, tr) }, say('deliver-now', 'primary')];
      break;
    case 'queued':
      // Una voce sola, ed è quella che funziona davvero: il taglio del turno
      // accetta `queued` e sgancia il timer di grazia, quindi la card esce
      // dalla coda. «Consegna quello che hai» invece non ha nessuno a cui
      // chiederlo — vedi `taskChoiceState`. Stessa parola, tooltip suo.
      out = [{ id: 'stop', tone: 'neutral', ...stopWord(false, tr) }];
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

/**
 * Two labels are the same door.
 *
 * `normalizeActionLabel` is the SERVER's own comparison (`shared/board.ts`): it
 * is what decides whether a picked option is the reserved «Landa su main», so
 * the board subtracts exactly the options the server would treat as that
 * action, decoration and all — the model likes to prepend a 🚀, and a de-dup
 * that a rocket defeats is not a de-dup.
 */
function sameLabel(a: string, b: string): boolean {
  return normalizeActionLabel(a) === normalizeActionLabel(b);
}

/**
 * The agent's quick-reply options, minus the ones that collide with a real
 * choice for this task.
 *
 * A quick reply and a choice look identical, and what the reply does depends on
 * a list the human cannot see. Picking one sends a REJECT carrying its text
 * (`POST …/review`), and the route intercepts exactly four reserved strings
 * before the reject happens (`LAND_ACTION_LABEL` and friends, `shared/board.ts`)
 * and executes them instead. So a «Landa su main» twin is a redundant second
 * copy of the button below it, while a twin of any word OUTSIDE that list does
 * the OPPOSITE of the button it is impersonating: «Approva» next to the real
 * Approva rejects the card and restarts the agent with the word "Approva" as
 * its instruction (still in the DB, comment 2eff6a44).
 *
 * Dropping the collision is safe either way: the real button is already there,
 * one row below, doing what its label says.
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
 *
 * ── And it compares in TWO languages, on purpose ─────────────────────────────
 * The options are written by the AGENT, in the fallback locale by construction:
 * the server matches «Landa su main» by value, untranslated (`LAND_ACTION_LABEL`
 * in `shared/board.ts`), and the envelope is written in that language too. The
 * buttons, since they became translatable, are not. So under locale `en` the
 * button read "Land on main", the option still read «Landa su main», the
 * comparison found nothing, and the twin was back on the screen next to the
 * real button. Comparing the surface word ALONE only ever worked in one locale
 * — it worked before by accident, because the labels here were Italian
 * literals.
 */
export function usableQuestionOptions(
  task: Pick<BoardTask,
    'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'>,
  options: readonly string[],
  opts?: { exclude?: TaskChoiceId[]; surfaceLabels?: readonly string[]; t?: Translate },
): string[] {
  const labels = [
    ...taskChoices(task, opts).map((c) => c.label),
    // The same choices said the way the agent says them. `surfaceLabels` is
    // expected to carry both names already (see `drawerSurfaceLabels`).
    ...taskChoices(task, { ...opts, t: fallbackTranslate }).map((c) => c.label),
    ...(opts?.surfaceLabels ?? []),
  ];
  return options.filter((o) => !labels.some((l) => sameLabel(o, l)));
}
