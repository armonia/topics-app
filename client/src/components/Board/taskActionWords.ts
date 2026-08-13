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
