/**
 * The words of the Agents row tail for the sessions waiting on you: the
 * catalogue has no plural rules, so the singular is its own key.
 */
import type { Translate } from './board';

export function agentsWaitingText(n: number, tr: Translate): string {
  return n === 1 ? tr('agents.waitingYouOne') : tr('agents.waitingYou', { n });
}
