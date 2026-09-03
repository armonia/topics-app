/**
 * ONE word per action, for every surface that offers it.
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 * The same action was called different things depending on where you clicked
 * it. On a single card the context menu said «Ferma» / «Archivia» while the
 * button row said «Fermati» / «Non serve più». Between card and drawer,
 * approving was «Va bene» in one place and «Approva» in the other, and
 * rejecting was «Rimanda indietro» here and «Rifiuta» there. Three different
 * «Ferma» tooltips promised three different fates, and only one of them named
 * the column the task actually ends up in.
 *
 * Two names for one action is not a style problem: the human cannot tell
 * whether they are two doors or one, so they hesitate at both. Worse, an agent
 * quick-reply that carries one of those words looks exactly like the button
 * beside it and does the opposite (see `usableQuestionOptions`), and a
 * de-duplicator can only catch that when it knows every word actually on the
 * screen — which it cannot, if each surface invents its own.
 *
 * So the words live HERE, once, and card, context menu and drawer read them.
 *
 * ── Why keys and not strings ─────────────────────────────────────────────────
 * The drawer was already translated (`board.task.*`) while the card was Italian
 * literals, so a plain string table would have made the two agree in Italian
 * and disagree again in English. The table holds i18n KEYS and takes the
 * translate function from the caller, so one word per action holds in every
 * language. Callers with no React context (pure modules, tests) get the
 * fallback locale.
 */

import { t as translate, FALLBACK_LOCALE } from '../../lib/i18n';
import { isUnfinishedReview, LAND_ACTION_LABEL, type BoardTask } from '../../lib/board';

/**
 * Everything a task surface can offer. Same id space as `TaskChoiceId` in
 * `taskChoices.ts` on purpose: the drawer's own Approva / Rimanda indietro /
 * Landa su main buttons ARE `accept` / `send-back` / `land`, drawn bigger.
 */
export type TaskActionId =
  | 'land'
  | 'send-back'
  | 'take-over'
  | 'accept'
  | 'redo'
  | 'drop'
  | 'restore'
  | 'stop'
  | 'deliver-now'
  | 'unblock'
  | 'unlink'
  | 'requeue';

/** What a surface needs to draw one action: the word, and what it really does. */
export interface TaskActionWord {
  /** The action, said the way a person would say it. */
  label: string;
  /** Where it actually leads (tooltip). Names the destination column when there is one. */
  title: string;
}

/** The shape of `useT()` — passed in so this module needs no React. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** For callers outside a component (pure modules, unit tests). */
export const fallbackTranslate: Translate = (key, vars) => translate(key, FALLBACK_LOCALE, vars);

const KEYS: Record<TaskActionId, { label: string; title: string }> = {
  'land': { label: 'board.action.land', title: 'board.action.land.title' },
  'send-back': { label: 'board.action.sendBack', title: 'board.action.sendBack.title' },
  'take-over': { label: 'board.action.takeOver', title: 'board.action.takeOver.title' },
  'accept': { label: 'board.action.accept', title: 'board.action.accept.title' },
  'redo': { label: 'board.action.redo', title: 'board.action.redo.title' },
  'drop': { label: 'board.action.drop', title: 'board.action.drop.title' },
  'restore': { label: 'board.action.restore', title: 'board.action.restore.title' },
  'stop': { label: 'board.action.stop', title: 'board.action.stop.title' },
  'deliver-now': { label: 'board.action.deliverNow', title: 'board.action.deliverNow.title' },
  'unblock': { label: 'board.action.unblock', title: 'board.action.unblock.title' },
  'unlink': { label: 'board.action.unlink', title: 'board.action.unlink.title' },
  'requeue': { label: 'board.action.requeue', title: 'board.action.requeue.title' },
};

/**
 * LA STRINGA CHE IL SERVER ESEGUE, per le azioni che ne hanno una.
 *
 * Una risposta rapida non è testo libero quando il suo valore sta nella lista
 * riservata (`shared/board.ts`): la route la intercetta e ESEGUE l'azione
 * invece di rigettare. Quindi «Landa su main» è la stessa porta del bottone
 * land, sempre — comunque quel bottone si chiami oggi, e in qualunque lingua
 * sia disegnato.
 *
 * Sta qui e non nel de-duplicatore perché è un fatto sull'AZIONE, come la sua
 * parola: chi aggiunge un'azione eseguita dal server la dichiara nella stessa
 * tabella, e il confronto la vede senza che nessuno se lo ricordi.
 *
 * Il costo di non averla: il 21/08 il bottone di land su una card mai
 * consegnata è stato rinominato «Landa comunque» (parola giusta: non c'era
 * nessuna consegna da promettere). Il de-dup confrontava solo le parole
 * disegnate, la parola era cambiata, l'opzione dell'agente no — e il gemello è
 * ricomparso sopra il bottone vero. Un fix ha riaperto la porta che un altro
 * fix chiudeva, perché il legame era la STRINGA e il codice guardava la parola.
 *
 * `PUBLISH_ACTION_LABEL` resta fuori di proposito: anche quella la esegue il
 * board, ma fa una cosa in più (pubblica), quindi non è il gemello di nessun
 * bottone qui — toglierla cancellerebbe una scelta vera.
 */
const RESERVED: Partial<Record<TaskActionId, string>> = {
  'land': LAND_ACTION_LABEL,
};

/** La stringa riservata di un'azione, se il board la esegue da sé. */
export function reservedActionLabel(id: TaskActionId): string | null {
  return RESERVED[id] ?? null;
}

/**
 * The word for one action.
 *
 * `{land}` is offered to every tooltip because one of them has to point at the
 * land button by name ("this does NOT merge, that one does"). Copying the other
 * button's text into a sentence by hand is exactly how two words drift apart
 * again, and an unused placeholder costs nothing: `interpolate` only replaces
 * the ones it finds.
 */
export function taskActionWord(id: TaskActionId, tr: Translate = fallbackTranslate): TaskActionWord {
  return { label: tr(KEYS[id].label), title: tr(KEYS[id].title, { land: tr(KEYS.land.label) }) };
}

/**
 * `unblock` is the one action whose word carries data: the blocker's title, so
 * the button says WHICH wait it ends. Same table, a second key pair rather than
 * string surgery on the first, because Italian and English do not glue a name
 * onto a verb the same way.
 */
export function unblockWord(blockerName: string | null, tr: Translate = fallbackTranslate): TaskActionWord {
  if (!blockerName) return taskActionWord('unblock', tr);
  return {
    label: tr('board.action.unblock.named', { name: blockerName }),
    title: tr('board.action.unblock.namedTitle', { name: blockerName }),
  };
}

/**
 * PERCHÉ approvare qui è un'eccezione, o `null` se non lo è.
 *
 * Due ragioni diverse portano alla stessa parola («Approva comunque») e a due
 * frasi diverse: i checks rossi dicono che l'output è stato giudicato e non
 * regge, «non consegnato» dice che un output non c'è proprio. Quando valgono
 * entrambe vince la seconda: è la ragione per cui la card sta lì, e i checks su
 * un turno mai finito quasi sempre non sono nemmeno girati. La parola sul
 * bottone è la stessa nei due casi, quindi la precedenza non toglie niente allo
 * schermo: sceglie solo quale frase spiega la scelta.
 */
export type AcceptOverride = 'checks-red' | 'unfinished' | null;

export function acceptOverride(
  task: Pick<BoardTask, 'status' | 'deliveredBy' | 'deliveredReason' | 'checksState'>,
): AcceptOverride {
  if (isUnfinishedReview(task)) return 'unfinished';
  return task.checksState === 'fail' ? 'checks-red' : null;
}

/**
 * `accept` when approving is an EXCEPTION. The button changes word there
 * («Approva comunque»), and that word used to live outside this table as a
 * loose `board.task.approveAnyway` key.
 *
 * Being outside had a measured cost: the de-duplicator was handed the plain
 * «Approva» as the word on screen, so a quick reply reading «Approva comunque»
 * was left sitting next to the identical real button. Pressing the reply does
 * the OPPOSITE (it rejects, and restarts the agent with those words). A word
 * this table does not know is a word the de-duplicator cannot subtract.
 *
 * The tooltip names the normal path, and the normal path is not the same in the
 * two cases: with red checks you send the output back, on a card nobody
 * delivered you let the agent carry on. Naming the wrong one would point the
 * reviewer at a button that is not there.
 */
export function acceptWord(override: AcceptOverride, tr: Translate = fallbackTranslate): TaskActionWord {
  if (!override) return taskActionWord('accept', tr);
  const normalPath = override === 'unfinished'
    ? sendBackWord('unfinished', tr).label
    : tr(KEYS['send-back'].label);
  return {
    label: tr('board.action.accept.anyway'),
    title: tr(
      override === 'unfinished' ? 'board.action.accept.unfinished.title' : 'board.action.accept.anyway.title',
      { sendBack: normalPath },
    ),
  };
}

/**
 * `land` on a card NOBODY delivered. Same merge, and a word that stops calling
 * it a delivery: the branch exists (the agent committed while working) but no
 * agent ever said it was finished, so «Landa su main» promised a consegna that
 * was never made. That green button on the card is the whole incident.
 */
export function landWord(unfinished: boolean, tr: Translate = fallbackTranslate): TaskActionWord {
  if (!unfinished) return taskActionWord('land', tr);
  return { label: tr('board.action.land.anyway'), title: tr('board.action.land.anyway.title') };
}

/**
 * DOVE va davvero il «Rimanda indietro» di questa card, e quindi come si chiama.
 *
 * - `agent`: c'è un tab da far ripartire, ed è il caso normale.
 * - `human`: nessun agente legato. Niente "riparte sullo stesso tab": il task
 *   torna In Progress in mano a una persona. Stessa parola, altra frase.
 * - `unfinished`: l'agente non ha MAI consegnato, quindi non gli si rimanda
 *   indietro niente. Qui la PAROLA cambia, perché «Rimanda indietro» descrive
 *   un output che torna al mittente e un output non c'è: si chiede solo di
 *   proseguire.
 */
export type SendBackDest = 'agent' | 'human' | 'unfinished';

export function sendBackDest(
  task: Pick<BoardTask, 'status' | 'assignedTopicId' | 'deliveredBy' | 'deliveredReason'>,
): SendBackDest {
  // Senza tab non si prosegue niente: «Rimandalo avanti» prometterebbe una
  // ripresa che non può avvenire, quindi la card non consegnata degrada alla
  // frase vera («torna In Progress, in mano a te»).
  if (!task.assignedTopicId) return 'human';
  return isUnfinishedReview(task) ? 'unfinished' : 'agent';
}

/**
 * `send-back` and `redo` both promise a destination, and on a review card with
 * NO agent that destination does not exist: nothing "restarts on the same tab",
 * because there is no tab. The card goes back to In Progress with the human
 * holding it, which is a different sentence and the one the tooltip must say.
 *
 * Between `agent` and `human` the LABEL is the same: one word per action is the
 * whole point, and the word was not what lied. `unfinished` is the one case
 * where the word itself stopped being true, so it is a second key pair here,
 * like «Approva comunque» - inside the table, where the de-duplicator can see it.
 */
export function sendBackWord(dest: SendBackDest, tr: Translate = fallbackTranslate): TaskActionWord {
  if (dest === 'unfinished') {
    return { label: tr('board.action.sendBack.unfinished'), title: tr('board.action.sendBack.unfinished.title') };
  }
  if (dest === 'human') return { label: tr(KEYS['send-back'].label), title: tr('board.action.sendBack.noAgent.title') };
  return taskActionWord('send-back', tr);
}

export function redoWord(toAgent: boolean, tr: Translate = fallbackTranslate): TaskActionWord {
  if (toAgent) return taskActionWord('redo', tr);
  return { label: tr(KEYS.redo.label), title: tr('board.action.redo.noAgent.title') };
}

/**
 * `stop` su una card ancora IN CODA. Stessa divisione di `sendBackWord`: la
 * parola non cambia — una sola parola per azione è tutto il punto di questo
 * modulo — cambia il tooltip, perché la promessa «interrompe il turno
 * dell'agente» su una card `queued` nomina un turno che non è mai cominciato.
 * L'azione fa comunque quello che serve: il taglio accetta `queued`, sgancia il
 * timer di grazia e parcheggia la card.
 */
export function stopWord(hasAgent: boolean, tr: Translate = fallbackTranslate): TaskActionWord {
  if (hasAgent) return taskActionWord('stop', tr);
  return { label: tr(KEYS.stop.label), title: tr('board.action.stop.queued.title') };
}

/**
 * Every word one action answers to on this screen: the translated one the human
 * reads, plus the fallback-locale one.
 *
 * The second is not redundancy. A quick reply is written by the AGENT, in the
 * fallback locale by construction — the server matches `LAND_ACTION_LABEL`
 * ("Landa su main") by value, untranslated, and the envelope is written in that
 * language too. Under locale `en` the button reads "Land on main", so comparing
 * only the surface word let the twin back onto the screen: the de-duplicator
 * has to know both names of the same door.
 */
export function taskActionAliases(word: TaskActionWord, fallback: TaskActionWord): string[] {
  return word.label === fallback.label ? [word.label] : [word.label, fallback.label];
}

/** Le tre superfici del drawer, e quale delle due decisioni è il verde. */
export interface ReviewDecisionButtons {
  accept: TaskActionWord;
  sendBack: TaskActionWord;
  /** `null` quando non c'è un ramo d'agente da fondere. */
  land: TaskActionWord | null;
  /** Uno solo, sempre: l'altro resta neutro. */
  primary: 'accept' | 'send-back';
}

/**
 * I bottoni GRANDI della zona di decisione del drawer: le parole, e quale dei
 * due è il verde.
 *
 * Il verde è una raccomandazione, e su una card che nessuno ha consegnato la
 * raccomandazione era sbagliata: «Approva» chiudeva un task senza guardare che
 * sotto non c'era niente. Su quella card il verde passa a «Rimandalo avanti»,
 * mentre Approva e Landa restano dove sono, neutri e rinominati. Nessuna uscita
 * sparisce: cambia quale il pollice trova per prima.
 *
 * Sta QUI e non nel JSX perché le stesse parole servono al de-duplicatore delle
 * risposte rapide (`drawerSurfaceLabels`, subito sotto, che deriva da questa
 * funzione). Scritte due volte divergono, ed è già successo: con i checks rossi
 * il bottone diceva «Approva comunque» e il de-duplicatore sottraeva ancora
 * «Approva», quindi il gemello che RIGETTA è tornato accanto al bottone vero.
 */
export function reviewDecisionButtons(
  task: Pick<BoardTask, 'status' | 'assignedTopicId' | 'checksState' | 'deliveredBy' | 'deliveredReason'>,
  tr: Translate = fallbackTranslate,
): ReviewDecisionButtons {
  const unfinished = isUnfinishedReview(task);
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  return {
    accept: acceptWord(acceptOverride(task), tr),
    sendBack: sendBackWord(sendBackDest(task), tr),
    land: isAgentReview ? landWord(unfinished, tr) : null,
    primary: unfinished ? 'send-back' : 'accept',
  };
}

/**
 * The words the DRAWER draws with buttons of ITS OWN, above the choice row.
 *
 * It exists so the de-duplicator and the JSX cannot disagree: both read
 * `reviewDecisionButtons`, so a button whose word depends on the card's state
 * (red checks turn Approva into «Approva comunque», a card nobody delivered
 * turns Landa into «Landa comunque») cannot be renamed on screen while the
 * de-duplicator still subtracts the old word. That exact gap left a twin
 * «Approva comunque» next to the real one.
 */
export function drawerSurfaceLabels(
  task: Pick<BoardTask, 'status' | 'assignedTopicId' | 'checksState' | 'deliveredBy' | 'deliveredReason'>,
  tr: Translate = fallbackTranslate,
): string[] {
  const shown = reviewDecisionButtons(task, tr);
  const fallback = reviewDecisionButtons(task);
  const out = [
    ...taskActionAliases(shown.accept, fallback.accept),
    ...taskActionAliases(shown.sendBack, fallback.sendBack),
    ...(shown.land && fallback.land ? taskActionAliases(shown.land, fallback.land) : []),
  ];
  return [...new Set(out)];
}
