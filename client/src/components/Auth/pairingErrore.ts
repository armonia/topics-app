/**
 * Two decisions the pairing screen makes when a request does not go through,
 * pulled out of the component so they can be checked.
 *
 * WHY THEY LIVE HERE. Both used to be inline in `PairingGate.tsx`, inside an
 * effect that owns a fetch, a poll and two timers. Nothing could reach them,
 * and one of them was WRONG for months in the way that matters most: every
 * failure, including a reply that had arrived, was rendered as "I can't reach
 * Topics. Is the computer switched on?".
 *
 * That line sent people to check a machine that was answering perfectly. The
 * real cause on 2026-08-21 was a `429` from the per-address pairing cap, which
 * behind the relay counts a whole household as one address: the phone could
 * reach Topics fine and was being told the opposite.
 *
 * Pure functions of their input, no React: the component keeps the effect, the
 * judgement is here where a test can ask about it directly.
 */
// Relative and not `@/`: this module is also read by `bun test`, which has no
// map of Vite's aliases. An import that compiles but does not run is a test
// that does not exist.
import { chiaveErroreAuth } from '../../lib/authErrors';

/**
 * Why the pairing screen is not showing a code.
 *
 * `unreachable` is the absence of an answer: machine off, relay down, no
 * network. A code is an answer that ARRIVED and said no for a stated reason.
 * Collapsing the two is the defect this type exists to make impossible.
 */
export type MotivoPairing = 'unreachable' | { codice: string };

/** The first retry waits this long. */
export const ATTESA_BASE_MS = 2_000;

/**
 * The retry never waits longer than this.
 *
 * Retrying every couple of seconds for an hour against a machine that is off
 * is a phone getting warm in a pocket, so the delay grows. It stops growing
 * here because a person who switches the computer back on should not then wait
 * minutes for a screen that could have asked again.
 */
export const ATTESA_MAX_MS = 30_000;

/**
 * How long to wait before asking again, given the number of failures so far.
 *
 * The delay doubles from the base and stops at the maximum. The argument
 * counts failures, so the first one waits the base delay.
 */
export function attesaRiprova(tentativi: number): number {
  if (tentativi <= 1) return ATTESA_BASE_MS;
  return Math.min(ATTESA_BASE_MS * 2 ** (tentativi - 1), ATTESA_MAX_MS);
}

/**
 * A refused reply becomes the reason to show.
 *
 * The server states the reason as a CODE and the phrase is chosen by the
 * interface in its own language, which is the same contract the rest of
 * `/api/auth/**` follows (`shared/auth-codes.ts`). An unknown or missing code
 * falls back to the generic phrase rather than to silence.
 */
export function motivoDaRisposta(corpo: { error?: string } | null | undefined): MotivoPairing {
  return { codice: chiaveErroreAuth(corpo?.error) };
}

/**
 * Which phrase key the screen shows for a reason.
 *
 * The single place that decides, so "reply that arrived" and "no reply at all"
 * cannot drift back into the same sentence.
 */
export function chiaveFrase(motivo: MotivoPairing): string {
  return motivo === 'unreachable' ? 'pair.unreachable' : motivo.codice;
}

/**
 * What the status line at the bottom says.
 *
 * The screen already knew whether the loop was working and never showed it, so
 * "waiting" and "broken" looked identical from the phone. One dot and one line
 * separate them without asking anyone to read an error.
 */
export function chiaveStato(motivo: MotivoPairing | null): string {
  return motivo === null ? 'pair.state.connected' : 'pair.state.retrying';
}
