/**
 * EVERY MODEL CALL IN A WINDOW, each tagged with its project, its surface and
 * its chat (project quota). The points come later, in
 * `project-quota.ts`; this file only answers "what ran, where, for whom".
 *
 * WEIGHT. A call weighs what it costs at list price (`calculateCostWithCache`,
 * the table `cost_cents` is already computed from), in micro-dollars: the quota
 * hour's points are split across that hour's calls by weight, and a Haiku call
 * must not weigh like an Opus one. A model the table cannot price is weighed as
 * `FALLBACK_MODEL`, never as free.
 *
 * SOURCES, and where each one's project comes from:
 *  - native chats and subagents (`messages`): the chat's project;
 *  - Claude Code transcripts under `~/.claude/projects`, nested subagent files
 *    included (`<session>/subagents/*.jsonl`): the chat the session belongs to,
 *    or, for a session Topics never opened, the `cwd` each line carries, and
 *    only when that folder is a registered project;
 *  - `usage_records` (titles, judges): the project of the chat they ran for.
 *
 * A card keeps its project even after its worktree is gone: the card's task
 * names the project, the folder is only the fallback.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelPrice } from "../../shared/model-pricing";
import type { QuotaSurface } from "../../shared/usage-shapes";
import { calculateCostWithCache } from "./pricing";
import { HOUR_MS } from "./person-usage";
import type { FolderResolver } from "./project-folders";

/** What a call is weighed as when its model is unknown or unpriced: the model most of the spend runs on. */
export const FALLBACK_MODEL = "claude-opus-5-5";

export interface CallTokens { input: number; output: number; cacheWrite: number; cacheRead: number; cacheWrite1h?: number }

/** List price of one call in micro-dollars: the weight the hour's points are split by. */
export function callWeight(model: string | null | undefined, t: CallTokens): number {
  const priced = model && modelPrice(model) ? model : FALLBACK_MODEL;
  const write1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  return calculateCostWithCache({
    model: priced, freshInputTokens: t.input, outputTokens: t.output,
    cacheCreationTokens: t.cacheWrite - write1h, cacheCreation1hTokens: write1h, cacheReadTokens: t.cacheRead,
  }) * 1_000_000;
}

export interface QuotaCall {
  ts: number;
  weight: number;
  surface: QuotaSurface;
  /** `null` = outside every project. */
  projectId: string | null;
  projectPath: string | null;
  /** The topic of the chat the call belongs to (a subagent's call counts for its root chat); `null` for a session Topics never opened. */
  chatId: string | null;
  points?: number;
}

export interface TranscriptFile { path: string; mtimeMs: number; sessionId: string; nested: boolean }

export interface CollectOptions {
  sinceMs: number;
  untilMs: number;
  /** Injected for tests: every transcript file under `~/.claude/projects`. */
  listTranscripts?: () => TranscriptFile[];
}

const MAX_DEPTH = 8;

interface TopicRow { id: string; name: string; session_key: string; project_path: string | null; model: string | null }
interface SubRow { parent_session_key: string; session_key: string | null; claude_session_id: string | null; cwd: string; runtime: string | null; model: string | null }

/** The root chats a session key leads to, and what kind of chat each is. */
function loadOwners(db: Database) {
  const topics = db.query("SELECT id, name, session_key, project_path, model FROM topics").all() as TopicRow[];
  const topicBySk = new Map(topics.map((t) => [t.session_key, t]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const subs = db.query("SELECT parent_session_key, session_key, claude_session_id, cwd, runtime, model FROM subagents").all() as SubRow[];
  const subBySk = new Map(subs.filter((s) => s.session_key).map((s) => [s.session_key!, s]));
  const subByClaudeId = new Map(subs.filter((s) => s.claude_session_id).map((s) => [s.claude_session_id!, s]));
  const claudeSessions = new Map((db.query("SELECT session_key, claude_session_id FROM claude_code_sessions").all() as Array<{ session_key: string; claude_session_id: string }>)
    .map((r) => [r.claude_session_id, r.session_key]));

  // A card's chat: the task names the project (null when only the chat is marked as a card's).
  const cards = new Map<string, string | null>();
  for (const r of db.query("SELECT topic_id FROM system_chats WHERE kind IN ('task', 'attempt')").all() as Array<{ topic_id: string }>) cards.set(r.topic_id, null);
  for (const r of db.query(
    `SELECT assigned_topic_id topic, project_id FROM tasks WHERE assigned_topic_id IS NOT NULL
     UNION ALL SELECT chat_id, project_id FROM tasks WHERE chat_id IS NOT NULL
     UNION ALL SELECT a.topic_id, t.project_id FROM task_attempts a JOIN tasks t ON t.id = a.task_id WHERE a.topic_id IS NOT NULL`,
  ).all() as Array<{ topic: string; project_id: string }>) cards.set(r.topic, r.project_id);

  /** The chat a session key belongs to, climbing out of subagents. */
  const rootOf = (sk: string): { topic: TopicRow | null; viaSubagent: boolean; sub: SubRow | null } => {
    let k = sk, sub: SubRow | null = null;
    for (let i = 0; i < MAX_DEPTH && subBySk.has(k); i++) { sub ??= subBySk.get(k)!; k = subBySk.get(k)!.parent_session_key; }
    return { topic: topicBySk.get(k) ?? null, viaSubagent: sub !== null, sub };
  };
  return { topicBySk, topicById, subByClaudeId, claudeSessions, cards, rootOf };
}
type Owners = ReturnType<typeof loadOwners>;

function surfaceOf(isCard: boolean, subagent: boolean): QuotaSurface {
  return subagent ? (isCard ? "cardSubagent" : "chatSubagent") : (isCard ? "card" : "chat");
}

/** Every call in the window. */
export function collectProjectCalls(db: Database, folders: FolderResolver, o: CollectOptions): QuotaCall[] {
  const owners = loadOwners(db);
  const calls: QuotaCall[] = [];

  /** The project of a call: the card's task, else the chat's folder, else the call's own folder (registered only when `strict`). */
  const place = (topic: TopicRow | null, folder: string | null, strict: boolean): { projectId: string | null; projectPath: string | null } => {
    if (topic) {
      const taskProject = owners.cards.get(topic.id);
      if (taskProject) return { projectId: taskProject, projectPath: folders.pathOfId(taskProject) };
      const f = topic.project_path ? folders.resolve(topic.project_path) : null;
      if (f?.id) return { projectId: f.id, projectPath: f.path };
    }
    if (!folder) return { projectId: null, projectPath: null };
    const r = folders.resolve(folder);
    if (!r.id || (strict && !r.registered)) return { projectId: null, projectPath: null };
    return { projectId: r.id, projectPath: r.path };
  };
  const push = (ts: number, weight: number, surface: QuotaSurface, topic: TopicRow | null, folder: string | null, strict: boolean) => {
    calls.push({ ts, weight, surface, chatId: topic?.id ?? null, ...place(topic, folder, strict) });
  };
  const chatSurface = (topic: TopicRow | null, subagent: boolean) => surfaceOf(!!topic && owners.cards.has(topic.id), subagent);

  collectNative(db, owners, o, push, chatSurface);
  collectTranscripts(owners, o, push, chatSurface);
  collectRecords(db, owners, o, push);
  collectNodeCards(db, o, calls, folders);
  return calls;
}

type Push = (ts: number, weight: number, surface: QuotaSurface, topic: TopicRow | null, folder: string | null, strict: boolean) => void;
type ChatSurface = (topic: TopicRow | null, subagent: boolean) => QuotaSurface;

/** Native chats and native subagents: the token counts sit on the assistant message. */
function collectNative(db: Database, owners: Owners, o: CollectOptions, push: Push, chatSurface: ChatSurface): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const msgs = db.query(
    `SELECT m.session_key sk, m.timestamp ts, m.model model, COALESCE(m.usage_prompt_tokens,0) p, COALESCE(m.usage_completion_tokens,0) o,
        COALESCE(m.cache_read_tokens,0) cr, COALESCE(m.cache_creation_tokens,0) cw, COALESCE(m.cache_creation_1h_tokens,0) cw1h
     FROM messages m
     WHERE m.role = 'assistant' AND m.timestamp > ? AND m.timestamp <= ?
       AND (m.usage_prompt_tokens > 0 OR m.usage_completion_tokens > 0)
       AND (EXISTS (SELECT 1 FROM topics t WHERE t.session_key = m.session_key AND t.provider = 'topics')
         OR EXISTS (SELECT 1 FROM subagents s WHERE s.session_key = m.session_key AND s.runtime = 'topics'))`,
  ).all(iso(o.sinceMs), iso(o.untilMs)) as Array<{ sk: string; ts: string; model: string | null; p: number; o: number; cr: number; cw: number; cw1h: number }>;
  for (const m of msgs) {
    const ts = Date.parse(m.ts);
    if (!Number.isFinite(ts)) continue;
    const root = owners.rootOf(m.sk);
    // `usage_prompt_tokens` includes the cache reads and writes: the fresh input is the remainder.
    const weight = callWeight(m.model ?? root.sub?.model ?? root.topic?.model, { input: Math.max(0, m.p - m.cr - m.cw), output: m.o, cacheWrite: m.cw, cacheRead: m.cr, cacheWrite1h: m.cw1h });
    push(ts, weight, chatSurface(root.topic, root.viaSubagent), root.topic, root.sub?.cwd ?? null, false);
  }
}

/** Claude Code transcripts: the chat's own, its subagents' (nested files), and sessions Topics never opened. */
function collectTranscripts(owners: Owners, o: CollectOptions, push: Push, chatSurface: ChatSurface): void {
  for (const file of (o.listTranscripts ?? (() => listTranscripts()))()) {
    // A file untouched since the window opened holds no call inside it.
    if (file.mtimeMs < o.sinceMs || file.mtimeMs > o.untilMs + HOUR_MS) continue;
    const sk = owners.claudeSessions.get(file.sessionId);
    const sub = owners.subByClaudeId.get(file.sessionId);
    const root = sk ? owners.rootOf(sk) : sub ? owners.rootOf(sub.parent_session_key) : null;
    const subagent = file.nested || !!sub || (root?.viaSubagent ?? false);
    for (const c of readTranscript(file.path)) {
      if (c.ts <= o.sinceMs || c.ts > o.untilMs) continue;
      const weight = callWeight(c.model, c.tokens);
      if (root?.topic) push(c.ts, weight, chatSurface(root.topic, subagent), root.topic, c.cwd ?? sub?.cwd ?? null, false);
      else push(c.ts, weight, "outside", null, c.cwd, true);
    }
  }
}

/**
 * Cards whose run happened on a node: the spend never touched this machine's
 * messages or transcripts, it arrives as the card's own ledger (`agent_spend`,
 * fed by the node's report). Each booking is a call of its weight in the card's
 * project. A card with tokens but no ledger (the node could not price it) counts
 * once, at its last update, weighed by its tokens.
 */
function collectNodeCards(db: Database, o: CollectOptions, calls: QuotaCall[], folders: FolderResolver): void {
  const cards = db.query(
    `SELECT id, project_id, updated_at, COALESCE(agent_tokens,0) tokens, COALESCE(agent_cache_read_tokens,0) cr
     FROM tasks WHERE node_run_id IS NOT NULL AND (COALESCE(agent_tokens,0) > 0 OR COALESCE(agent_cost_cents,0) > 0)`,
  ).all() as Array<{ id: string; project_id: string | null; updated_at: string; tokens: number; cr: number }>;
  const ledger = db.query("SELECT at, cents FROM agent_spend WHERE task_id = ? AND cents > 0");
  for (const c of cards) {
    const where = { projectId: c.project_id, projectPath: c.project_id ? folders.pathOfId(c.project_id) : null, chatId: null, surface: "card" as const };
    const rows = ledger.all(c.id) as Array<{ at: string; cents: number }>;
    if (rows.length === 0) {
      const ts = Date.parse(c.updated_at);
      if (Number.isFinite(ts) && ts > o.sinceMs && ts <= o.untilMs) {
        calls.push({ ...where, ts, weight: callWeight(null, { input: c.tokens, output: 0, cacheWrite: 0, cacheRead: c.cr }) });
      }
      continue;
    }
    for (const r of rows) {
      const ts = Date.parse(r.at);
      if (Number.isFinite(ts) && ts > o.sinceMs && ts <= o.untilMs) calls.push({ ...where, ts, weight: r.cents * 10_000 });
    }
  }
}

/** One-shot calls (a card title, a stall judge): they ran for a chat, so they count for its project. */
function collectRecords(db: Database, owners: Owners, o: CollectOptions, push: Push): void {
  const records = db.query(
    `SELECT u.timestamp ts, u.session_key sk, u.topic_id topic_id, u.model model, u.project_path folder,
        COALESCE(u.input_tokens,0) i, COALESCE(u.output_tokens,0) o, COALESCE(u.cache_read_tokens,0) cr,
        COALESCE(u.cache_creation_tokens,0) cw, COALESCE(u.cache_creation_1h_tokens,0) cw1h
     FROM usage_records u WHERE u.timestamp > ? AND u.timestamp <= ? AND u.measured = 1`,
  ).all(o.sinceMs, o.untilMs) as Array<{ ts: number; sk: string; topic_id: string | null; model: string; folder: string | null; i: number; o: number; cr: number; cw: number; cw1h: number }>;
  for (const r of records) {
    const topic = (r.topic_id ? owners.topicById.get(r.topic_id) : null) ?? owners.rootOf(r.sk).topic;
    push(r.ts, callWeight(r.model, { input: r.i, output: r.o, cacheWrite: r.cw, cacheRead: r.cr, cacheWrite1h: r.cw1h }), "single", topic, r.folder || null, false);
  }
}

/** Every transcript under `~/.claude/projects`, a session's own file and its nested `subagents/` files. */
export function listTranscripts(root: string = join(homedir(), ".claude", "projects")): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const add = (path: string, sessionId: string, nested: boolean) => {
    try { out.push({ path, mtimeMs: statSync(path).mtimeMs, sessionId, nested }); } catch { /* raced with a delete */ }
  };
  /** The `.jsonl` files under a session's folder, at any depth. */
  const walk = (dir: string, sessionId: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && depth < 4) walk(join(dir, e.name), sessionId, depth + 1);
      else if (e.name.endsWith(".jsonl")) add(join(dir, e.name), sessionId, true);
    }
  };
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return []; }
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const path = join(root, dir, e.name);
      if (e.isDirectory()) walk(path, e.name, 0);
      else if (e.name.endsWith(".jsonl")) add(path, e.name.slice(0, -".jsonl".length), false);
    }
  }
  return out;
}

/** One transcript's calls: one per `message.id` (per-block lines repeat), with the model and the `cwd` the line itself carries. */
export function readTranscript(path: string): Array<{ ts: number; tokens: CallTokens; model: string | null; cwd: string | null }> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const seen = new Set<string>();
  const out: Array<{ ts: number; tokens: CallTokens; model: string | null; cwd: string | null }> = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o: { type?: string; uuid?: string; timestamp?: string; cwd?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u) continue;
    const id = o.message?.id ?? o.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const ts = Date.parse(o.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cacheWrite = n(u.cache_creation_input_tokens);
    const model = o.message?.model && o.message.model !== "<synthetic>" ? o.message.model : null;
    out.push({
      ts, model, cwd: o.cwd || null,
      tokens: { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite, cacheRead: n(u.cache_read_input_tokens), cacheWrite1h: n((u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens) },
    });
  }
  return out;
}
