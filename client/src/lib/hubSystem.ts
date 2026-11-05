/**
 * Readers of the hub's live topics (state/hubLive.ts): waiting items, alerts,
 * red gates, automations, services and quotas, for the places of Topics that
 * show them (openspec/changes/hub-smistamento). Pure functions over the hub's
 * JSON: the hub owns the shapes (~/.claude/jarvis/tools/usage-hub/src/server.mjs),
 * so everything here is defensive and drops what it does not recognise instead
 * of throwing on a field the hub renamed.
 */

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Waiting for you (the hub's waiting list) ─────────────────────────────────

export const WAITING_KINDS = ['decisione', 'spesa', 'pubblico', 'vista'] as const; // allow-italian: the hub's wire values, compared by value
export type WaitingKind = (typeof WAITING_KINDS)[number];

export interface WaitingItem {
  id: string;
  kind: WaitingKind;
  title: string;
  why: string | null;
  /** http(s), a hub page or `claude://`: the primary action opens it in a new tab. */
  link: string | null;
  from: string | null;
  due: number | null;
  /** When the item was opened (ms): the oldest waits first after the deadlines. */
  since: number | null;
}

/** Where the hub's own pages live: a `#page` link of an item points there. */
const HUB_PAGES_BASE = 'http://127.0.0.1:3360/';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The hub's dashboard listens on the Mac's loopback only, so a `#page` link
 * opens only where this window runs on that same machine. From the phone or a
 * remote session the same address would be the DEVICE's own localhost, a dead
 * link: there the item keeps its close action and no open action.
 */
function hubPageLink(hash: string, windowHost: string): string | null {
  return LOOPBACK_HOSTS.has(windowHost) ? HUB_PAGES_BASE + hash : null;
}

function currentHost(): string {
  return typeof window === 'undefined' ? '' : window.location.hostname;
}

/**
 * The three link forms the hub accepts on an item (its `validateAttesa`):
 * http(s), `#page` of the hub's dashboard, and `claude://`. Anything else is
 * dropped, so the primary action never opens a scheme nobody vetted.
 */
function safeLink(v: unknown, windowHost: string): string | null {
  const s = str(v);
  if (!s) return null;
  if (s.startsWith('#')) return hubPageLink(s, windowHost);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'claude:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The open items, in the hub's own order (most urgent first). */
export function waitingItems(data: unknown, windowHost: string = currentHost()): WaitingItem[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
  const out: WaitingItem[] = [];
  for (const raw of items) {
    if (!isObject(raw)) continue;
    const id = str(raw.id);
    const title = str(raw.title);
    if (!id || !title) continue;
    const kind = (WAITING_KINDS as readonly string[]).includes(String(raw.tipo)) ? (raw.tipo as WaitingKind) : 'decisione'; // allow-italian: the hub's wire value
    out.push({ id, kind, title, why: str(raw.why), link: safeLink(raw.link, windowHost), from: str(raw.from), due: num(raw.due), since: num(raw.at) });
  }
  return out;
}

/** The body the hub expects to close an item. */
export function closeWaitingBody(id: string): { kind: 'chiudi'; ref: string } { // allow-italian: the hub's wire verb
  return { kind: 'chiudi', ref: id }; // allow-italian: the hub's wire verb
}

// ── Alerts (/api/alerts) ─────────────────────────────────────────────────────

export interface FiringAlert {
  id: string;
  subject: string;
  message: string;
  /** Which check fired: the hub's source name, e.g. the one of a project over its budget. */
  source: string;
}

export function firingAlerts(data: unknown): FiringAlert[] {
  const firing = isObject(data) && Array.isArray(data.firing) ? data.firing : [];
  const out: FiringAlert[] = [];
  firing.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const message = str(raw.message) ?? str(raw.subject);
    if (!message) return;
    out.push({ id: str(raw.id) ?? `alert-${i}`, subject: str(raw.subject) ?? '', message, source: str(raw.source) ?? '' });
  });
  return out;
}

// ── Red gates (/api/gates) ───────────────────────────────────────────────────

export interface RedGate {
  id: string;
  /** The delegation class (`interattivo`, `batch`...) or the provider a brake holds. */
  name: string;
  kind: 'class' | 'brake';
  reason: string;
}

/**
 * The hub's gates are the delegation decisions: one per class, plus the brake
 * in front of each batch provider. A gate is red when it says `go: false`.
 */
export function redGates(data: unknown): RedGate[] {
  if (!isObject(data)) return [];
  const out: RedGate[] = [];
  const read = (group: unknown, kind: RedGate['kind']) => {
    if (!isObject(group)) return;
    for (const [name, g] of Object.entries(group)) {
      if (!isObject(g) || g.go !== false) continue;
      out.push({ id: `${kind}:${name}`, name, kind, reason: str(g.reason) ?? '' });
    }
  };
  read(data.classes, 'class');
  read(data.brakes, 'brake');
  return out;
}

// ── Automations (/api/automations/summary) ───────────────────────────────────

export interface AutomationSummary {
  needsYou: number;
  broken: number;
  ok: number;
  runsToday: number;
  next: { title: string; at: number } | null;
}

export function automationSummary(data: unknown): AutomationSummary | null {
  if (!isObject(data)) return null;
  const cal = isObject(data.calendar) && isObject(data.calendar.next) ? data.calendar.next : null;
  const nextTitle = cal ? str(cal.title) : null;
  const nextAt = cal ? num(cal.at) : null;
  return {
    needsYou: num(data.needsYou) ?? 0,
    broken: num(data.broken) ?? 0,
    ok: num(data.ok) ?? 0,
    runsToday: num(data.runsToday) ?? 0,
    next: nextTitle && nextAt !== null ? { title: nextTitle, at: nextAt } : null,
  };
}

export interface FailedJob {
  key: string;
  title: string;
  at: number | null;
  /** The hub's own sentence on it («failed on Sunday at 14:38»). */
  reason: string | null;
}

/** The failed jobs out of the full `/api/automations` answer (its `broken`). */
export function failedJobs(data: unknown): FailedJob[] {
  const broken = isObject(data) && Array.isArray(data.broken) ? data.broken : [];
  const out: FailedJob[] = [];
  for (const raw of broken) {
    if (!isObject(raw)) continue;
    const key = str(raw.key);
    const title = str(raw.title);
    if (!key || !title) continue;
    out.push({ key, title, at: isObject(raw.last) ? num(raw.last.at) : null, reason: str(raw.reason) });
  }
  return out;
}

// ── Services (/api/services) ─────────────────────────────────────────────────

export interface ServiceDown {
  id: string;
  name: string;
  /** What is wrong in the hub's words («not listening on :3342»), null when it is only stopped. */
  problem: string | null;
}

/**
 * A service with a problem, or loaded and not running. A service switched
 * off on purpose is not down, and one that starts on demand and sleeps is
 * waiting, not broken: counting those
 * flagged 6 of 18 services that nobody had to fix.
 */
export function servicesDown(data: unknown): ServiceDown[] {
  const list = isObject(data) && Array.isArray(data.services) ? data.services : [];
  const out: ServiceDown[] = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const problem = str(raw.problem);
    if (!problem && raw.state !== 'fermo') continue; // allow-italian: the hub's service state
    out.push({ id: str(raw.id) ?? String(out.length), name: str(raw.name) ?? str(raw.id) ?? '', problem });
  }
  return out;
}

// ── Quotas (/api/pace) ───────────────────────────────────────────────────────

/** At or above this share of a window the number turns warm. */
export const QUOTA_HOT_AT = 80;

export interface QuotaLine {
  key: string;
  provider: string;
  /** Week window, percent used. */
  used: number;
  /** Five-hour window, percent used, when the provider has one. */
  fiveHour: number | null;
  hot: boolean;
}

/** The windows of the accounts in use right now, one line per account. */
export function quotaLines(data: unknown): QuotaLine[] {
  if (!Array.isArray(data)) return [];
  const out: QuotaLine[] = [];
  for (const raw of data) {
    if (!isObject(raw) || raw.active !== true) continue;
    const provider = str(raw.provider);
    const used = num(raw.used);
    if (!provider || used === null) continue;
    const fiveHour = isObject(raw.fiveHour) ? num(raw.fiveHour.used) : null;
    out.push({
      key: `${provider}:${str(raw.account) ?? out.length}`,
      provider,
      used: Math.round(used),
      fiveHour: fiveHour === null ? null : Math.round(fiveHour),
      hot: used >= QUOTA_HOT_AT || (fiveHour ?? 0) >= QUOTA_HOT_AT,
    });
  }
  return out;
}

// ── Contradictions of the agents' context (/api/contesto) ────────────────────

export interface Contradiction {
  id: string;
  /** Why the two rules clash, one sentence: the file names stay out of sight. */
  why: string;
}

export function contradictions(data: unknown): Contradiction[] {
  const block = isObject(data) && isObject(data.contradictions) ? data.contradictions : null;
  const items = block && Array.isArray(block.items) ? block.items : [];
  const out: Contradiction[] = [];
  items.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const why = str(raw.why);
    if (why) out.push({ id: `contradiction-${i}`, why });
  });
  return out;
}

// ── Account events of the Claude proxy (switchboard /api/activity) ───────────

type AccountEventKind = 'switched' | 'limit' | 'token';

export interface AccountEvent {
  /** One row per kind and account: the proxy writes the same limit thirty times a day. */
  key: string;
  kind: AccountEventKind;
  /** The account's label (from /api/profiles), or the proxy's name for it. */
  account: string | null;
  /** The proxy's own name for the account: what «Renew» sends (`/api/refresh`). */
  profile: string | null;
  /** The account switched to, for a switch. */
  to: string | null;
  at: number;
  count: number;
}

const ACCOUNT_EVENT_KIND: Record<string, AccountEventKind> = {
  'auto-switch': 'switched',
  'proactive-switch': 'switched',
  'manual-switch': 'switched',
  'rate-limited': 'limit',
  'cap-exhausted': 'limit',
  'all-exhausted': 'limit',
  'auth-expired': 'token',
  'refresh-failed': 'token',
};

/** How far back the bell looks in the proxy's log. */
const ACCOUNT_EVENTS_WINDOW_MS = 24 * 3_600_000;

/**
 * The facts of the proxy that the person must hear about: an account
 * switched, a limit reached, a token expired. The rest of its log (retries,
 * priorities, discovered accounts) stays in the Log. A token refreshed after a
 * failure clears that failure.
 */
export function accountEvents(activity: unknown, profiles: unknown, now: number): AccountEvent[] {
  const log = isObject(activity) && Array.isArray(activity.log) ? activity.log : [];
  const labels = new Map<string, string>();
  const list = isObject(profiles) && Array.isArray(profiles.profiles) ? profiles.profiles : [];
  for (const p of list) {
    if (!isObject(p)) continue;
    const name = str(p.name);
    if (name) labels.set(name, str(p.label) ?? name);
  }
  const label = (v: unknown): string | null => { const s = str(v); return s ? labels.get(s) ?? s : null; };
  const refreshed = new Map<string, number>();
  for (const raw of log) {
    if (!isObject(raw) || raw.type !== 'token-refreshed') continue;
    const name = str(raw.account);
    const at = num(raw.ts);
    if (name && at !== null) refreshed.set(name, Math.max(at, refreshed.get(name) ?? 0));
  }
  const byKey = new Map<string, AccountEvent>();
  for (const raw of log) {
    if (!isObject(raw)) continue;
    const kind = ACCOUNT_EVENT_KIND[String(raw.type)];
    const at = num(raw.ts);
    if (!kind || at === null || now - at > ACCOUNT_EVENTS_WINDOW_MS || at > now) continue;
    const rawAccount = str(raw.account) ?? str(raw.from) ?? str(raw.name);
    if (kind === 'token' && rawAccount && (refreshed.get(rawAccount) ?? 0) > at) continue;
    const account = label(rawAccount);
    const key = `${kind}:${kind === 'switched' ? '' : account ?? ''}`;
    const to = kind === 'switched' ? label(raw.to) : null;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { key, kind, account, profile: rawAccount, to, at, count: 1 }); continue; }
    prev.count += 1;
    if (at > prev.at) Object.assign(prev, { account, profile: rawAccount, to, at });
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at);
}

// ── Diary of automations and agents (/api/diario) ────────────────────────────

type DiaryKind = 'auto' | 'app' | 'workflow' | 'agente' | 'tu'; // allow-italian: the hub's wire values

export interface DiaryEntry {
  id: string;
  at: number;
  kind: DiaryKind;
  /** Who did it, in the hub's words («Mac», «Agente · Muse», «Tu»). */
  who: string;
  title: string;
  /** `ok`, `error`, `undelivered`, `skipped`, `running`, `queued`, or null. */
  outcome: string | null;
  what: string;
}

const DIARY_KINDS: readonly string[] = ['auto', 'app', 'workflow', 'agente', 'tu']; // allow-italian: the hub's wire values

/**
 * The diary the bell's History shows: failed runs, the agents' work (the
 * «Fix it» jobs among them), workflows and what the person said. A run of an
 * automation that went well, or was skipped, is routine: 1,615 of 1,781 rows
 * of a week were those, and they stay on the automation's own card.
 */
export function diaryForHistory(data: unknown): DiaryEntry[] {
  const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
  const out: DiaryEntry[] = [];
  items.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const at = num(raw.at);
    const title = str(raw.title);
    const kind = String(raw.kind);
    if (at === null || !title || !DIARY_KINDS.includes(kind)) return;
    const outcome = str(raw.outcome);
    if ((kind === 'auto' || kind === 'app') && (outcome === null || outcome === 'ok' || outcome === 'skipped')) return;
    out.push({ id: `diary-${at}-${i}`, at, kind: kind as DiaryKind, who: str(raw.who) ?? '', title, outcome, what: str(raw.what) ?? '' });
  });
  return out.sort((a, b) => b.at - a.at);
}
