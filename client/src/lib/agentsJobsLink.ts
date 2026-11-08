/**
 * A LINK TO «AGENTI E LAVORI» ON ONE FILTER (hub-smistamento, HUBBR-13).
 *
 * The hub's «Lavori» page kept its filter in the address (`#work/<filter>`),
 * and the tray linked there. In Topics the list is a level of System, so the
 * address is `/lavori` or `/lavori/<filter>` (one slug per filter, `SLUGS`):
 * opened, it lands on System > Agenti e lavori with that filter chosen, and is
 * consumed (`replaceState('/')`) like the `/tab/` permalinks, so a reload does
 * not open the menu again. A door inside the app (the palette, a row) asks
 * the same way with `openAgentsJobs(filter)`.
 *
 * Set down AND announced, like `automationTarget`: the level is a lazy chunk
 * that mounts after the request, so it takes the filter when it mounts. The
 * request expires, so a later unrelated open is not steered by an old one.
 */
import { openUserMenu } from './openUserMenu';
import type { JobFilter } from './agentsJobs';

const VALID_MS = 15_000;

/** The address words of each filter: what a link from the tray or the brief writes. */
const SLUGS: Record<string, JobFilter> = { 'in-corso': 'running', 'in-attesa': 'waiting', finiti: 'finished' };

let pending: { filter: JobFilter | null; at: number } | null = null;

/** The filter a link or a door asked for, if still fresh, without consuming it. */
export function peekAgentsJobsFilter(nowMs: number = Date.now()): JobFilter | null {
  return pending && nowMs - pending.at < VALID_MS ? pending.filter : null;
}

/** The filter a link or a door asked for, if still fresh, consuming it; null keeps the level's own choice. */
export function takeAgentsJobsFilter(nowMs: number = Date.now()): JobFilter | null {
  const fresh = peekAgentsJobsFilter(nowMs);
  pending = null;
  return fresh;
}

/** Open System > Agenti e lavori, on `filter` when given. */
export function openAgentsJobs(filter: JobFilter | null = null, nowMs: number = Date.now()): void {
  pending = { filter, at: nowMs };
  openUserMenu('agents');
}

/** The filter an address names: `undefined` when it is not a link to the level, null for `/lavori` alone. */
export function agentsJobsLinkFilter(pathname: string): JobFilter | null | undefined {
  const m = /^\/lavori(?:\/([a-z-]+))?\/?$/.exec(pathname);
  if (!m) return undefined;
  return m[1] ? SLUGS[m[1]] ?? null : null;
}

/**
 * At boot: an address `/lavori[/<filter>]` opens the level and is consumed.
 * Returns whether it was one.
 */
export function consumeAgentsJobsLinkFromUrl(): boolean {
  let filter: JobFilter | null | undefined;
  try {
    filter = agentsJobsLinkFilter(window.location.pathname);
  } catch {
    return false;
  }
  if (filter === undefined) return false;
  try {
    const u = new URL(window.location.href);
    u.pathname = '/';
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* no history here: the level opens all the same */
  }
  openAgentsJobs(filter);
  return true;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
