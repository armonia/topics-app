/**
 * ACCOUNTS AND QUOTAS, WHAT THE BARS ALONE DO NOT SAY (hub-smistamento,
 * HUBBR-10): the parts of the proxy's and the hub's answers that the hub's
 * own page drew and the first move into Topics left out.
 *
 *   /api/switchboard/profiles  the probes the proxy spends and its live queue;
 *                              per account how much of each window went
 *                              through the proxy (internal) and how much was
 *                              spent elsewhere (external: claude.ai, other
 *                              apps, other computers), and the 24 hours and
 *                              7 days of each window, for a trend
 *   /api/hub/board             per account the hub's pace dial and its zone,
 *                              when the quota runs out at the last 24 hours'
 *                              pace and the tokens left, the 24 hours and the
 *                              per-model windows, the bonus credit, the login
 *                              and how the windows reset, and who spent the
 *                              last 24 hours; also the accounts whose login
 *                              died, which have no quota and so no other card
 *
 * The hub writes its sentences in Italian: they are kept as they come and the
 * view shows them only in Italian (`hubProse`), as every other hub sentence.
 * Pure on purpose: the wire shapes are the part that can be wrong in silence.
 */

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export interface ProxyHealth {
  /** The proxy's probes of the last 7 days and the tokens they cost: what the conserve strategy burns. */
  probes: { count: number; tokens: number } | null;
  /** The proxy's queue now: with «balance» the requests in flight and waiting for a slot, otherwise in flight and in line. */
  queue: { balance: boolean; running: number; waiting: number } | null;
}

/** The proxy's probes and queue; null parts when the proxy does not say or there is nothing to say. */
export function readProxyHealth(raw: unknown): ProxyHealth {
  const ps = isObject(raw) && isObject(raw.probeStats) ? raw.probeStats : null;
  const q = isObject(raw) && isObject(raw.queueStats) ? raw.queueStats : null;
  const count = ps ? num(ps.probeCount7d) ?? 0 : 0;
  let queue: ProxyHealth['queue'] = null;
  if (q) {
    const balance = q.balanceMode === true;
    const running = num(balance ? q.balanceInflight : q.inflight) ?? 0;
    const waiting = num(balance ? q.balanceWaiting : q.queued) ?? 0;
    if (running > 0 || waiting > 0) queue = { balance, running, waiting };
  }
  return {
    probes: ps && count > 0 ? { count, tokens: (num(ps.inputTokens) ?? 0) + (num(ps.outputTokens) ?? 0) } : null,
    queue,
  };
}

/** A slice of a window: the proxy carried tokens (mine), the quota moved without it (outside), nothing moved (idle), not measured. */
export type BandKind = 'mine' | 'outside' | 'idle' | 'unknown';

export interface AttributionBand {
  fromMs: number;
  toMs: number;
  kind: BandKind;
  tokens: number;
  requests: number;
  usd: number;
  /** Quota moved in the band, in points of %; null when not measured. */
  deltaPct: number | null;
}

export interface AttributionWindow {
  bands: AttributionBand[];
  /** Through the proxy in the window: tokens, their list price in dollars, requests. */
  tokens: number;
  usd: number;
  requests: number;
  /** Input and output against cache reads and writes, the proxy's own counts. */
  io: number;
  cache: number;
  /** Share of the window's quota spent outside the proxy, 0..1; null when not measured. */
  externalShare: number | null;
  /** Share of the window the external share was measured on, 0..1. */
  coverage: number;
}

export interface TrendPoint { ts: number; pct: number }

export interface AccountTrail {
  fiveH: AttributionWindow | null;
  week: AttributionWindow | null;
  /** The five-hour window over the last 24 hours and the week over the last 7 days, in %. */
  history5h: TrendPoint[];
  historyWeek: TrendPoint[];
}

function readBand(b: JsonObject): AttributionBand | null {
  const fromMs = num(b.from);
  const toMs = num(b.to);
  if (fromMs === null || toMs === null) return null;
  const tokens = num(b.myTokens) ?? 0;
  const delta = num(b.deltaUtil);
  const kind: BandKind = tokens > 0 ? 'mine' : delta === null ? 'unknown' : delta > 0 ? 'outside' : 'idle';
  return { fromMs, toMs, kind, tokens, requests: num(b.requests) ?? 0, usd: num(b.myCostUsd) ?? 0, deltaPct: delta === null ? null : Math.round(delta * 100) };
}

function readWindow(w: unknown): AttributionWindow | null {
  if (!isObject(w)) return null;
  const tb = isObject(w.tokenBreakdown) ? w.tokenBreakdown : {};
  return {
    bands: (Array.isArray(w.bands) ? w.bands.filter(isObject) : []).map(readBand).filter((b): b is AttributionBand => b !== null),
    tokens: num(w.myTokens) ?? 0,
    usd: num(w.myCostUsd) ?? 0,
    requests: num(w.requests) ?? 0,
    io: (num(tb.inputTokens) ?? 0) + (num(tb.outputTokens) ?? 0),
    cache: (num(tb.cacheReadTokens) ?? 0) + (num(tb.cacheCreationTokens) ?? 0),
    externalShare: num(w.externalShare),
    coverage: num(w.coverage) ?? 0,
  };
}

function readTrend(list: unknown, key: 'u5h' | 'u7d'): TrendPoint[] {
  return (Array.isArray(list) ? list.filter(isObject) : []).flatMap((p) => {
    const ts = num(p.ts);
    const u = num(p[key]);
    return ts !== null && u !== null ? [{ ts, pct: Math.round(u * 100) }] : [];
  }).sort((a, b) => a.ts - b.ts);
}

/** Per Claude account of the proxy, by name: its windows' attribution and their trend. */
export function readAccountTrails(raw: unknown): Map<string, AccountTrail> {
  const out = new Map<string, AccountTrail>();
  const profiles = isObject(raw) && Array.isArray(raw.profiles) ? raw.profiles.filter(isObject) : [];
  for (const p of profiles) {
    const name = str(p.name);
    if (!name) continue;
    const attr = isObject(p.attribution) ? p.attribution : {};
    out.set(name, {
      fiveH: readWindow(attr.fiveH),
      week: readWindow(attr.sevenD),
      history5h: readTrend(p.utilizationHistory, 'u5h'),
      historyWeek: readTrend(p.weeklyHistory, 'u7d'),
    });
  }
  return out;
}

export type Verdict =
  | { kind: 'unmeasured' }
  /** Measured on less than a quarter of the window: an estimate, said as one. */
  | { kind: 'partial'; coveragePct: number; externalPct: number }
  | { kind: 'measured'; internalPct: number; externalPct: number };

/** How much of a window went through the proxy and how much outside it, said as honestly as it was measured. */
export function attributionVerdict(w: AttributionWindow): Verdict {
  if (w.externalShare === null) return { kind: 'unmeasured' };
  const externalPct = Math.round(w.externalShare * 100);
  if (w.coverage < 0.25) return { kind: 'partial', coveragePct: Math.round(w.coverage * 100), externalPct };
  return { kind: 'measured', internalPct: 100 - externalPct, externalPct };
}

export interface BoardWindow {
  key: string;
  label: string;
  used: number;
  /** Where you should be: the sustainable daily share for the 24 hours. */
  mark: number | null;
  note: string | null;
  reset: string | null;
  tone: 'ok' | 'warn' | 'bad';
}

export interface BoardAccount {
  provider: string;
  account: string;
  /** The pace dial, only where the pace is measured: the needle 0..2, 1 is on pace. */
  dial: { needle: number; value: number | null; zone: string } | null;
  state: { text: string; tone: 'ok' | 'warn' | 'bad' | 'mut' };
  /** Why the dial says what it says, in the hub's words. */
  reason: string | null;
  /** The windows past the 5 hours and the week: the last 24 hours against the daily share, per model (Fable). */
  windows: BoardWindow[];
  bonus: { left: number; limit: number; used: number; renews: string | null; stale: boolean } | null;
  access: { state: string; say: string; fiveH: string | null; week: string | null; link: string | null } | null;
  /** Who spent the last 24 hours, Claude only; `topNote` says why there is none. */
  top: Array<{ name: string; tokens: number; pct: number }> | null;
  topNote: string | null;
  /** When the quota runs out at the last 24 hours' pace, and the tokens left and per day. */
  end: { text: string; tone: 'ok' | 'warn' | 'bad'; hint: string | null } | null;
  tokens: { left: string; perDay: string; hint: string | null } | null;
}

const TONES3 = ['ok', 'warn', 'bad'] as const;
const tone3 = (v: unknown): 'ok' | 'warn' | 'bad' => (TONES3 as readonly unknown[]).includes(v) ? v as 'ok' | 'warn' | 'bad' : 'ok';

function readBoardWindow(w: JsonObject): BoardWindow | null {
  const key = str(w.key);
  const used = num(w.used);
  if (!key || used === null || key === 'week' || key === '5h') return null;
  return { key, label: str(w.label) ?? key, used, mark: num(w.mark), note: str(w.note), reset: str(w.reset), tone: tone3(w.tone) };
}

/** The hub board's accounts, every provider, in the hub's order. */
export function readBoardAccounts(board: unknown): BoardAccount[] {
  const rows = isObject(board) && Array.isArray(board.accounts) ? board.accounts.filter(isObject) : [];
  return rows.flatMap((a): BoardAccount[] => {
    const provider = str(a.provider);
    const account = str(a.email) ?? str(a.name);
    if (!provider || !account) return [];
    const g = isObject(a.gauge) ? a.gauge : {};
    const st = isObject(a.state) ? a.state : {};
    const needle = num(g.needle);
    const access = isObject(a.access) ? a.access : null;
    const resets = access && isObject(access.resets) ? access.resets : {};
    const say = (o: unknown) => (isObject(o) ? str(o.say) : null);
    const bonus = isObject(a.bonus) ? a.bonus : null;
    const end = isObject(a.end) ? a.end : null;
    const tokens = isObject(a.tokens) ? a.tokens : null;
    const stTone = st.tone === 'mut' ? 'mut' : tone3(st.tone);
    return [{
      provider,
      account,
      dial: st.dial === true && needle !== null ? { needle, value: num(g.value), zone: str(st.zone) ?? str(g.zone) ?? 'ignoto' } : null, // allow-italian: the hub's zone id
      state: { text: str(st.text) ?? '', tone: stTone },
      reason: str(g.reason),
      windows: (Array.isArray(a.windows) ? a.windows.filter(isObject) : []).map(readBoardWindow).filter((w): w is BoardWindow => w !== null),
      bonus: bonus && num(bonus.limit) !== null ? { left: num(bonus.left) ?? 0, limit: num(bonus.limit) ?? 0, used: num(bonus.used) ?? 0, renews: str(bonus.renews), stale: bonus.stale === true } : null,
      access: access ? { state: str(access.state) ?? 'ignoto', say: str(access.say) ?? '', fiveH: say(resets.fiveHour), week: say(resets.week), link: str(access.link) } : null, // allow-italian: the hub's state id
      top: Array.isArray(a.top) ? a.top.filter(isObject).map((t) => ({ name: str(t.name) ?? '', tokens: num(t.tokens) ?? 0, pct: num(t.pct) ?? 0 })) : null,
      topNote: str(a.topNote),
      end: end && str(end.text) ? { text: str(end.text)!, tone: tone3(end.tone), hint: str(end.hint) } : null,
      tokens: tokens && str(tokens.left) ? { left: str(tokens.left)!, perDay: str(tokens.perDay) ?? '', hint: str(tokens.hint) } : null,
    }];
  });
}

/** The board's account for a card: same provider, same account (the proxy's label or name, the hub's email), case aside. */
export function boardAccountFor(list: BoardAccount[], provider: string, ...names: string[]): BoardAccount | null {
  const want = names.map((n) => n.toLowerCase());
  return list.find((b) => b.provider === provider && want.includes(b.account.toLowerCase())) ?? null;
}

/**
 * The board's accounts no card shows: an account whose login died has no
 * quota, so neither the proxy nor the hub's pace lists it, and only the board
 * still names it. Those get a card of their own that says so.
 */
export function orphanBoardAccounts(list: BoardAccount[], shown: Array<{ provider: string; names: string[] }>): BoardAccount[] {
  return list.filter((b) => !shown.some((s) => s.provider === b.provider && s.names.some((n) => n.toLowerCase() === b.account.toLowerCase())));
}

/** The hub's login states that mean the account gets no work until someone logs in again. */
export function loginBroken(b: BoardAccount): boolean {
  return b.access !== null && ['scaduto', 'manca'].includes(b.access.state); // allow-italian: the hub's state ids
}
