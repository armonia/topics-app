/**
 * A person's row steered into a turn that was already running (CHAT-QUEUE-08):
 * stored after that turn's assistant row, answered by it. Every read that asks
 * "what did the person write last?" skips it: the resume sweep (a cut turn
 * would be resent as the steered words, which the model already read), the
 * reattach of a turn adopted after a restart (it would open a second row and
 * pour the whole turn into it again), the marks of a resent row.
 *
 * Steered rows carry short marks only, so `blocks` stays text: a row whose
 * blocks were packed into a blob is never a steered one.
 */
export const NOT_STEERED_ROW = `NOT (role = 'user' AND typeof(blocks) = 'text' AND blocks LIKE '%"kind":"steered"%')`;
