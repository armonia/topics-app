/**
 * ACCOUNTS AND QUOTAS (hub-smistamento, HUBBR-10 and HUBBR-11): what the usage
 * hub and the Claude proxy say about the plans, read into the shapes the view
 * draws, and every write the view can send.
 *
 *   /api/switchboard/profiles  the Claude accounts of the proxy (windows, cap,
 *                              priority, on/off, token) and the reserve API keys
 *   /api/switchboard/settings  the proxy's rules: on/off, automatic switch,
 *                              rotation, global caps, queue, dollar to euro
 *   hub:live pace              every plan's week and five hours, Codex and Muse
 *                              included (the proxy sees only Claude)
 *   hub:live gates             the brake: per class of work the providers in
 *                              order and today's pick, per provider braked or
 *                              free, the unlocks and the background stop
 *
 * Commands exist only where the proxy has them, i.e. on the Claude accounts:
 * Codex and Muse are read-only, with the hub's «unlock the brake for N hours».
 * Pure on purpose: the wire shapes are the part that can be wrong in silence.
 */

/** One window of a plan: the share used and when it starts again. */
export interface QuotaWindow {
  pct: number;
  resetsAtMs: number | null;
}

export type AccountState = 'in-use' | 'ready' | 'off' | 'capped' | 'limited' | 'expired';

export interface ClaudeAccount {
  name: string;
  label: string;
  /** «Max 20x», «Pro»; null when the proxy does not say. */
  plan: string | null;
  active: boolean;
  disabled: boolean;
  priority: number;
  state: AccountState;
  fiveH: QuotaWindow | null;
  week: QuotaWindow | null;
  /** The account's own caps (null = inherits), the ones in force, and whether one is reached. */
  cap: { ownFiveH: number | null; ownWeek: number | null; fiveH: number | null; week: number | null; over: boolean };
}

export interface ApiKey {
  name: string;
  label: string;
  priority: number;
  disabled: boolean;
}

export interface ProxyAccounts {
  accounts: ClaudeAccount[];
  keys: ApiKey[];
  allExhausted: boolean;
}

/** The provider ids of the hub that are metered but not commanded from here. */
export const METERED_PROVIDERS = ['codex', 'muse'] as const;
export type MeteredProviderId = (typeof METERED_PROVIDERS)[number];

export interface MeteredProvider {
  provider: MeteredProviderId;
  account: string;
  fiveH: number | null;
  week: number | null;
  weekResetsAtMs: number | null;
  /** Used share against the share of the week gone: 1 is on pace. */
  pace: number | null;
  /** The hub's quota reading is old (Muse is read from a page). */
  stale: boolean;
  braked: boolean;
  brakeReason: string | null;
  /** An unlock in force until then, ms epoch. */
  unlockedUntil: number | null;
}

export interface ProxySettings {
  proxyEnabled: boolean;
  autoSwitch: boolean;
  notifications: boolean;
  rotationStrategy: string;
  rotationIntervalMin: number;
  maxConcurrentPerAccount: number;
  serializeRequests: boolean;
  usageCap5h: number | null;
  usageCap7d: number | null;
  usageCapHoldMin: number;
  usdEur: number;
}

/** The hub's classes of work, in the order a person reads them. */
export const WORK_CLASSES = ['interattivo', 'gusto', 'massivo', 'batch'] as const; // allow-italian: the hub's class ids, compared by value

export interface BrakeClass {
  id: string;
  order: string[];
  go: boolean;
  provider: string | null;
  reason: string;
}

export interface PaceLine {
  provider: string;
  account: string;
  used: number;
  elapsedPct: number | null;
  pace: number | null;
}

/** The proxy's rotation strategies, in its own order. An unknown one is shown by its id. */
export const ROTATION_STRATEGIES = ['margin', 'reset-first', 'priority', 'sticky', 'conserve', 'round-robin', 'spread', 'drain-first', 'balance'] as const;
export const ROTATION_INTERVALS = [15, 30, 60, 120] as const;
export const PARALLEL_STEPS = [2, 4, 6, 8, 12, 16] as const;
export const HOLD_STEPS = [0, 1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440] as const;
/** Hours offered by the hub's unlock and background stop. */
export const UNLOCK_HOURS = 2;
export const HOLD_HOURS = [1, 2, 4] as const;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** «Max 20x», «Pro», «Team»: the plan a person names; null when the proxy does not say. */
export function planName(sub: unknown, tier: unknown): string | null {
  const s = String(sub ?? '').toLowerCase();
  const t = String(tier ?? '').toLowerCase();
  if (s === 'max' || t.includes('max')) {
    const m = /(\d+)x/.exec(t);
    return m ? `Max ${m[1]}x` : 'Max';
  }
  if (s === 'pro') return 'Pro';
  if (s === 'team') return 'Team';
  if (s === 'enterprise') return 'Enterprise';
  return null;
}

/** A proxy window ({utilization 0..1, reset unix s}) as a share in % and a reset in ms. */
function proxyWindow(w: unknown): QuotaWindow | null {
  if (!isRec(w)) return null;
  const u = num(w.utilization);
  if (u === null) return null;
  const reset = num(w.reset);
  return { pct: Math.round(u * 100), resetsAtMs: reset === null ? null : reset * 1000 };
}

function stateOf(p: Rec, over: boolean, now: number): AccountState {
  if (p.disabled === true) return 'off';
  const expiresAt = num(p.expiresAt);
  const expired = p.expired === true || isRec(p.refreshFailed) || (expiresAt !== null && expiresAt < now);
  if (p.isActive !== true && expired) return 'expired';
  if (p.isActive === true) return 'in-use';
  if (over) return 'capped';
  if (p.limited === true) return 'limited';
  return 'ready';
}

/**
 * The proxy's accounts in the order they are used: the one in use, then by
 * priority (higher first), the switched-off ones last. Null when the answer is
 * not the proxy's list (proxy down, an error object).
 */
export function readProxyAccounts(raw: unknown, now = Date.now()): ProxyAccounts | null {
  if (!isRec(raw) || !Array.isArray(raw.profiles)) return null;
  const accounts: ClaudeAccount[] = [];
  for (const p of raw.profiles) {
    if (!isRec(p) || !str(p.name)) continue;
    const rl = isRec(p.rateLimits) ? p.rateLimits : {};
    const cap = isRec(p.cap) ? p.cap : {};
    const own = isRec(cap.override) ? cap.override : {};
    const eff = isRec(cap.effective) ? cap.effective : {};
    const over = cap.over === true;
    accounts.push({
      name: String(p.name),
      label: str(p.label) ?? String(p.name),
      plan: planName(p.subscriptionType, p.rateLimitTier),
      active: p.isActive === true,
      disabled: p.disabled === true,
      priority: num(p.priority) ?? 0,
      state: stateOf(p, over, now),
      fiveH: proxyWindow(rl.fiveH),
      week: proxyWindow(rl.sevenD),
      cap: { ownFiveH: num(own.fiveH), ownWeek: num(own.sevenD), fiveH: num(eff.fiveH), week: num(eff.sevenD), over },
    });
  }
  const rank = (a: ClaudeAccount) => (a.active ? 0 : a.disabled ? 2 : 1);
  accounts.sort((a, b) => rank(a) - rank(b) || b.priority - a.priority);
  const keys: ApiKey[] = (Array.isArray(raw.apiProfiles) ? raw.apiProfiles : [])
    .filter((k): k is Rec => isRec(k) && !!str(k.name))
    .map((k) => ({ name: String(k.name), label: str(k.label) ?? String(k.name), priority: num(k.priority) ?? 0, disabled: k.disabled === true }))
    .sort((a, b) => b.priority - a.priority);
  return { accounts, keys, allExhausted: raw.allExhausted === true };
}

/**
 * The priority that moves a reserve key one place up (-1) or down (+1) in the
 * order the proxy uses them (higher first); null at the edge.
 */
export function keyMove(keys: ApiKey[], index: number, dir: -1 | 1): { name: string; priority: number } | null {
  const key = keys[index];
  const other = keys[index + dir];
  if (!key || !other) return null;
  return { name: key.name, priority: dir === -1 ? other.priority + 1 : other.priority - 1 };
}

/** A cap typed by a person: empty is «none», 1..99 is a cap, anything else is refused. */
export function capInput(text: string): number | null | 'invalid' {
  const t = text.trim();
  if (t === '') return null;
  const v = Math.round(Number(t));
  return Number.isFinite(v) && v >= 1 && v <= 99 && /^\d+$/.test(t) ? v : 'invalid';
}

/** The proxy's rules, or null when the answer is not them. */
export function readProxySettings(raw: unknown): ProxySettings | null {
  if (!isRec(raw) || typeof raw.proxyEnabled !== 'boolean') return null;
  return {
    proxyEnabled: raw.proxyEnabled,
    autoSwitch: raw.autoSwitch === true,
    notifications: raw.notifications !== false,
    rotationStrategy: str(raw.rotationStrategy) ?? 'sticky',
    rotationIntervalMin: num(raw.rotationIntervalMin) ?? 60,
    maxConcurrentPerAccount: num(raw.maxConcurrentPerAccount) ?? 8,
    serializeRequests: raw.serializeRequests === true,
    usageCap5h: num(raw.usageCap5h),
    usageCap7d: num(raw.usageCap7d),
    usageCapHoldMin: num(raw.usageCapHoldMin) ?? 10,
    usdEur: num(raw.usdEur) ?? 0.92,
  };
}

interface Override { provider: string; until: number; hold: boolean; exhausted: boolean }

function overridesOf(gates: unknown, now: number): Override[] {
  if (!isRec(gates) || !Array.isArray(gates.overrides)) return [];
  return gates.overrides
    .filter(isRec)
    .map((o) => ({ provider: String(o.provider ?? ''), until: num(o.until) ?? 0, hold: o.hold === true, exhausted: o.exhausted === true }))
    .filter((o) => o.until > now);
}

/** Until when the background work is stopped by hand, ms epoch; null when it is not. */
export function backgroundHold(gates: unknown, now = Date.now()): number | null {
  const h = overridesOf(gates, now).filter((o) => o.hold);
  return h.length ? Math.max(...h.map((o) => o.until)) : null;
}

/**
 * Codex and Muse as the hub measures them: the account in use (else the first),
 * its windows, its pace, and the brake on it. Only the providers the hub has.
 */
export function meteredProviders(pace: unknown, gates: unknown, now = Date.now()): MeteredProvider[] {
  const rows = Array.isArray(pace) ? pace.filter(isRec) : [];
  const providers = isRec(gates) && isRec(gates.providers) ? gates.providers : {};
  const unlocks = overridesOf(gates, now).filter((o) => !o.hold && !o.exhausted);
  const out: MeteredProvider[] = [];
  for (const id of METERED_PROVIDERS) {
    const mine = rows.filter((r) => r.provider === id);
    const row = mine.find((r) => r.active === true) ?? mine[0];
    if (!row) continue;
    const g = isRec(providers[id]) ? providers[id] as Rec : {};
    const five = isRec(row.fiveHour) ? num(row.fiveHour.used) : null;
    const until = unlocks.filter((o) => o.provider === id).map((o) => o.until);
    out.push({
      provider: id,
      account: str(row.account) ?? id,
      fiveH: five,
      week: num(row.used),
      weekResetsAtMs: num(row.resetsAt),
      pace: num(row.pace),
      stale: row.quotaStale === true,
      braked: g.state === 'frenato' || g.state === 'esaurito', // allow-italian: the hub's state values
      brakeReason: str(g.reason),
      unlockedUntil: until.length ? Math.max(...until) : null,
    });
  }
  return out;
}

/** The brake per class of work: the providers in the order they are tried, and today's pick. */
export function brakeClasses(gates: unknown): BrakeClass[] {
  if (!isRec(gates) || !isRec(gates.classes)) return [];
  const classes = gates.classes;
  return WORK_CLASSES.filter((id) => isRec(classes[id])).map((id) => {
    const c = classes[id] as Rec;
    return {
      id,
      order: Array.isArray(c.order) ? c.order.filter((x): x is string => typeof x === 'string') : [],
      go: c.go === true,
      provider: str(c.provider),
      reason: str(c.reason) ?? '',
    };
  });
}

/** Each provider's pace: the account in use, its week used against the week gone. */
export function paceLines(pace: unknown): PaceLine[] {
  const rows = Array.isArray(pace) ? pace.filter(isRec) : [];
  const seen = new Set<string>();
  const out: PaceLine[] = [];
  for (const r of [...rows].sort((a, b) => Number(b.active === true) - Number(a.active === true))) {
    const p = str(r.provider);
    const used = num(r.used);
    if (!p || used === null || seen.has(p)) continue;
    seen.add(p);
    out.push({ provider: p, account: str(r.account) ?? p, used, elapsedPct: num(r.elapsedPct), pace: num(r.pace) });
  }
  return out;
}

/** How many plans the hub meters: the rows of `pace`. */
export function planCount(pace: unknown): number {
  return Array.isArray(pace) ? pace.filter(isRec).length : 0;
}

export type AccountCommand =
  | { kind: 'switch' | 'refresh' | 'remove'; name: string }
  | { kind: 'priority'; name: string; priority: number }
  | { kind: 'enabled'; name: string; enabled: boolean }
  | { kind: 'cap'; name: string; fiveH: number | null; sevenD: number | null }
  | { kind: 'key'; name: string; priority?: number; disabled?: boolean }
  | { kind: 'setting'; patch: Partial<ProxySettings> }
  | { kind: 'unlock'; provider: MeteredProviderId; hours: number }
  | { kind: 'relock'; provider: MeteredProviderId }
  | { kind: 'hold'; hours: number }
  | { kind: 'release' };

export interface CommandRequest {
  path: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}

/** Who the hub writes down as the author of an unlock or a stop. */
const BY = 'topics';

/**
 * The request behind each command. The account commands go to the Claude
 * proxy; the unlock and the background stop to the hub, the only writes the
 * hub takes from here.
 */
export function commandRequest(c: AccountCommand): CommandRequest {
  const sb = (p: string) => `/api/switchboard/${p}`;
  switch (c.kind) {
    case 'switch': case 'refresh': case 'remove':
      return { path: sb(c.kind), method: 'POST', body: { name: c.name } };
    case 'priority': return { path: sb('priority'), method: 'POST', body: { name: c.name, priority: c.priority } };
    case 'enabled': return { path: sb('account-enabled'), method: 'POST', body: { name: c.name, enabled: c.enabled } };
    case 'cap': return { path: sb('account-cap'), method: 'POST', body: { name: c.name, fiveH: c.fiveH, sevenD: c.sevenD } };
    case 'key': {
      const body: Record<string, unknown> = { name: c.name };
      if (c.priority !== undefined) body.priority = c.priority;
      if (c.disabled !== undefined) body.disabled = c.disabled;
      return { path: sb('api-profiles'), method: 'PATCH', body };
    }
    case 'setting': return { path: sb('settings'), method: 'POST', body: { ...c.patch } };
    case 'unlock': return { path: '/api/hub/override', method: 'POST', body: { provider: c.provider, hours: c.hours, by: BY, reason: 'sbloccato da Topics' } }; // allow-italian: the hub's log reads Italian
    case 'relock': return { path: `/api/hub/override?provider=${encodeURIComponent(c.provider)}`, method: 'DELETE' };
    case 'hold': return { path: '/api/hub/hold', method: 'POST', body: { hours: c.hours, by: BY, reason: 'fermati da Topics' } }; // allow-italian: the hub's log reads Italian
    case 'release': return { path: '/api/hub/hold', method: 'DELETE' };
  }
}
