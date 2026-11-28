/**
 * WHO IS SPENDING THE QUOTA, session by session (card 8cb978eb).
 *
 * The heaviest Claude sessions of the last 24 hours, read from the Claude Code
 * transcripts of the user running Topics (`<config dir>/projects/<folder>/<id>.jsonl`).
 * One session is one main transcript plus its subagents
 * (`<folder>/<id>/subagents/*.jsonl`): the subagents are counted for the parent.
 * No transcript folder means an empty answer, never an error.
 *
 * `addLine` and `aggregateSessions` are pure (lines in, ranking out) so the ranking is tested
 * without a disk; `scanTranscripts` (streaming, no text kept) is the only part that touches the filesystem.
 *
 * WEIGHT. Points are weighted tokens: output counts 5, a cache write 1.25, a
 * cache read 0.1, input 1 (the price ratios), times a model factor (opus 5,
 * sonnet 1, haiku 0.25). It is a relative measure to rank sessions, not a bill,
 * and "share of the week" is the session's part of ALL the weighted tokens the
 * transcripts hold for the last 7 days.
 */
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TopSession, TopSessionOrigin, TopSessionsResult } from "../../shared/top-sessions";

const HOUR_MS = 3_600_000;
export const WINDOW_24H_MS = 24 * HOUR_MS;
export const WINDOW_WEEK_MS = 7 * 24 * HOUR_MS;
/** A single session doing at least this part of its project is flagged. */
export const PROJECT_DOMINANCE = 0.5;
/** Open for longer than this AND doing at least half of everything: worth a notice. */
export const LONG_OPEN_MS = 24 * HOUR_MS;
export const TOP_COUNT = 5;

const MODEL_FACTOR: ReadonlyArray<[RegExp, number]> = [
  [/opus|fable/i, 5],
  [/haiku/i, 0.25],
  [/sonnet/i, 1],
];

export function modelFactor(model: string): number {
  for (const [re, f] of MODEL_FACTOR) if (re.test(model)) return f;
  return 1;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function originOf(entrypoint: string | null): TopSessionOrigin {
  const e = (entrypoint ?? "").toLowerCase();
  if (e.includes("desktop")) return "desktop";
  if (e === "cli" || e === "") return "cli";
  return "topics";
}

/** Spend is kept in 5-minute buckets so a cached partial can be windowed again at any later `now`. */
export const BUCKET_MS = 5 * 60_000;

export interface Bucket {
  weighted: number;
  contextSum: number;
  turns: number;
  byModel: Map<string, number>;
}

/** Running totals of one transcript file or one session; transcript text is never kept, only these numbers. */
export interface SessionSums {
  id: string;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  entrypoint: string | null;
  firstAt: number;
  lastAt: number;
  buckets: Map<number, Bucket>;
}

const blank = (id: string): SessionSums => ({ id, cwd: null, title: null, firstPrompt: null, entrypoint: null, firstAt: Infinity, lastAt: 0, buckets: new Map() });

/** The windowed view `aggregateSessions` ranks on. */
interface Windowed extends SessionSums {
  weighted24h: number;
  weighted7d: number;
  contextSum: number;
  turns: number;
  byModel: Map<string, number>;
}

function windowed(a: SessionSums, now: number): Windowed {
  const w: Windowed = { ...a, weighted24h: 0, weighted7d: 0, contextSum: 0, turns: 0, byModel: new Map() };
  for (const [idx, b] of a.buckets) {
    const at = idx * BUCKET_MS;
    if (at > now || now - (at + BUCKET_MS) > WINDOW_WEEK_MS) continue;
    w.weighted7d += b.weighted;
    if (now - at <= WINDOW_24H_MS) {
      w.weighted24h += b.weighted;
      w.contextSum += b.contextSum;
      w.turns += b.turns;
      for (const [m, v] of b.byModel) w.byModel.set(m, (w.byModel.get(m) ?? 0) + v);
    }
  }
  return w;
}

/** Folds the numbers of one transcript file into its session's totals. */
function mergeSums(into: SessionSums, from: SessionSums): void {
  into.cwd ??= from.cwd;
  into.title ??= from.title;
  into.firstPrompt ??= from.firstPrompt;
  into.entrypoint ??= from.entrypoint;
  into.firstAt = Math.min(into.firstAt, from.firstAt);
  into.lastAt = Math.max(into.lastAt, from.lastAt);
  for (const [idx, b] of from.buckets) {
    const t = into.buckets.get(idx);
    if (!t) { into.buckets.set(idx, { ...b, byModel: new Map(b.byModel) }); continue; }
    t.weighted += b.weighted;
    t.contextSum += b.contextSum;
    t.turns += b.turns;
    for (const [m, v] of b.byModel) t.byModel.set(m, (t.byModel.get(m) ?? 0) + v);
  }
}

function promptText(content: unknown): string | null {
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join(" ") : "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t && !t.startsWith("<") ? t.slice(0, 80) : null;
}

/** Sessions by id, filled one transcript line at a time. */
export type SessionTotals = Map<string, SessionSums>;

/** The fields of a transcript line this module reads; everything else is ignored. */
interface TranscriptLine {
  type?: string;
  timestamp?: string;
  customTitle?: unknown;
  cwd?: unknown;
  entrypoint?: unknown;
  isSidechain?: boolean;
  message?: { content?: unknown; model?: unknown; usage?: Usage };
}

/** Folds one transcript line into its session; `subagent` lines only add spend. */
export function addLine(totals: SessionTotals, sessionId: string, subagent: boolean, line: string, now: number): void {
  if (!line) return;
  let r: TranscriptLine;
  try { r = JSON.parse(line) as TranscriptLine; } catch { return; }
  const sums = totals.get(sessionId) ?? blank(sessionId);
  totals.set(sessionId, sums);
  const at = Date.parse(r.timestamp ?? "");
  if (!subagent) {
    if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) sums.title = r.customTitle.trim();
    if (!sums.cwd && typeof r.cwd === "string") sums.cwd = r.cwd;
    if (!sums.entrypoint && typeof r.entrypoint === "string") sums.entrypoint = r.entrypoint;
    if (!sums.firstPrompt && r.type === "user" && !r.isSidechain && r.message) sums.firstPrompt = promptText(r.message.content);
    if (Number.isFinite(at)) { sums.firstAt = Math.min(sums.firstAt, at); sums.lastAt = Math.max(sums.lastAt, at); }
  }
  const u: Usage | undefined = r.type === "assistant" ? r.message?.usage : undefined;
  if (!u || !Number.isFinite(at) || now - at > WINDOW_WEEK_MS) return;
  const model = typeof r.message?.model === "string" ? r.message.model : "unknown";
  const w = (n(u.input_tokens) + 5 * n(u.output_tokens) + 1.25 * n(u.cache_creation_input_tokens) + 0.1 * n(u.cache_read_input_tokens)) * modelFactor(model);
  const idx = Math.floor(at / BUCKET_MS);
  const bucket = sums.buckets.get(idx) ?? { weighted: 0, contextSum: 0, turns: 0, byModel: new Map<string, number>() };
  sums.buckets.set(idx, bucket);
  bucket.weighted += w;
  bucket.byModel.set(model, (bucket.byModel.get(model) ?? 0) + w);
  if (!subagent) {
    bucket.contextSum += n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    bucket.turns += 1;
  }
}

/** The ranking of the last 24 hours, subagents already folded into their parent. */
export function aggregateSessions(bySession: SessionTotals, now: number, top = TOP_COUNT): TopSessionsResult {
  const all = [...bySession.values()].map((a) => windowed(a, now));
  const total24h = all.reduce((s, a) => s + a.weighted24h, 0);
  const total7d = all.reduce((s, a) => s + a.weighted7d, 0);
  const perProject = new Map<string, { weighted: number; sessions: number }>();
  for (const a of all) {
    if (a.weighted24h <= 0) continue;
    const key = a.cwd ?? "";
    const p = perProject.get(key) ?? { weighted: 0, sessions: 0 };
    p.weighted += a.weighted24h;
    p.sessions += 1;
    perProject.set(key, p);
  }
  const ranked = all.filter((a) => a.weighted24h > 0).sort((a, b) => b.weighted24h - a.weighted24h).slice(0, top);
  const sessions: TopSession[] = ranked.map((a) => {
    const project = perProject.get(a.cwd ?? "")!;
    const model = [...a.byModel.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "unknown";
    const openMs = Number.isFinite(a.firstAt) ? Math.max(0, now - a.firstAt) : 0;
    const shareOfProject = project.weighted > 0 ? a.weighted24h / project.weighted : 0;
    const shareOfAll = total24h > 0 ? a.weighted24h / total24h : 0;
    return {
      id: a.id,
      title: a.title ?? a.firstPrompt ?? "",
      origin: originOf(a.entrypoint),
      cwd: a.cwd,
      model,
      points24h: Math.round(a.weighted24h),
      weekShare: total7d > 0 ? a.weighted7d / total7d : 0,
      avgContext: a.turns > 0 ? Math.round(a.contextSum / a.turns) : 0,
      openMs,
      shareOfProject,
      dominatesProject: project.sessions >= 2 && shareOfProject >= PROJECT_DOMINANCE,
      hog: openMs > LONG_OPEN_MS && shareOfAll >= PROJECT_DOMINANCE,
    };
  });
  return { generatedAt: new Date(now).toISOString(), sessions };
}

/** The Claude Code config folder of whoever runs this server. */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/** What is known of one transcript file: how far it was read and the numbers that came out of it. */
interface FileState {
  size: number;
  mtimeMs: number;
  /** Bytes consumed so far; always the end of a complete line. */
  offset: number;
  sessionId: string;
  sums: SessionSums;
}

/** Per transcript folder, per file; a scan reads only what a file gained since the last one. */
const fileCaches = new Map<string, Map<string, FileState>>();
let bytesRead = 0;

/** Bytes the scans have read from disk so far (a counter for tests and diagnostics). */
export function transcriptBytesRead(): number {
  return bytesRead;
}

/** Streams the complete lines of `path` from `state.offset` into its sums: the file is never held in memory. */
async function readFrom(state: FileState, subagent: boolean, path: string, now: number): Promise<void> {
  let carry: Buffer = Buffer.alloc(0);
  const own: SessionTotals = new Map([[state.sessionId, state.sums]]);
  for await (const chunk of createReadStream(path, { start: state.offset })) {
    bytesRead += (chunk as Buffer).length;
    carry = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let from = 0;
    for (let nl = carry.indexOf(10, from); nl !== -1; nl = carry.indexOf(10, from)) {
      addLine(own, state.sessionId, subagent, carry.toString("utf8", from, nl).replace(/\r$/, ""), now);
      state.offset += nl + 1 - from;
      from = nl + 1;
    }
    carry = carry.subarray(from);
  }
}

async function listNames(path: string): Promise<string[]> {
  const out: string[] = [];
  try { for await (const d of await opendir(path)) out.push(d.name); } catch { /* absent folder: nothing to list */ }
  return out;
}

/**
 * Reads every transcript touched in the last 7 days. A file older than the
 * window by mtime cannot hold a record inside it, so it is skipped unread. A
 * file seen before is read only past its last offset when it grew; one that
 * shrank, or changed without growing, is read again from the start.
 */
export async function scanTranscripts(root: string, now: number): Promise<SessionTotals> {
  const known = fileCaches.get(root) ?? new Map<string, FileState>();
  fileCaches.set(root, known);
  const seen = new Set<string>();
  const totals: SessionTotals = new Map();
  const visit = async (path: string, sessionId: string, subagent: boolean): Promise<void> => {
    let st;
    try { st = await stat(path); } catch { return; }
    if (now - st.mtimeMs > WINDOW_WEEK_MS) return;
    seen.add(path);
    let state = known.get(path);
    const grew = state !== undefined && st.size > state.size;
    const same = state !== undefined && st.size === state.size && st.mtimeMs === state.mtimeMs;
    if (!state || (!grew && !same)) {
      state = { size: 0, mtimeMs: 0, offset: 0, sessionId, sums: blank(sessionId) };
      known.set(path, state);
    }
    if (!same) {
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      try { await readFrom(state, subagent, path, now); } catch { /* unreadable now: the next scan retries from the offset */ }
    }
    const into = totals.get(sessionId) ?? blank(sessionId);
    totals.set(sessionId, into);
    mergeSums(into, state.sums);
  };
  for (const folder of await listNames(root)) {
    const dir = join(root, folder);
    for (const entry of await listNames(dir)) {
      if (entry.endsWith(".jsonl")) await visit(join(dir, entry), entry.slice(0, -6), false);
      else for (const f of await listNames(join(dir, entry, "subagents"))) if (f.endsWith(".jsonl")) await visit(join(dir, entry, "subagents", f), entry, true);
    }
  }
  for (const path of known.keys()) if (!seen.has(path)) known.delete(path);
  return totals;
}

export async function topSessions(opts: { root?: string; now?: number } = {}): Promise<TopSessionsResult> {
  const now = opts.now ?? Date.now();
  return aggregateSessions(await scanTranscripts(opts.root ?? claudeProjectsRoot(), now), now);
}
