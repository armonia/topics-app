/**
 * HOW THE LAND ENDED, in one line for every surface.
 *
 * The `202` of `POST …/land` says the merge is QUEUED, not that it happened:
 * the receipt (`LandingTicket`) is the only thing that separates "about to
 * happen" from "happened". The drawer followed it, the card threw it away, and
 * the card is the surface people press.
 *
 * Worse: one of the ticket's phases LIES when read alone. `settled` means "the
 * round is over", not "the branch is on main": the real verdict is in
 * `outcome`, and `unlanded` means the merge was REFUSED (dirty checkout,
 * conflict, pruned branch). Neither surface read `outcome`, so a refused land
 * was indistinguishable from a successful one everywhere. It is read here,
 * once, and the band comes out where it is needed.
 *
 * PURE module: it decides WHAT to say, not how to draw it.
 */

import type { LandingTicket } from '../../lib/board';

/**
 * - `queued`/`running`: about to happen, and the band is a waiting one.
 * - `failed`: the landing round died (`error` says why).
 * - `unlanded`: the round finished and the merge was REFUSED (`detail` = `reason`).
 * - `unverifiable`: the merge exited zero but main could not be read back.
 */
export type LandingBandKind = 'queued' | 'running' | 'failed' | 'unlanded' | 'unverifiable';

export interface LandingBand {
  kind: LandingBandKind;
  /** How many merges are ahead in the queue (only on `queued`). */
  ahead: number;
  /** The reason, when there is one: `error` on failed, `reason` on refused. */
  detail: string | null;
}

/** Is the ticket still worth asking about? (`queued`/`running` = yes, every 2s.) */
export function landingPolls(ticket: LandingTicket | null | undefined): boolean {
  return ticket?.phase === 'queued' || ticket?.phase === 'running';
}

/**
 * The band to draw for this ticket, or `null` when there is nothing to say.
 *
 * A `settled` with a good verdict (`landed`, `nothing`, `skipped`) draws NO
 * band: the card closes by itself and the thread holds the receipt. The band is
 * for when the verdict contradicts the expectation, which is the case nobody
 * could see.
 */
export function landingBand(ticket: LandingTicket | null | undefined): LandingBand | null {
  if (!ticket) return null;
  const ahead = ticket.ahead ?? 0;
  if (ticket.phase === 'queued') return { kind: 'queued', ahead, detail: null };
  if (ticket.phase === 'running') return { kind: 'running', ahead: 0, detail: null };
  if (ticket.phase === 'failed') return { kind: 'failed', ahead: 0, detail: ticket.error ?? null };
  if (ticket.outcome === 'unlanded') return { kind: 'unlanded', ahead: 0, detail: ticket.reason ?? null };
  if (ticket.outcome === 'unverifiable') return { kind: 'unverifiable', ahead: 0, detail: null };
  return null;
}
