/**
 * OPENING «AUTOMAZIONI» ON ONE AUTOMATION, from a link of the hub
 * (`#automations/<key>`): a «waiting for you» item, a line of the diary, a
 * row of «Agents and jobs». The hub's own page took the key from the URL;
 * Topics opens its view and selects the row.
 *
 * Set down AND announced, like the log of Processes: the view is a lazy chunk
 * and reads the hub before it has rows, so a view that mounts later picks the
 * request up and one already on screen hears the event. It expires, so a
 * later unrelated open does not jump to an old key.
 */

export const AUTOMATION_TARGET_EVENT = 'topics:automation-target';

const VALID_MS = 15_000;

let pending: { key: string; at: number } | null = null;

/** Open Automazioni with this automation selected. */
export function openAutomation(key: string, nowMs: number = Date.now()): void {
  pending = { key, at: nowMs };
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'automations' } }));
  window.dispatchEvent(new CustomEvent(AUTOMATION_TARGET_EVENT, { detail: { key } }));
}

/**
 * The key asked for, if still fresh, WITHOUT consuming it. The view can mount
 * twice for one gesture (the lazy chunk, then the tab moved into its group):
 * a first mount that consumed the key left the second one on the plain list.
 * The view settles the request once the row is on screen.
 */
export function peekAutomationTarget(nowMs: number = Date.now()): string | null {
  return pending && nowMs - pending.at < VALID_MS ? pending.key : null;
}

/** The request fulfilled: the view shows this key, so a later open does not jump to it again. */
export function settleAutomationTarget(key: string): void {
  if (pending?.key === key) pending = null;
}

let pendingCalendar: number | null = null;

/** Open Automazioni on its Calendar tab: the dated reminders and the jobs that end («Agenti e lavori», its footer). */
export function openAutomationsCalendar(nowMs: number = Date.now()): void {
  pendingCalendar = nowMs;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'automations' } }));
  window.dispatchEvent(new CustomEvent(AUTOMATION_TARGET_EVENT, { detail: { tab: 'calendar' } }));
}

/** Whether the Calendar tab was asked for and is still fresh, consuming the request. */
export function takeCalendarTarget(nowMs: number = Date.now()): boolean {
  const fresh = pendingCalendar !== null && nowMs - pendingCalendar < VALID_MS;
  pendingCalendar = null;
  return fresh;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
