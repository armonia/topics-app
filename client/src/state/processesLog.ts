/**
 * OPENING «PROCESSI» ON ITS LOG, from the palette (HUBBR-19).
 *
 * The log is a section of the machine's Processes, not a view of its own. The
 * request is set down AND announced: the pane is a lazy chunk and its log
 * section mounts only once the hub's services have been read, so a section
 * that mounts later picks the request up, and one already on screen hears the
 * event. The request expires, so an unrelated later open does not jump to it.
 */

export const PROCESSES_LOG_EVENT = 'topics:processes-log';

/** Long enough for the chunk and the first read of the services, short enough to belong to one gesture. */
const VALID_MS = 15_000;

let askedAt = 0;

/** Open Processes scrolled to its log, opened. */
export function openProcessesLog(nowMs: number = Date.now()): void {
  askedAt = nowMs;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'processes' } }));
  window.dispatchEvent(new Event(PROCESSES_LOG_EVENT));
}

/** Whether a request is pending, consuming it. */
export function takeProcessesLogRequest(nowMs: number = Date.now()): boolean {
  const fresh = askedAt > 0 && nowMs - askedAt < VALID_MS;
  askedAt = 0;
  return fresh;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
