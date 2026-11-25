/**
 * WHO SPENT the weekly quota: per person, and per request.
 *
 * The count is the same as the command-line tool it comes from (hours of
 * hand-written scripts to say how much one person had spent):
 *
 *  · every model call has a token WEIGHT: input + 5·output +
 *    1.25·cache write + 0.1·cache read. In the native engine
 *    `usage_prompt_tokens` INCLUDES cache read and write, so the real input
 *    is the remainder;
 *  · a call belongs to the author of the last user message of its session;
 *    a subagent inherits its parent's author at the moment it was born,
 *    climbing as far as needed; Claude Code subagents are read from their
 *    transcript; `usage_records` rows carry their own author;
 *  · the POINTS come from the quota history: every hour the weekly % of
 *    every account rises by N (a drop is a reset: the new value counts), and
 *    those points are split across that hour's calls by weight.
 *    100 points = one whole weekly account.
 *
 * It is an estimate: the quota is sampled, and calls Topics does not see
 * stay in the total with no author. Without the history the answer says so and
 * gives only the weighted tokens.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findClaudeTranscript } from "../lib/claude-transcript-path";
import { channelOnlyPeople } from "../lib/person-identities";
import type { PeopleUsage, PeopleUsageMeta, PersonRequestRow, PersonUsageDetail, PersonUsageRow } from "../../shared/person-usage";

export type { PeopleUsage } from "../../shared/person-usage";

export const HOUR_MS = 3_600_000;
const MAX_DEPTH = 8;

export interface TokenUsage { input: number; output: number; cacheWrite: number; cacheRead: number }

export function weighTokens(u: TokenUsage): number {
  return u.input + 5 * u.output + 1.25 * u.cacheWrite + 0.1 * u.cacheRead;
}

/** One line of the quota history (`history.jsonl`): `s` = {"claude|<account>|7d": %}. */
export interface QuotaHistorySample { t: number; s?: Record<string, number> }

/**
 * Readings of the 7d quota wobble by a point (31 -> 30 -> 31) without any real reset.
 * A drop smaller than this is read noise: it is ignored and the previous value is kept,
 * so the return to it does not count twice. A bigger drop is a genuine weekly reset.
 */
export const QUOTA_RESET_MIN_DROP = 5;

/** Points per hour (key = whole hour since epoch): rises of the 7d % of every Claude account. */
export function pointsPerHour(lines: QuotaHistorySample[], sinceMs: number, untilMs: number): Map<number, number> {
  const out = new Map<number, number>();
  const prev = new Map<string, number>();
  for (const l of [...lines].sort((a, b) => a.t - b.t)) {
    for (const [k, v] of Object.entries(l.s ?? {})) {
      if (!k.startsWith("claude|") || !k.endsWith("|7d") || !Number.isFinite(v)) continue;
      const t = l.t * 1000;
      const p = prev.get(k);
      // Noise is filtered before the window check: a small dip just before `sinceMs` must not lower `prev`.
      if (p !== undefined && v < p && p - v < QUOTA_RESET_MIN_DROP) continue; // read noise, keep `p`
      if (p !== undefined && t >= sinceMs && t <= untilMs) {
        const d = v >= p ? v - p : v;
        if (d > 0) {
          const h = Math.floor(t / HOUR_MS);
          out.set(h, (out.get(h) ?? 0) + d);
        }
      }
      prev.set(k, v);
    }
  }
  return out;
}

export interface Call {
  ts: number;
  weight: number;
  personId: string | null;
  /** The root session (the chat that produced the call). */
  chatKey: string;
  /** The user message that asked for it, when known. */
  requestId: string | null;
  requestText: string;
  source: "native" | "claude-code" | "record";
  points?: number;
}

/** Anything with a timestamp, a weight and a point total to fill in — what `splitPoints` needs and no more, so a caller with its own call shape (`project-quota.ts`) does not have to carry `Call`'s person-specific fields. */
export interface WeighedCall { ts: number; weight: number; points?: number }

/** Splits each hour's points across that hour's calls, by weight. */
export function splitPoints<T extends WeighedCall>(calls: T[], points: Map<number, number>): T[] {
  const w = new Map<number, number>();
  for (const c of calls) { const h = Math.floor(c.ts / HOUR_MS); w.set(h, (w.get(h) ?? 0) + c.weight); }
  for (const c of calls) {
    const h = Math.floor(c.ts / HOUR_MS);
    const tot = w.get(h) ?? 0;
    c.points = tot > 0 ? ((points.get(h) ?? 0) * c.weight) / tot : 0;
  }
  return calls;
}

interface AuthorMark { ts: number; personId: string | null; messageId: string; text: string }

/** Who was speaking in a session at a given instant: binary search on the line of user messages. */
function lastBefore(line: AuthorMark[], ts: number): AuthorMark | null {
  let lo = 0, hi = line.length - 1, r: AuthorMark | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line[mid]!.ts <= ts) { r = line[mid]!; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

const TAG_RE = /<messaggio da="[^"]*"[^>]*>/g;

/** The request text: after the last `<messaggio da=...>` if any, without double spaces. */
export function requestTextOf(content: string): string {
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content))) last = m;
  const body = last ? content.slice(last.index + last[0].length).split("</messaggio>")[0]! : content;
  // The group channels' preamble is the same for everyone: the request is what remains.
  return body.replace(/^\s*Richiesta del gruppo «[^»]*», fatta da [^,]*, riassunta[^:]*:\s*/, "")
    .replace(/\s+/g, " ").trim().slice(0, 220);
}

export type TranscriptReader = (cwd: string, claudeSessionId: string) => Array<{ ts: number; usage: TokenUsage }>;

/** The calls of a Claude Code transcript: one per `message.id` (per-block lines repeat). */
export const readTranscriptCalls: TranscriptReader = (cwd, sid) => {
  const file = findClaudeTranscript(cwd, sid);
  if (!file) return [];
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const seen = new Set<string>();
  const out: Array<{ ts: number; usage: TokenUsage }> = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o: { type?: string; uuid?: string; timestamp?: string; message?: { id?: string; usage?: Record<string, number | undefined> } };
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u) continue;
    const id = o.message?.id ?? o.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const ts = Date.parse(o.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, usage: {
      input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
    } });
  }
  return out;
};

export interface CollectOptions {
  sinceMs: number;
  untilMs: number;
  readTranscript?: TranscriptReader;
}

/** Every call in the window, each with its author. */
export function collectCalls(db: Database, o: CollectOptions): Call[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const readTranscript = o.readTranscript ?? readTranscriptCalls;

  // Author lines per session: also before the window, a long session works for whoever wrote yesterday.
  const lines = new Map<string, AuthorMark[]>();
  // Rows written by the machine (subagent results, end of a process, goal
  // nudge, turn-end hook nudge) continue the work of whoever asked for it: they do not change the author.
  const users = db.query(`SELECT id, session_key sk, timestamp ts, author_person_id pid, substr(content, 1, 4000) text,
      (blocks LIKE '%"kind":"dispatched-envelope"%' AND content NOT LIKE '%<messaggio da=%') machine
    FROM messages WHERE role = 'user' AND timestamp > ? AND timestamp <= ?
      AND (blocks IS NULL OR (blocks NOT LIKE '%"kind":"subagent-result"%' AND blocks NOT LIKE '%"kind":"process-exit"%'
        AND blocks NOT LIKE '%"kind":"goal-nudge"%' AND blocks NOT LIKE '%"kind":"hook-nudge"%'))
    ORDER BY timestamp`)
    .all(iso(o.sinceMs - 7 * 24 * HOUR_MS), iso(o.untilMs)) as Array<{ id: string; sk: string; ts: string; pid: string | null; text: string; machine: number }>;
  for (const u of users) {
    const ts = Date.parse(u.ts);
    if (!Number.isFinite(ts)) continue;
    let l = lines.get(u.sk);
    if (!l) lines.set(u.sk, (l = []));
    // A machine notice with no sender (work done, board nudge) inside a conversation
    // someone already started continues their work; in a new chat it opens the line.
    if (u.machine && l.length) continue;
    l.push({ ts, personId: u.pid, messageId: u.id, text: requestTextOf(u.text ?? "") });
  }

  const subs = db.query(`SELECT parent_session_key psk, session_key sk, claude_session_id csid, cwd, runtime, created_at
    FROM subagents`).all() as Array<{ psk: string; sk: string | null; csid: string | null; cwd: string; runtime: string | null; created_at: string }>;
  const parent = new Map<string, { psk: string; ts: number }>();
  for (const s of subs) if (s.sk) parent.set(s.sk, { psk: s.psk, ts: Date.parse(s.created_at) });

  const rootOf = (sk: string) => {
    let k = sk;
    for (let i = 0; i < MAX_DEPTH && parent.has(k); i++) k = parent.get(k)!.psk;
    return k;
  };
  /** The author at that instant; a subagent with no messages of its own inherits it from its parent at birth. */
  const authorAt = (sk: string, ts: number): AuthorMark | null => {
    let k: string | undefined = sk, t = ts;
    for (let i = 0; k && i < MAX_DEPTH; i++) {
      const p = parent.get(k);
      // A subagent has no author of its own: its prompts are written by the parent (by the server, so
      // with the owner as author). It inherits whoever was speaking in the parent when it was born.
      if (p) { k = p.psk; t = p.ts; continue; }
      const line = lines.get(k);
      return line ? lastBefore(line, t) : null;
    }
    return null;
  };
  const make = (ts: number, weight: number, sk: string, mark: AuthorMark | null, source: Call["source"], personId?: string | null): Call => ({
    ts, weight, personId: personId !== undefined ? personId : mark?.personId ?? null, chatKey: rootOf(sk),
    requestId: mark?.messageId ?? null, requestText: mark?.text ?? "", source,
  });

  const calls: Call[] = [];
  // Native engine: native chats and subagents.
  const msgs = db.query(`SELECT m.session_key sk, m.timestamp ts, COALESCE(m.usage_prompt_tokens,0) p, COALESCE(m.usage_completion_tokens,0) o,
      COALESCE(m.cache_read_tokens,0) cr, COALESCE(m.cache_creation_tokens,0) cw
    FROM messages m
    WHERE m.role = 'assistant' AND m.timestamp > ? AND m.timestamp <= ?
      AND (m.usage_prompt_tokens > 0 OR m.usage_completion_tokens > 0)
      AND (EXISTS (SELECT 1 FROM topics t WHERE t.session_key = m.session_key AND t.provider = 'topics')
        OR EXISTS (SELECT 1 FROM subagents s WHERE s.session_key = m.session_key AND s.runtime = 'topics'))`)
    .all(iso(o.sinceMs), iso(o.untilMs)) as Array<{ sk: string; ts: string; p: number; o: number; cr: number; cw: number }>;
  for (const m of msgs) {
    const ts = Date.parse(m.ts);
    const weight = weighTokens({ input: Math.max(0, m.p - m.cr - m.cw), output: m.o, cacheWrite: m.cw, cacheRead: m.cr });
    calls.push(make(ts, weight, m.sk, authorAt(m.sk, ts), "native"));
  }

  // Claude Code subagents: the calls live in their transcript, the author is the parent's at birth.
  for (const s of subs) {
    if (s.runtime === "topics" || !s.csid) continue;
    const born = Date.parse(s.created_at);
    if (!Number.isFinite(born) || born > o.untilMs || born < o.sinceMs - 7 * 24 * HOUR_MS) continue;
    const mark = authorAt(s.psk, born);
    for (const c of readTranscript(s.cwd, s.csid)) {
      if (c.ts <= o.sinceMs || c.ts > o.untilMs) continue;
      calls.push(make(c.ts, weighTokens(c.usage), s.psk, mark, "claude-code"));
    }
  }

  // Registry rows: calls outside the engine (sandboxed channels, service calls).
  const records = db.query(`SELECT timestamp ts, session_key sk, author_person_id pid, purpose, label, COALESCE(input_tokens,0) i, COALESCE(output_tokens,0) o,
      COALESCE(cache_read_tokens,0) cr, COALESCE(cache_creation_tokens,0) cw
    FROM usage_records WHERE timestamp > ? AND timestamp <= ? AND measured = 1`)
    .all(o.sinceMs, o.untilMs) as Array<{ ts: number; sk: string; pid: string | null; purpose: string | null; label: string | null; i: number; o: number; cr: number; cw: number }>;
  for (const r of records) {
    const weight = weighTokens({ input: r.i, output: r.o, cacheWrite: r.cw, cacheRead: r.cr });
    const mark = r.pid ? null : authorAt(r.sk, r.ts);
    const c = make(r.ts, weight, r.sk, mark, "record", r.pid ?? mark?.personId ?? null);
    // the caller's label says what the call did; the purpose is only its kind
    if (!c.requestText) c.requestText = r.label?.trim() || r.purpose || "";
    calls.push(c);
  }
  return calls;
}

export function readHistory(file: string): QuotaHistorySample[] | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as QuotaHistorySample]; } catch { return []; }
    });
  } catch { return null; }
}

/** The quota history folder: `TOPICS_USAGE_HISTORY_DIR`, otherwise `~/.topics/usage-history`. */
export function usageHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TOPICS_USAGE_HISTORY_DIR || join(homedir(), ".topics", "usage-history"), "history.jsonl");
}

export interface Computed { calls: Call[]; meta: PeopleUsageMeta }

export function computeCalls(db: Database, o: { days: number; now?: number; historyFile?: string; readTranscript?: TranscriptReader }): Computed {
  const untilMs = o.now ?? Date.now();
  const sinceMs = untilMs - o.days * 24 * HOUR_MS;
  const calls = collectCalls(db, { sinceMs, untilMs, readTranscript: o.readTranscript });
  const history = readHistory(o.historyFile ?? usageHistoryFile());
  let totalPoints: number | null = null, attributedPoints: number | null = null;
  if (history) {
    const hourPoints = pointsPerHour(history, sinceMs, untilMs);
    splitPoints(calls, hourPoints);
    totalPoints = [...hourPoints.values()].reduce((s, x) => s + x, 0);
    attributedPoints = calls.reduce((s, c) => s + (c.points ?? 0), 0);
  }
  return { calls, meta: { days: o.days, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), quotaHistory: !!history, totalPoints, attributedPoints } };
}

function namesOf(db: Database): Map<string, string> {
  const rows = db.query("SELECT id, display_name FROM people").all() as Array<{ id: string; display_name: string }>;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export const NO_AUTHOR = "senza autore";

export function peopleUsage(c: Computed, db: Database): PeopleUsage {
  const names = namesOf(db);
  const channelOnly = channelOnlyPeople(db);
  const g = new Map<string | null, { w: number; p: number }>();
  for (const call of c.calls) {
    const e = g.get(call.personId) ?? { w: 0, p: 0 };
    e.w += call.weight; e.p += call.points ?? 0;
    g.set(call.personId, e);
  }
  const totW = c.calls.reduce((s, x) => s + x.weight, 0);
  const totP = c.meta.attributedPoints ?? 0;
  const people = [...g].map(([personId, e]) => ({
    row: {
      personId,
      name: personId ? names.get(personId) ?? personId : NO_AUTHOR,
      weighted: Math.round(e.w),
      accountPct: c.meta.quotaHistory ? round1(e.p) : null,
      sharePct: round1(c.meta.quotaHistory && totP > 0 ? (100 * e.p) / totP : totW > 0 ? (100 * e.w) / totW : 0),
      canMerge: personId !== null && channelOnly.has(personId),
    } as PersonUsageRow,
    // order on the full values: rounded to one digit, rows under 0.05% came out equal and unordered
    key: c.meta.quotaHistory ? e.p : e.w,
  })).sort((a, b) => b.key - a.key || b.row.weighted - a.row.weighted).map((x) => x.row);
  return { ...c.meta, people };
}

export function personDetail(c: Computed, db: Database, personId: string | null): PersonUsageDetail {
  const names = namesOf(db);
  const chats = new Map((db.query("SELECT session_key, name FROM topics").all() as Array<{ session_key: string; name: string }>).map((t) => [t.session_key, t.name]));
  const g = new Map<string, PersonRequestRow & { first: number }>();
  for (const call of c.calls) {
    if (call.personId !== personId) continue;
    const key = `${call.chatKey}\u0000${call.requestId ?? call.requestText}`;
    let r = g.get(key);
    if (!r) {
      r = { chatKey: call.chatKey, chatName: chats.get(call.chatKey) ?? call.chatKey, requestId: call.requestId, request: call.requestText, at: "", calls: 0, weighted: 0, accountPct: c.meta.quotaHistory ? 0 : null, first: call.ts };
      g.set(key, r);
    }
    r.calls++; r.weighted += call.weight; r.first = Math.min(r.first, call.ts);
    if (r.accountPct !== null) r.accountPct += call.points ?? 0;
  }
  const requests = [...g.values()].map(({ first, ...r }) => ({ ...r, at: new Date(first).toISOString(), weighted: Math.round(r.weighted), accountPct: r.accountPct === null ? null : round1(r.accountPct) }))
    .sort((a, b) => (b.accountPct ?? 0) - (a.accountPct ?? 0) || b.weighted - a.weighted);
  return { ...c.meta, personId, name: personId ? names.get(personId) ?? personId : NO_AUTHOR, requests };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
