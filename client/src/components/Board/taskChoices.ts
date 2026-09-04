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

import { PARKED_STOPPED, PARKED_WAITED_OUT, isAgentWorking, isUnfinishedReview, normalizeActionLabel, type BoardTask } from '../../lib/board';
import {
  acceptOverride, acceptWord, fallbackTranslate, landOverride, landWord, redoWord, reservedActionLabel,
  sendBackDest, sendBackWord, stopWord, taskActionWord, unblockWord,
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

/**
 * The card fields the choices are born from: nothing else matters here.
 *
 * `checksState` arrived late, and its absence WAS the hole. Without it
 * `acceptOverride` answered "no exception" on every card, so the button said
 * «Approva» where the drawer said «Approva comunque» and the server answered
 * 409. A missing field does not make a surface say a random wrong word: it
 * makes it say the NORMAL one, exactly in the case that is not normal.
 */
export type ChoiceTask = Pick<BoardTask,
  'status' | 'assignedTopicId' | 'deliveryBranch' | 'dispatchState' | 'blockedByTaskId' | 'blockedBy'
  | 'deliveredBy' | 'deliveredReason' | 'checksState'>;

/**
 * The chips the dispatcher writes when it sets a card ASIDE, with the reason
 * in `dispatchError`: failed, blocked, stopped by a person, waited out.
 */
export const PARKED_DISPATCH_STATES: ReadonlySet<string> = new Set(['failed', 'blocked', PARKED_STOPPED, PARKED_WAITED_OUT]);

/** Lo stato da cui nascono le scelte — uno solo per card, in quest'ordine. */
export type TaskChoiceState = 'review-unfinished' | 'review-branch' | 'review-plain' | 'queued' | 'working' | 'blocked' | 'parked' | null;

/**
 * In quale dei cinque casi siamo. La precedenza NON è arbitraria:
 * - `review` vince su tutto (è la superficie di decisione, e un
 *   `dispatch_state` stantio non deve farci comparire «Ferma»);
 * - dentro `review`, CHI ce l'ha portata viene prima di cosa ha lasciato: un
 *   ramo esiste anche quando il turno è finito a metà, quindi finché la domanda
 *   era solo «c'è un ramo?» una card che nessuno ha consegnato offriva le tre
 *   scelte identiche a una consegna vera, «Landa su main» verde in testa;
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
export function taskChoiceState(task: ChoiceTask): TaskChoiceState {
  if (task.status === 'review') {
    if (isUnfinishedReview(task)) return 'review-unfinished';
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
  // PARKED: the dispatcher set the card aside and wrote why. The reason lived
  // in a tooltip (invisible on touch) and the only way back was guessing that
  // dragging to Todo restarts it. In Todo it is already back in the queue, so
  // the choice would write what the column already says.
  if (task.dispatchState && PARKED_DISPATCH_STATES.has(task.dispatchState) && task.status !== 'todo') return 'parked';
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
  task: ChoiceTask,
  opts?: { exclude?: TaskChoiceId[]; t?: Translate },
): TaskChoice[] {
  const state = taskChoiceState(task);
  const tr = opts?.t;
  /** Words from the one table; only the tone and `needsText` belong to this file. */
  const say = (id: TaskChoiceId, tone: TaskChoice['tone'], needsText?: true): TaskChoice =>
    ({ id, tone, ...(needsText ? { needsText } : {}), ...taskActionWord(id, tr) });
  /** Same, for the two whose TOOLTIP depends on there being an agent to go back to. */
  const toAgent = !!task.assignedTopicId;
  /**
   * Approving and landing are EXCEPTIONS when the checks are red or nobody
   * delivered. Both words are derived here, once, from the same functions the
   * drawer reads through `reviewDecisionButtons`: the card used to say
   * «Approva» on a delivery with red checks, and the click took a 409.
   */
  const acceptSay = (tone: TaskChoice['tone']): TaskChoice =>
    ({ id: 'accept', tone, ...acceptWord(acceptOverride(task), tr) });
  const landSay = (tone: TaskChoice['tone']): TaskChoice =>
    ({ id: 'land', tone, ...landWord(landOverride(task), tr) });
  let out: TaskChoice[] = [];
  switch (state) {
    // Consegnata, con un ramo. `accept` STA QUI, e la sua assenza era un buco:
    // «Landa su main» e «Approva» non sono la stessa cosa — il primo fonde, il
    // secondo chiude e basta — e una card il cui lavoro NON è un ramo di questo
    // repo restava senza nessuna uscita utile. Misurato su 487ddf94, dove il
    // lavoro sta in `remotion-scenes`: le tre scelte offerte erano landa,
    // rimanda, serve-a-me, e l'unica cosa da fare (chiuderla) non c'era.
    //
    // È la stessa regola già scritta due casi più sotto per `review-unfinished`:
    // togliere un'uscita a chi decide è l'errore opposto. Neutro e dopo il land,
    // perché su una consegna col ramo il gesto normale resta far atterrare.
    //
    // THE GREEN ONE IS NOT ALWAYS THE LAND. With red checks the normal gesture
    // is no longer to merge, it is to send the output back. Land and accept
    // both stay, neutral and carrying the «comunque» word: no exit disappears,
    // what changes is which one the thumb finds first. Same rule as
    // `review-unfinished`, one case below.
    case 'review-branch':
      out = acceptOverride(task) === 'checks-red'
        ? [
          { id: 'send-back', tone: 'primary', ...sendBackWord(sendBackDest(task), tr) },
          landSay('neutral'),
          acceptSay('neutral'),
          say('take-over', 'neutral'),
        ]
        : [
          landSay('primary'),
          { id: 'send-back', tone: 'neutral', ...sendBackWord(sendBackDest(task), tr) },
          acceptSay('neutral'),
          say('take-over', 'neutral'),
        ];
      break;
    // Nessuno ha consegnato: le uscite sono le stesse, l'ordine e il tono no.
    // Il verde va su «Rimandalo avanti» perché è la sola che fa avanzare il
    // lavoro; land e accept scendono in fondo, neutri, con la parola che dice
    // che si sta approvando un'eccezione («comunque»). Restano tutte e due:
    // togliere un'uscita a chi decide sarebbe l'errore opposto.
    case 'review-unfinished':
      out = [
        { id: 'send-back', tone: 'primary', ...sendBackWord(sendBackDest(task), tr) },
        say('take-over', 'neutral'),
        acceptSay('neutral'),
        ...(toAgent && task.deliveryBranch ? [landSay('neutral')] : []),
      ];
      break;
    case 'review-plain':
      out = [
        // Green either way: the only other exit here is «Rifai così…», which
        // does nothing without a written line. The word changes, the weight
        // does not.
        acceptSay('primary'),
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
    // Set aside by the dispatcher: the one gesture that restarts it is the same
    // PATCH the drag to Todo makes (`status: 'todo'`), so the two roads meet.
    case 'parked':
      out = [say('requeue', 'primary'), say('drop', 'danger')];
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
 * IL COMMENTO CHE «RIMANDA INDIETRO» PORTA CON SÉ.
 *
 * La regola sta qui, pura e provata, perché il posto dove si sbaglia è il call
 * site: `boardApi.review(projectId, id, 'reject')` e `review(projectId, id,
 * 'reject', testo)` sono la stessa riga a meno di un argomento, e per mesi la
 * prima è stata quella dei bottoni grandi. Chi scriveva l'indicazione e poi
 * premeva «Rimanda indietro» la vedeva restare nella casella mentre l'agente
 * ripartiva senza.
 *
 * Due casi, e il secondo non è pedanteria: una casella con dentro solo spazi
 * NON è un'indicazione, e mandarla come commento scriverebbe nel thread una
 * riga vuota firmata dall'umano. Vuoto (o soli spazi) = reject nudo, che è la
 * stessa decisione detta senza aggiungere niente.
 */
export function sendBackComment(pending?: string | null): string | undefined {
  const text = pending?.trim();
  return text ? text : undefined;
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
  task: ChoiceTask,
  options: readonly string[],
  opts?: { exclude?: TaskChoiceId[]; surfaceLabels?: readonly string[]; t?: Translate },
): string[] {
  const scelte = taskChoices(task, opts);
  const labels = [
    ...scelte.map((c) => c.label),
    // The same choices said the way the agent says them. `surfaceLabels` is
    // expected to carry both names already (see `drawerSurfaceLabels`).
    ...taskChoices(task, { ...opts, t: fallbackTranslate }).map((c) => c.label),
    // E la stringa che il SERVER esegue per quell'azione, che non è né la
    // parola italiana né quella inglese quando il bottone si rinomina: su una
    // card mai consegnata il land dice «Landa comunque», mentre l'agente
    // scrive sempre «Landa su main» perché è quella che la route intercetta.
    // Confrontare le sole parole disegnate lasciava passare il gemello (vedi
    // `reservedActionLabel`).
    ...scelte.map((c) => reservedActionLabel(c.id)).filter((s): s is string => s !== null),
    ...(opts?.surfaceLabels ?? []),
  ];
  return options.filter((o) => !labels.some((l) => sameLabel(o, l)));
}

/**
 * WHICH CHOICE A TYPED SENTENCE BELONGS TO.
 *
 * Enter in the card's free field used to run the FIRST choice, whatever it
 * happened to be. On a delivered card with a branch the first choice is
 * «Landa su main»: writing a remark and pressing Enter merged the branch and
 * closed the task. It happened for real — task b673a253, merge commit
 * 8b97e432 — and the same shape approves a hand-filed review, where the first
 * choice is `accept`.
 *
 * A verdict carries no words. `land` and `accept` take no comment, their
 * buttons have no field, and their API calls have no place to put a sentence:
 * running one because text exists throws the text away AND decides. The
 * choices that DO carry text are `send-back` (which hands it to the agent) and
 * `redo`. So a typed sentence goes to one of those when the card offers it,
 * and otherwise stays a note — the verdicts keep their own buttons, which is
 * where an irreversible gesture belongs.
 *
 * Pure and exported so the rule is testable on its own and cannot drift from
 * the row of buttons it has to agree with.
 */
export const TEXT_CARRYING_CHOICES: readonly TaskChoiceId[] = ['send-back', 'redo'];
/** Choices that decide instead of instructing: never reachable by typing. */
export const VERDICT_CHOICES: readonly TaskChoiceId[] = ['land', 'accept'];

export function choiceForText(choices: readonly TaskChoice[]): TaskChoice | null {
  const carries = choices.find((c) => TEXT_CARRYING_CHOICES.includes(c.id));
  if (carries) return carries;
  const first = choices[0];
  if (!first || VERDICT_CHOICES.includes(first.id)) return null;
  return first;
}
