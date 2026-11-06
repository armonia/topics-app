/**
 * THE CLAUDE PROXY'S ACTIVITY LOG, read the way the hub's Activity page read
 * it (usage-hub public/switchboard-tabs.js, `EVT`): every type the proxy
 * writes (`logActivity`, up to 100 events over seven days on `/api/activity`)
 * becomes a sentence, a severity and an icon family, the account's file name
 * turned into its label (`/api/profiles`). A type this table does not know is
 * still shown, as «proxy event (type)», so a new kind of event never goes
 * silent. Pure: the bell's History renders what this returns.
 */
import { proxyLabels } from './proxyLabels';

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The hub's five dots: fine, news, a warning, a problem, a change of settings. */
export type ProxyTone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

/** What the event is about: it picks the row's icon. */
export type ProxyFamily = 'switch' | 'limit' | 'token' | 'retry' | 'account' | 'settings' | 'upgrade' | 'other';

/** A sentence of the catalogue with its values, or a text the proxy wrote (an error, a list of names). */
export type ProxyText = { key: string; vars?: Record<string, string | number> } | { text: string };

export interface ProxyEvent {
  id: string;
  at: number;
  /** The proxy's own type, as written in the log. */
  type: string;
  tone: ProxyTone;
  family: ProxyFamily;
  text: ProxyText;
  /** The part the hub wrote small beside the sentence: the error code, the minutes, the names. */
  detail: ProxyText | null;
}


/** Seconds to wait, as the hub said them: whole minutes, at least one. */
function minutes(seconds: unknown): number | null {
  const s = num(seconds);
  return s !== null && s > 0 ? Math.max(1, Math.round(s / 60)) : null;
}

type Label = (v: unknown) => string;
type Described = { tone: ProxyTone; family: ProxyFamily; text: ProxyText; detail?: ProxyText | null };
type Describer = (e: Raw, L: Label) => Described;

const K = 'proxy.event.';
const say = (key: string, vars?: Record<string, string | number>): ProxyText => ({ key: `${K}${key}`, ...(vars ? { vars } : {}) });
const wait = (e: Raw): ProxyText | null => { const n = minutes(e.retryAfter); return n === null ? null : say('minutes', { n }); };
const attempt = (e: Raw): ProxyText | null => (num(e.attempt) !== null ? say('attempt', { n: num(e.attempt)! }) : null);
const who = (e: Raw): unknown => e.name ?? e.account;

/** The per-account cap the proxy keeps (`account-cap`), as the hub wrote it. */
function capText(e: Raw): ProxyText {
  const five = num(e.fiveH);
  const week = num(e.sevenD);
  if (five === null && week === null) return say('capNone');
  if (five !== null && week !== null) return say('capBoth', { five, week });
  return five !== null ? say('capFive', { n: five }) : say('capWeek', { n: week! });
}

/** One line per type the proxy writes; the 31 of the hub's page. */
const DESCRIBE: Record<string, Describer> = {
  'auto-switch': (e, L) => ({
    tone: 'info', family: 'switch', text: say('autoSwitch', { from: L(e.from), to: L(e.to) }),
    detail: str(e.reason) || num(e.reason) !== null ? say('reason', { code: String(e.reason).replace(/-error$/, '') }) : null,
  }),
  'proactive-switch': (e, L) => ({
    tone: 'info', family: 'switch', text: e.from ? say('proactiveSwitch', { from: L(e.from), to: L(e.to) }) : say('proactiveSwitchTo', { to: L(e.to) }),
  }),
  'manual-switch': (e, L) => ({ tone: 'info', family: 'switch', text: say('manualSwitch', { to: L(e.to) }) }),
  'rate-limited': (e, L) => ({ tone: 'warn', family: 'limit', text: say('rateLimited', { account: L(e.account) }), detail: wait(e) }),
  'balance-cooldown': (e, L) => ({ tone: 'warn', family: 'limit', text: say('balanceCooldown', { account: L(e.account) }), detail: wait(e) }),
  'balance-overflow': (e, L) => ({
    tone: 'warn', family: 'limit', text: say('balanceOverflow', { account: L(e.account) }),
    detail: num(e.cap) !== null || str(e.cap) ? say('maxParallel', { n: String(e.cap) }) : null,
  }),
  'model-limited': (e, L) => ({ tone: 'warn', family: 'limit', text: say('modelLimited', { account: L(e.account), model: str(e.model) ?? '?' }), detail: wait(e) }),
  'model-recovered': (e, L) => ({ tone: 'ok', family: 'limit', text: say('modelRecovered', { account: L(e.account), model: str(e.model) ?? '?' }) }),
  'cap-hold': () => ({ tone: 'warn', family: 'limit', text: say('capHold') }),
  'cap-exhausted': (e, L) => {
    const capped = Array.isArray(e.capped) ? e.capped.map(L) : [];
    return { tone: 'bad', family: 'limit', text: say('capExhausted'), detail: capped.length ? { text: capped.join(', ') } : null };
  },
  'all-exhausted': () => ({ tone: 'bad', family: 'limit', text: say('allExhausted') }),
  'auth-expired': (e, L) => ({ tone: 'bad', family: 'token', text: say('authExpired', { account: L(e.account) }) }),
  'permission-blocked': (e, L) => ({ tone: 'bad', family: 'token', text: say('permissionBlocked', { account: L(e.account) }) }),
  'bad-request-400': (e, L) => ({
    tone: 'warn', family: 'retry', text: say('badRequest', { account: L(e.account) }),
    detail: (num(e.consecutive) ?? 0) > 1 ? say('inARow', { n: num(e.consecutive)! }) : null,
  }),
  'reserved-mcp-schema-error': (e, L) => ({ tone: 'warn', family: 'retry', text: say('mcpSchema', { account: L(e.account) }) }),
  'openclaw-isolated-retry': (e, L) => ({ tone: 'info', family: 'retry', text: say('openclawRetry', { from: L(e.from), to: L(e.to) }) }),
  'openclaw-ambiguous-extra-usage': (e, L) => ({ tone: 'warn', family: 'retry', text: say('openclawExtra', { account: L(e.account) }) }),
  'upstream-retry': (e, L) => ({
    tone: 'warn', family: 'retry', text: say('upstreamRetry', { account: L(e.account) }),
    detail: num(e.status) !== null || str(e.status) ? say('afterError', { code: String(e.status) }) : null,
  }),
  'inband-retry': (e, L) => ({ tone: 'warn', family: 'retry', text: say('inbandRetry', { account: L(e.account) }) }),
  // The in-band retry writes the error itself as the type (the proxy's INBAND_RETRY_ERRORS).
  overloaded_error: (e, L) => ({ tone: 'warn', family: 'retry', text: say('overloaded', { account: L(e.account) }), detail: attempt(e) }),
  api_error: (e, L) => ({ tone: 'warn', family: 'retry', text: say('apiError', { account: L(e.account) }), detail: attempt(e) }),
  'account-discovered': (e, L) => ({ tone: 'ok', family: 'account', text: say('discovered', { account: str(e.label) ?? L(e.name) }) }),
  'account-renamed': (e, L) => ({ tone: 'muted', family: 'account', text: say('renamed', { account: L(e.name), label: str(e.label) ?? '?' }) }),
  'account-enabled': (e, L) => ({ tone: 'muted', family: 'account', text: say(e.enabled ? 'enabled' : 'disabled', { account: L(e.name) }) }),
  'account-removed': (e, L) => ({ tone: 'warn', family: 'account', text: say('removed', { account: L(who(e)) }) }),
  'priority-set': (e, L) => ({ tone: 'muted', family: 'account', text: say('priority', { account: L(who(e)), n: String(e.priority ?? '?') }) }),
  'account-cap': (e, L) => ({ tone: 'muted', family: 'account', text: say('accountCap', { account: L(who(e)) }), detail: capText(e) }),
  'settings-changed': () => ({ tone: 'muted', family: 'settings', text: say('settings') }),
  'refresh-failed': (e, L) => ({ tone: 'bad', family: 'token', text: say('refreshFailed', { account: L(e.account) }), detail: { text: str(e.error) ?? '?' } }),
  'token-refreshed': (e, L) => ({ tone: 'ok', family: 'token', text: say('tokenRefreshed', { account: L(e.account) }) }),
  upgrade: (e) => ({ tone: 'ok', family: 'upgrade', text: say('upgrade', { version: str(e.to) ?? '?' }) }),
};

/** The types this reader names: the rest falls back to «proxy event (type)». */
export const PROXY_EVENT_TYPES: readonly string[] = Object.keys(DESCRIBE);

/** The label of an account the event names; a name that is not a profile is already an e-mail. */
function labeler(labels: Map<string, string>): Label {
  return (v) => {
    const s = str(v) ?? (num(v) !== null ? String(v) : null);
    return s === null ? '?' : labels.get(s) ?? s;
  };
}

/** One event of the log, described; null for a line without a type or a time. */
export function describeProxyEvent(raw: unknown, labels: Map<string, string>, index = 0): ProxyEvent | null {
  if (!isObject(raw)) return null;
  const at = num(raw.ts);
  const type = str(raw.type);
  if (at === null || type === null) return null;
  const describe = DESCRIBE[type];
  const d: Described = describe
    ? describe(raw, labeler(labels))
    : { tone: 'muted', family: 'other', text: say('unknown', { type: type.replace(/[-_]+/g, ' ') }) };
  return { id: `proxy-${at}-${index}`, at, type, tone: d.tone, family: d.family, text: d.text, detail: d.detail ?? null };
}

/** The whole log, newest first, as the hub's table listed it. */
export function proxyEvents(activity: unknown, profiles: unknown): ProxyEvent[] {
  const log = isObject(activity) && Array.isArray(activity.log) ? activity.log : [];
  const labels = proxyLabels(profiles);
  const out: ProxyEvent[] = [];
  log.forEach((raw, i) => {
    const e = describeProxyEvent(raw, labels, i);
    if (e) out.push(e);
  });
  return out.sort((a, b) => b.at - a.at);
}

/** The words of a text, in the panel's language: what the row shows and the search reads. */
export function proxyText(t: ProxyText, tr: (key: string, vars?: Record<string, string | number>) => string): string {
  return 'text' in t ? t.text : tr(t.key, t.vars);
}

/** How a switch happened, the first note of its row. */
const SWITCH_MODE: Record<string, string> = { 'auto-switch': 'proxy.note.auto', 'proactive-switch': 'proxy.note.proactive', 'manual-switch': 'proxy.note.manual' };

/** The notes of an account row's latest occurrence: a switch's mode and reason, else the detail the hub wrote beside it. */
export function accountNotes(raw: Record<string, unknown>, profiles: unknown): ProxyText[] {
  const detail = describeProxyEvent(raw, proxyLabels(profiles))?.detail ?? null;
  const mode = SWITCH_MODE[String(raw.type)];
  return [...(mode ? [{ key: mode }] : []), ...(detail ? [detail] : [])];
}
