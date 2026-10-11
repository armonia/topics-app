/**
 * THE CHAT'S STRIPS, one geometry.
 *
 * Five different things that say "this is where the chat stands": the declared
 * goal, the todo list, the live work, the context warnings, the messages to
 * send. They had lined up three ways: a fixed `mx-2` (TodoStrip, GoalBar),
 * `mx-2/mx-3` by width (the warnings, and the composer itself), plus two radii
 * (`rounded-lg` and `rounded-xl`). Four pixels on a desktop: enough to show as
 * a step, not enough to look meant.
 *
 * One geometry here. `md:` and not an `isMobile` prop: the app's threshold is
 * `window.innerWidth < 768`, exactly Tailwind's `md` breakpoint, and a class
 * need not travel from component to component to know the window's width.
 *
 * The margin follows the COMPOSER (`m-2` / `m-3`), the edge the eye aligns to:
 * the goal, todo, live work, checkpoint and changed-files strips sit at the end
 * of the transcript right above it (chat-strips-in-transcript), the others in
 * the composer's block.
 */

/** Geometria condivisa: margini, distanza dalla striscia sotto, raggio. */
export const CHAT_STRIP = 'mx-2 md:mx-3 mb-1 rounded-lg';

/**
 * …più la superficie neutra, per le strisce che non hanno un colore proprio.
 * Quelle semantiche (avvisi ambra/rossi, conferme verdi) tengono il loro e
 * prendono solo `CHAT_STRIP`.
 */
export const CHAT_STRIP_NEUTRAL = `${CHAT_STRIP} border border-app-border/60 bg-app-hover/40 text-app-text`;

/** La riga cliccabile che apre/chiude una striscia espandibile. */
/** `coarse:min-h-11`: a strip row is a target, 44 tall under a finger (it was 29, usability audit 04/10). */
export const CHAT_STRIP_ROW = 'flex w-full items-center gap-2 px-2.5 py-1.5 text-left coarse:min-h-11';
