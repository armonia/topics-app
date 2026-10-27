/**
 * THE CAP ON AN AGENT'S WAITS: on the second one the card stops and asks.
 *
 * `WAIT_STREAK_CAP` brakes the MACHINE's waits (a silent node puts the card
 * back every five minutes without opening a turn): those cost no tokens, and
 * six in a row are half an hour. A wait the agent declares with
 * `wait_for_condition` costs a whole turn instead: every time the window
 * expires a turn starts, reads the card, the thread and the repo again to find
 * the condition still missing, and declares it again. The estimate on the
 * turns spent on such waits (capire-token, T6) is -28% tokens with the cap on
 * the second declaration.
 *
 * One: the first wait goes through (a CI running, a service coming back), a
 * second one for the same reason means the condition is not arriving by
 * itself, and the question goes to a person instead of another paid turn.
 */
export const AGENT_WAIT_STREAK_CAP = 1;
