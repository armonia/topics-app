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

export type TaskChoiceId =
  /** review con ramo: accetta e fondi il ramo su main (locale, niente push). */
  | 'land'
  /** review: torna all'agente, che riparte sullo stesso tab. */
  | 'send-back'
  /** review: esce dal giro dell'agente, il task passa in mano all'umano. */
  | 'take-over'
  /** review senza ramo: accetta e chiudi. */
  | 'accept'
  /** review: rifiuta, ma serve una riga di indicazioni → apre il commento. */
  | 'redo'
  /** non serve più: archivia. */
  | 'drop'
  /** in corso: ferma il turno. */
  | 'stop'
  /** in corso: chiudi con quello che c'è. */
  | 'deliver-now'
  /** bloccata: togli il legame e mandala in Todo (riparte). */
  | 'unblock'
  /** bloccata: togli il legame, lasciandola dov'è. */
  | 'unlink';

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
 *   `dispatch_state` stantio non deve farci comparire «Fermati»);
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
  opts?: { exclude?: TaskChoiceId[] },
): TaskChoice[] {
  const state = taskChoiceState(task);
  let out: TaskChoice[] = [];
  switch (state) {
    case 'review-branch':
      out = [
        { id: 'land', label: 'Landa su main', tone: 'primary', title: 'Accetta il task e fondi il suo ramo su main (locale, nessun push).' },
        { id: 'send-back', label: 'Rimanda indietro', tone: 'neutral', title: "Torna all'agente, che riparte sullo stesso tab. Scrivi nel campo qui sotto per dargli un'indicazione." },
        { id: 'take-over', label: 'Serve a me', tone: 'neutral', title: "Esce dal giro dell'agente: il task torna in corso, assegnato a te." },
      ];
      break;
    case 'review-plain':
      out = [
        { id: 'accept', label: 'Va bene', tone: 'primary', title: 'Accetta la consegna e chiudi il task.' },
        { id: 'redo', label: 'Rifai così…', tone: 'neutral', needsText: true, title: "Rimanda all'agente con un'indicazione: porta il cursore nel commento qui sotto." },
        { id: 'drop', label: 'Non serve più', tone: 'danger', title: 'Archivia il task: esce dalla board.' },
      ];
      break;
    case 'working':
      out = [
        { id: 'stop', label: 'Fermati', tone: 'neutral', title: "Interrompe il turno dell'agente e parcheggia il task." },
        { id: 'deliver-now', label: 'Consegna quello che hai', tone: 'primary', title: "Chiede all'agente di chiudere adesso con quello che ha già fatto e mandare il task in review." },
      ];
      break;
    case 'blocked': {
      const name = blockerLabel(task);
      out = [
        {
          id: 'unblock',
          label: name ? `Sblocca: ${name}` : 'Sblocca',
          tone: 'primary',
          title: name
            ? `Non aspetta più «${name}»: togli il legame e manda il task in Todo, così può partire.`
            : 'Togli il legame e manda il task in Todo, così può partire.',
        },
        // Quando è GIA' in Todo le due voci scriverebbero la stessa cosa
        // («Sblocca» lo lascerebbe dov'è): un doppione non è una scelta.
        ...(task.status === 'todo'
          ? []
          : [{ id: 'unlink' as const, label: 'Togli il legame', tone: 'neutral' as const, title: "Toglie l'attesa lasciando il task dov'è (resta fermo finché non lo muovi)." }]),
        { id: 'drop', label: 'Non serve più', tone: 'danger', title: 'Archivia il task: esce dalla board.' },
      ];
      break;
    }
    default:
      return [];
  }
  const excluded = opts?.exclude;
  return excluded && excluded.length ? out.filter((c) => !excluded.includes(c.id)) : out;
}
