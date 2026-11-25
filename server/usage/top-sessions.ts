/**
 * WHO IS SPENDING THE QUOTA, session by session (card 8cb978eb).
 *
 * The heaviest Claude sessions of the last 24 hours, read from the Claude Code
 * transcripts of the user running Topics (`<config dir>/projects/<folder>/<id>.jsonl`).
 * One session is one main transcript plus its subagents
 * (`<folder>/<id>/subagents/*.jsonl`): the subagents are counted for the parent.
 * No transcript folder means an empty answer, never an error.
 *
 * `aggregateSessions` is pure (text in, ranking out) so the ranking is tested
 * without a disk; `scanTranscripts` is the only part that touches the filesystem.
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
import { createInterface } from "node:readline";

import type { TopSession, TopSessionOrigin, TopSessionsResult } from "../../shared/top-sessions";

const HOUR_MS = 3_600_000;
export const WINDOW_24H_MS = 24 * HOUR_MS;
export const WINDOW_WEEK_MS = 7 * 24 * HOUR_MS;
/** A single session doing at least this part of its project is flagged. */
export const PROJECT_DOMINANCE = 0.5;
/** Open for longer than this AND doing at least half of everything: worth a notice. */
export const LONG_OPEN_MS = 24 * HOUR_MS;
export const TOP_COUNT = 5;

/** One transcript file handed to the aggregation. */
export interface TranscriptText {
  /** The session the file belongs to: the file name of a main transcript, the parent's id for a subagent. */
  sessionId: string;
  subagent: boolean;
  text: string;
}

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

interface Acc {
  id: string;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  entrypoint: string | null;
  firstAt: number;
  lastAt: number;
  weighted24h: number;
  weighted7d: number;
  contextSum: number;
  turns: number;
  byModel: Map<string, number>;
}

const blank = (id: string): Acc => ({ id, cwd: null, title: null, firstPrompt: null, entrypoint: null, firstAt: Infinity, lastAt: 0, weighted24h: 0, weighted7d: 0, contextSum: 0, turns: 0, byModel: new Map() });

function promptText(content: unknown): string | null {
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join(" ") : "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t && !t.startsWith("<") ? t.slice(0, 80) : null;
}

function readFile(acc: Acc, file: TranscriptText, now: number): void {
  for (const line of file.text.split("\n")) {
    if (!line) continue;
    let r: Record<string, any>;
    try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(r.timestamp);
    if (!file.subagent) {
      if (r.type === "custom-title" && typeof r.customTitle === "string" && r.customTitle.trim()) acc.title = r.customTitle.trim();
      if (!acc.cwd && typeof r.cwd === "string") acc.cwd = r.cwd;
      if (!acc.entrypoint && typeof r.entrypoint === "string") acc.entrypoint = r.entrypoint;
      if (!acc.firstPrompt && r.type === "user" && !r.isSidechain && r.message) acc.firstPrompt = promptText(r.message.content);
      if (Number.isFinite(at)) { acc.firstAt = Math.min(acc.firstAt, at); acc.lastAt = Math.max(acc.lastAt, at); }
    }
    const u: Usage | undefined = r.type === "assistant" ? r.message?.usage : undefined;
    if (!u || !Number.isFinite(at) || now - at > WINDOW_WEEK_MS || at > now) continue;
    const model = typeof r.message.model === "string" ? r.message.model : "unknown";
    const w = (n(u.input_tokens) + 5 * n(u.output_tokens) + 1.25 * n(u.cache_creation_input_tokens) + 0.1 * n(u.cache_read_input_tokens)) * modelFactor(model);
    acc.weighted7d += w;
    if (now - at <= WINDOW_24H_MS) {
      acc.weighted24h += w;
      acc.byModel.set(model, (acc.byModel.get(model) ?? 0) + w);
      if (!file.subagent) {
        acc.contextSum += n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
        acc.turns += 1;
      }
    }
  }
}

/** The ranking of the last 24 hours, subagents folded into their parent. */
export function aggregateSessions(files: readonly TranscriptText[], now: number, top = TOP_COUNT): TopSessionsResult {
  const bySession = new Map<string, Acc>();
  for (const f of files) {
    const acc = bySession.get(f.sessionId) ?? blank(f.sessionId);
    bySession.set(f.sessionId, acc);
    readFile(acc, f, now);
  }
  const all = [...bySession.values()];
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

async function readText(path: string): Promise<string> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const l of rl) lines.push(l);
  return lines.join("\n");
}

async function subdirs(path: string): Promise<string[]> {
  const out: string[] = [];
  try { for await (const d of await opendir(path)) out.push(d.name); } catch { /* absent folder: nothing to list */ }
  return out;
}

/**
 * Reads every transcript touched in the last 7 days. A file older than the
 * window by mtime cannot hold a record inside it, so it is skipped unread.
 */
export async function scanTranscripts(root: string, now: number): Promise<TranscriptText[]> {
  const files: TranscriptText[] = [];
  const fresh = async (p: string): Promise<boolean> => {
    try { return now - (await stat(p)).mtimeMs <= WINDOW_WEEK_MS; } catch { return false; }
  };
  for (const folder of await subdirs(root)) {
    const dir = join(root, folder);
    for (const entry of await subdirs(dir)) {
      if (entry.endsWith(".jsonl")) {
        const p = join(dir, entry);
        if (await fresh(p)) files.push({ sessionId: entry.slice(0, -6), subagent: false, text: await readText(p) });
      } else {
        const subDir = join(dir, entry, "subagents");
        for (const f of await subdirs(subDir)) {
          const p = join(subDir, f);
          if (f.endsWith(".jsonl") && (await fresh(p))) files.push({ sessionId: entry, subagent: true, text: await readText(p) });
        }
      }
    }
  }
  return files;
}

export async function topSessions(opts: { root?: string; now?: number } = {}): Promise<TopSessionsResult> {
  const now = opts.now ?? Date.now();
  return aggregateSessions(await scanTranscripts(opts.root ?? claudeProjectsRoot(), now), now);
}
