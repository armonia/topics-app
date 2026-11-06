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

/** The key asked for, if still fresh, consuming it. */
export function takeAutomationTarget(nowMs: number = Date.now()): string | null {
  const fresh = pending && nowMs - pending.at < VALID_MS ? pending.key : null;
  pending = null;
  return fresh;
}
