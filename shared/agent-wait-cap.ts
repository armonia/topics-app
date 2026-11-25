/**
 * THE WINDOW OF AN AGENT'S REPEATED WAITS: it grows, the card never leaves todo.
 *
 * A wait the agent declares with `wait_for_condition` costs a whole turn every
 * time the window expires (the turn re-reads the card, the thread and the repo
 * to find the condition still missing). The old answer was to park the card in
 * backlog on the second declaration, which turned scheduled work into an idea
 * nobody would pick up again. The answer now is a longer window on each repeat
 * for the same reason: 15 min, 1 h, 6 h, 24 h, then 24 h again.
 */
export const AGENT_WAIT_WINDOW_MINUTES: readonly number[] = [15, 60, 360, 1440];

/** The window for the Nth consecutive wait (1-based) on the same reason. */
export function agentWaitWindowMinutes(streak: number): number {
  const i = Math.min(Math.max(streak, 1), AGENT_WAIT_WINDOW_MINUTES.length) - 1;
  return AGENT_WAIT_WINDOW_MINUTES[i]!;
}
