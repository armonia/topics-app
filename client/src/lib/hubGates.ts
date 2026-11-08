/**
 * The workflows stopped at an approval gate, as the hub's automations list
 * them among what needs you (`needsYou`, provider `lobster`). Pure: the agents
 * and jobs level and the row of System read the same answer the same way.
 */
export interface GateWait { key: string; title: string; reason: string | null; since: number | null }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function gateWaitsOf(raw: unknown): GateWait[] {
  const list = isObject(raw) && Array.isArray(raw.needsYou) ? raw.needsYou : [];
  const out: GateWait[] = [];
  for (const c of list) {
    if (!isObject(c) || c.provider !== 'lobster') continue;
    const key = str(c.key);
    const title = str(c.title);
    if (!key || !title) continue;
    out.push({ key, title, reason: str(c.reason), since: typeof c.since === 'number' && Number.isFinite(c.since) ? c.since : null });
  }
  return out;
}
