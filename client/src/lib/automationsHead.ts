/**
 * The parts of the hub's automations model that sit around the rows: how
 * fresh the reading is (`stale`, the last good copy served when a read
 * failed), what the automations cost in tokens per provider, the sources the
 * hub reads with the time of each reading, the jobs it hides and why, and
 * the brakes the gate holds on a fix born from an automation.
 *
 * Also the primitive readers every automations module shares. Pure: no
 * fetch, no React, no words: the view formats them.
 */

export type Raw = Record<string, unknown>;

export function asRecord(v: unknown): Raw | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Weighted tokens by provider (`claude`, `codex`, `muse`…). */
export type TokensByProvider = Record<string, number>;

/**
 * What one automation costs: its tokens over 24 hours and 7 days, or why
 * there is no count ("only a script", or "calls a model but its count never
 * reaches the hub", which is never a zero).
 */
export type AutomationUsage =
  | { kind: 'tokens'; d1: TokensByProvider; d7: TokensByProvider }
  | { kind: 'script' }
  | { kind: 'unmeasured' };

function tokensOf(v: unknown): TokensByProvider {
  const o = asRecord(v);
  const out: TokensByProvider = {};
  if (!o) return out;
  for (const [k, n] of Object.entries(o)) {
    const x = num(n);
    if (x !== null) out[k] = x;
  }
  return out;
}

export function readUsage(v: unknown): AutomationUsage | null {
  const u = asRecord(v);
  if (!u) return null;
  if (u.kind === 'tokens') return { kind: 'tokens', d1: tokensOf(u.d1), d7: tokensOf(u.d7) };
  if (u.kind === 'unmeasured') return { kind: 'unmeasured' };
  if (u.kind === 'script') return { kind: 'script' };
  return null;
}

/** The sum of a usage's tokens over 24 hours (`d1`) or 7 days (`d7`); 0 without a count. */
export function usageTotal(u: AutomationUsage | null, k: 'd1' | 'd7' = 'd7'): number {
  return u && u.kind === 'tokens' ? Object.values(u[k]).reduce((a, b) => a + b, 0) : 0;
}

export interface HubSource {
  name: string;
  label: string;
  ok: boolean;
  at: number | null;
  /** The first reading is still under way. */
  pending: boolean;
  /** The PC asleep: it answers nothing, and that is fine. */
  asleep: boolean;
}

export interface HiddenJob {
  title: string;
  reason: string | null;
}

export interface AutomationBrake {
  /** The gate's own sentence: «paused until 14:00 because Claude is at 92%». */
  text: string;
  until: number | null;
}

export interface AutomationsHead {
  /** The hub served its last good copy: its read failed. */
  stale: boolean;
  /** Tokens of all the automations, by provider; the unmeasured ones are counted apart. */
  usage: { d1: TokensByProvider; d7: TokensByProvider; unmeasured: number; script: number } | null;
  sources: HubSource[];
  hidden: HiddenJob[];
  brakes: Record<string, AutomationBrake>;
  /** Who runs each dated reminder and task, by key: the calendar's «Esegue». */
  calendarWho: Record<string, string>;
}

export function readHead(m: Raw): AutomationsHead {
  const u = asRecord(m.usage);
  const usage = u ? { d1: tokensOf(u.d1), d7: tokensOf(u.d7), unmeasured: num(u.unmeasured) ?? 0, script: num(u.script) ?? 0 } : null;
  const footer = asRecord(m.footer) ?? {};
  const sources = list(footer.sources).flatMap((s): HubSource[] => {
    const o = asRecord(s);
    const name = o && str(o.name);
    if (!o || !name) return [];
    return [{ name, label: str(o.label) ?? name, ok: o.ok === true, at: num(o.at), pending: o.pending === true, asleep: o.note === 'PC dorme' }];
  });
  const hiddenRaw = asRecord(footer.hidden);
  const hidden = list(hiddenRaw?.why).flatMap((h): HiddenJob[] => {
    const o = asRecord(h);
    const title = o && str(o.title);
    return o && title ? [{ title, reason: str(o.reason) }] : [];
  });
  const brakes: Record<string, AutomationBrake> = {};
  for (const [key, b] of Object.entries(asRecord(m.brakes) ?? {})) {
    const o = asRecord(b);
    const text = o && str(o.stateText);
    if (o && text) brakes[key] = { text, until: num(o.until) };
  }
  const calendarWho: Record<string, string> = {};
  for (const c of [...list(m.reminders), ...list(m.tasks)]) {
    const o = asRecord(c);
    const key = o && str(o.key);
    const who = o && str(o.who);
    if (key && who) calendarWho[key] = who;
  }
  return { stale: m.stale === true, usage, sources, hidden, brakes, calendarWho };
}

/** The sources that do not answer now, as the hub counts them: the PC asleep is not one. */
export function silentSources(sources: HubSource[]): HubSource[] {
  return sources.filter((s) => !s.ok && !s.asleep);
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
