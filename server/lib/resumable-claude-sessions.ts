/**
 * resumable-claude-sessions.ts — the Claude Code sessions of ONE project that
 * no chat of Topics owns, for `/resume` (CMDUI-03).
 *
 * The census of external sessions (`external-claude-sessions.ts`) reads the
 * same transcripts, and is deliberately NOT reused here. Its cache drops at the
 * end of every pass whatever that pass did not see, so a census over 8 hours
 * and a `/resume` over a month would empty each other's cache on every call;
 * and it reads every folder and every tail with `readSync` on the server's
 * loop. Measured on 03/10 on the machine this was written on: 225 folders,
 * 2,433 transcripts, 1.2 s cold to read the tails of a month.
 *
 * So this is a reading of its own, bounded three ways:
 *
 *  1. ONLY THE PROJECT'S FOLDERS. The CLI names a folder after its cwd with
 *     every non-alphanumeric character turned into `-`, so only folders whose
 *     name starts with the encoded project path are opened. That is a
 *     prefilter: the cwd read in the tail decides (`isInsideDir`), so
 *     `topics-app2` does not pass for `topics-app`. Measured on topics-app: 4
 *     folders of 225, 29 transcripts instead of 2,433.
 *  2. ONE PAGE AT A TIME. Every file of those folders is `stat`ed, sorted by
 *     mtime, stripped of the sessions Topics owns BY NAME (the file is the
 *     session id, nothing is read), and tails are read in order only until the
 *     page has its rows. «Load older» asks for the next page with a cursor.
 *  3. OFF THE LOOP. Tails are read with asynchronous I/O, never the whole file.
 *
 * Its cache is its own: per path, valid while mtime and size hold, at most 500
 * entries with the least recently used leaving first. It never touches the
 * census's cache, and the census never touches it.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectDirName } from "./claude-transcript-path";
import { DEFAULT_ACTIVE_MS, parseTranscriptFacts, type TranscriptFacts } from "./external-claude-sessions";
import { isInsideDir } from "./path-containment";

/** Where the title of a row comes from: `/rename`, the CLI's own title, or the last question. */
export type ResumableTitleSource = "custom" | "ai" | "prompt";

export interface ResumableSession {
  sessionId: string;
  title: string | null;
  titleSource: ResumableTitleSource | null;
  branch: string | null;
  cwd: string;
  /** Last activity: the transcript's mtime, epoch ms. */
  lastActivityAt: number;
  /** Touched within the last 15 minutes: maybe still running in a terminal. */
  active: boolean;
  transcriptPath: string;
}

export interface ResumablePage {
  sessions: ResumableSession[];
  /** More transcripts are left after this page. */
  more: boolean;
  /** Where the next page starts (`before`), when there is one. */
  cursor: string | null;
}

export interface ResumableFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  readTail(path: string, size: number, bytes: number): Promise<string>;
}

/** The size of a page. */
export const RESUMABLE_PAGE = 20;
/** How much of a transcript's tail is read: every title record measured sits in the last 64 KB. */
const TAIL_BYTES = 64 * 1024;
const CACHE_MAX = 500;
/** The longest last question shown as a title. */
const PROMPT_TITLE_CHARS = 80;

const realFs: ResumableFs = {
  async readdir(dir) {
    try { return await readdir(dir); } catch { return []; }
  },
  async stat(path) {
    try {
      const st = await stat(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch { return null; }
  },
  async readTail(path, size, bytes) {
    try {
      return await Bun.file(path).slice(Math.max(0, size - bytes), size).text();
    } catch { return ""; }
  },
};

/**
 * The title of a session from its transcript's tail: the name given with
 * `/rename` (`custom-title`), then the one the CLI generated (`ai-title`), then
 * the last question asked (`last-prompt`), cut. Measured on the transcripts of
 * topics-app on 03/10: these records sit in the last 64 KB in every case
 * (custom-title 11 of 11, ai-title 3 of 3, last-prompt 24 of 24). The LAST
 * record of each kind wins: a second `/rename` replaces the first.
 */
export function parseTranscriptTitle(text: string): { title: string | null; source: ResumableTitleSource | null } {
  let custom: string | null = null;
  let ai: string | null = null;
  let prompt: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || !/"type":"(custom-title|ai-title|last-prompt)"/.test(line)) continue;
    let obj: { type?: unknown; customTitle?: unknown; aiTitle?: unknown; lastPrompt?: unknown };
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "custom-title" && typeof obj.customTitle === "string" && obj.customTitle.trim()) custom = obj.customTitle.trim();
    else if (obj.type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle.trim()) ai = obj.aiTitle.trim();
    else if (obj.type === "last-prompt" && typeof obj.lastPrompt === "string" && obj.lastPrompt.trim()) prompt = obj.lastPrompt.trim();
  }
  if (custom) return { title: custom, source: "custom" };
  if (ai) return { title: ai, source: "ai" };
  if (prompt) {
    const flat = prompt.replace(/\s+/g, " ");
    return { title: flat.length > PROMPT_TITLE_CHARS ? `${flat.slice(0, PROMPT_TITLE_CHARS - 1)}…` : flat, source: "prompt" };
  }
  return { title: null, source: null };
}

interface Parsed {
  facts: TranscriptFacts;
  title: { title: string | null; source: ResumableTitleSource | null };
}
const cache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();

function cached(path: string, mtimeMs: number, size: number): Parsed | null {
  const hit = cache.get(path);
  if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) return null;
  // Least recently USED leaves first: a hit moves to the end.
  cache.delete(path);
  cache.set(path, hit);
  return hit.parsed;
}

function remember(path: string, mtimeMs: number, size: number, parsed: Parsed): void {
  cache.delete(path);
  cache.set(path, { mtimeMs, size, parsed });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop the cache (tests). */
export function clearResumableCache(): void {
  cache.clear();
}

/** The cache's size (tests). */
export function resumableCacheSize(): number {
  return cache.size;
}

/** The order of the list: newest first, then the session id, so a cursor is exact even on equal mtimes. */
function after(a: { mtimeMs: number; sessionId: string }, cursor: { mtimeMs: number; sessionId: string }): boolean {
  return a.mtimeMs < cursor.mtimeMs || (a.mtimeMs === cursor.mtimeMs && a.sessionId > cursor.sessionId);
}

function parseCursor(before: string | null | undefined): { mtimeMs: number; sessionId: string } | null {
  if (!before) return null;
  const at = before.indexOf(":");
  const mtimeMs = Number(at >= 0 ? before.slice(0, at) : before);
  if (!Number.isFinite(mtimeMs)) return null;
  return { mtimeMs, sessionId: at >= 0 ? before.slice(at + 1) : "" };
}

export interface ListResumableOptions {
  /** The project whose sessions are listed. */
  projectPath: string;
  /** Session ids a chat of Topics already holds (`claude_code_sessions`). */
  ownedSessionIds: ReadonlySet<string>;
  /** The cursor of the previous page (`mtime:sessionId`). */
  before?: string | null;
  pageSize?: number;
  projectsDir?: string;
  nowMs?: number;
  activeMs?: number;
  fs?: ResumableFs;
}

/** One page of the project's sessions that Topics does not own, newest first. */
export async function listResumableClaudeSessions(opts: ListResumableOptions): Promise<ResumablePage> {
  const fs = opts.fs ?? realFs;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const pageSize = opts.pageSize ?? RESUMABLE_PAGE;
  const now = opts.nowMs ?? Date.now();
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const prefix = claudeProjectDirName(opts.projectPath);
  const cursor = parseCursor(opts.before);

  const candidates: Array<{ path: string; sessionId: string; mtimeMs: number; size: number }> = [];
  for (const entry of await fs.readdir(projectsDir)) {
    if (!entry.startsWith(prefix)) continue;
    const dir = join(projectsDir, entry);
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      // Owned by a chat already: dropped by its name, before anything is read.
      if (!sessionId || opts.ownedSessionIds.has(sessionId)) continue;
      const path = join(dir, file);
      const st = await fs.stat(path);
      if (!st || st.size <= 0) continue;
      candidates.push({ path, sessionId, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const ordered = cursor ? candidates.filter((c) => after(c, cursor)) : candidates;

  const sessions: ResumableSession[] = [];
  let i = 0;
  for (; i < ordered.length && sessions.length < pageSize; i++) {
    const c = ordered[i]!;
    let parsed = cached(c.path, c.mtimeMs, c.size);
    if (!parsed) {
      const tail = await fs.readTail(c.path, c.size, TAIL_BYTES);
      parsed = { facts: parseTranscriptFacts(tail), title: parseTranscriptTitle(tail) };
      remember(c.path, c.mtimeMs, c.size, parsed);
    }
    const { facts, title } = parsed;
    // The cwd decides, not the folder's name; a sub-agent's sidechain is part
    // of its parent's session, not one of its own.
    if (!facts.cwd || facts.sidechain || !isInsideDir(facts.cwd, opts.projectPath)) continue;
    sessions.push({
      sessionId: c.sessionId,
      title: title.title,
      titleSource: title.source,
      branch: facts.branch,
      cwd: facts.cwd,
      lastActivityAt: c.mtimeMs,
      active: now - c.mtimeMs <= activeMs,
      transcriptPath: c.path,
    });
  }
  const more = i < ordered.length;
  const last = ordered[i - 1];
  return { sessions, more, cursor: more && last ? `${last.mtimeMs}:${last.sessionId}` : null };
}
