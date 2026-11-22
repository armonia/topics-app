/**
 * What the hub's automations list among what needs you (`needsYou`): an
 * automation broken for days that nobody looked at, a job that turns without
 * doing anything, and the workflows stopped at an approval gate (provider
 * `lobster`). Pure: the bell, the agents and jobs level and the row of System
 * read the same answer the same way, so the Automations row («7 da
 * sistemare») and the bell list the same automations.
 */
export interface GateWait { key: string; title: string; reason: string | null; since: number | null }

/** An automation waiting on the person; `gate` when it is a workflow stopped at an approval. */
export interface AutomationWait extends GateWait { gate: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function automationWaitsOf(raw: unknown): AutomationWait[] {
  const list = isObject(raw) && Array.isArray(raw.needsYou) ? raw.needsYou : [];
  const out: AutomationWait[] = [];
  for (const c of list) {
    if (!isObject(c)) continue;
    const key = str(c.key);
    const title = str(c.title);
    if (!key || !title) continue;
    out.push({
      key, title, reason: str(c.reason),
      since: typeof c.since === 'number' && Number.isFinite(c.since) ? c.since : null,
      gate: c.provider === 'lobster',
    });
  }
  return out;
}

export function gateWaitsOf(raw: unknown): GateWait[] {
  return automationWaitsOf(raw).filter((w) => w.gate).map(({ key, title, reason, since }) => ({ key, title, reason, since }));
}
