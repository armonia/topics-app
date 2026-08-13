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
import type { BoardTask } from '../../lib/board';

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
  | 'unlink';

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
};

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
 * `accept` with the pre-review checks RED. The button changes word there
 * («Approva comunque»), and that word used to live outside this table as a
 * loose `board.task.approveAnyway` key.
 *
 * Being outside had a measured cost: the de-duplicator was handed the plain
 * «Approva» as the word on screen, so a quick reply reading «Approva comunque»
 * was left sitting next to the identical real button. Pressing the reply does
 * the OPPOSITE (it rejects, and restarts the agent with those words). A word
 * this table does not know is a word the de-duplicator cannot subtract.
 */
export function acceptWord(checksFailed: boolean, tr: Translate = fallbackTranslate): TaskActionWord {
  if (!checksFailed) return taskActionWord('accept', tr);
  return {
    label: tr('board.action.accept.anyway'),
    title: tr('board.action.accept.anyway.title', { sendBack: tr(KEYS['send-back'].label) }),
  };
}

/**
 * `send-back` and `redo` both promise a destination, and on a review card with
 * NO agent that destination does not exist: nothing "restarts on the same tab",
 * because there is no tab. The card goes back to In Progress with the human
 * holding it, which is a different sentence and the one the tooltip must say.
 *
 * Same LABEL either way: one word per action is the whole point, and the word
 * is not what was lying. Only the tooltip splits.
 */
export function sendBackWord(toAgent: boolean, tr: Translate = fallbackTranslate): TaskActionWord {
  if (toAgent) return taskActionWord('send-back', tr);
  return { label: tr(KEYS['send-back'].label), title: tr('board.action.sendBack.noAgent.title') };
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

/**
 * The words the DRAWER draws with buttons of ITS OWN, above the choice row.
 *
 * It exists so the de-duplicator and the JSX cannot disagree: both call this,
 * so a button whose word depends on the card's state (red checks turn Approva
 * into «Approva comunque») cannot be renamed on screen while the de-duplicator
 * still subtracts the old word. That exact gap left a twin «Approva comunque»
 * next to the real one.
 */
export function drawerSurfaceLabels(
  task: Pick<BoardTask, 'status' | 'assignedTopicId' | 'checksState'>,
  tr: Translate = fallbackTranslate,
): string[] {
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  const failed = task.checksState === 'fail';
  const out = [
    ...taskActionAliases(acceptWord(failed, tr), acceptWord(failed)),
    ...taskActionAliases(sendBackWord(isAgentReview, tr), sendBackWord(isAgentReview)),
    ...(isAgentReview ? taskActionAliases(taskActionWord('land', tr), taskActionWord('land')) : []),
  ];
  return [...new Set(out)];
}
