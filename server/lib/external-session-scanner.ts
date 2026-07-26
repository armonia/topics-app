/**
 * ExternalSessionScanner — makes Claude Code sessions started OUTSIDE Topics
 * (a bare `claude` in a terminal, another tool's SDK run) visible to the app.
 *
 * The session tracker only follows sessions Topics itself created (its repo
 * rows + registered terminal PTYs); everything else is invisible, so a repo
 * with three live sessions can look idle on the board — and the kanban
 * dispatcher can happily send an agent onto a repo a human is already editing.
 *
 * This scanner takes the other route: every Claude Code session, wherever it
 * was started, appends to `~/.claude/projects/<encoded-cwd>/<csid>.jsonl`.
 * A periodic mtime sweep of that root is enough to answer "which sessions are
 * alive right now, and in which cwd?" with zero cooperation from the session.
 *
 * Scope guards:
 *  - sessions Topics already tracks are excluded (`knownSessionIds`);
 *  - sidechain transcripts (Task-tool sub-agents) are excluded — they mirror a
 *    parent that is already counted;
 *  - cwds under ignored roots (Topics worktrees, tmp scratchpads) are excluded:
 *    those are Topics-launched flows even when their csid isn't in the DB.
 *
 * Read-only by design: it never writes into the session tracker or the DB —
 * external sessions surface as their own overlay (`/api/external-sessions` +
 * `external-sessions:state`) and as a dispatcher guard, nothing more.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

export interface ExternalClaudeSession {
  claudeSessionId: string;
  jsonlPath: string;
  /** Encoded project dir name under ~/.claude/projects (lossy cwd encoding). */
  dirName: string;
  /** Real cwd read from the transcript entries; null if unreadable. */
  cwd: string | null;
  /** Session title (ai-title / agent-name line) when present. */
  title: string | null;
  /** Transcript mtime — last observed activity, epoch ms. */
  lastActivityAt: number;
}

export interface ExternalSessionScannerOptions {
  /** Root to sweep. Default `<home>/.claude/projects`. */
  projectsRoot?: string;
  /** A transcript touched within this window counts as LIVE. Default 5 min. */
  liveWindowMs?: number;
  /** Sweep cadence. Default 30 s (the "visible within a minute" budget). */
  scanIntervalMs?: number;
  /** Claude session ids Topics already tracks (DB rows + terminal PTYs). */
  knownSessionIds: () => Set<string>;
  /** cwd roots whose sessions are Topics-launched even without a known csid. */
  ignoredCwdRoots?: string[];
  broadcast: (msg: object) => void;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export interface ExternalSessionScanner {
  /** One sweep; returns the current live external sessions (newest first). */
  scanOnce(): ExternalClaudeSession[];
  /** Last sweep's result without re-scanning. */
  list(): ExternalClaudeSession[];
  /**
   * Dispatcher guard: live external activity attributable to `path`?
   * Matches on the real cwd (either side nested in the other) or, when the
   * transcript's cwd is unreadable, on the encoded dir name.
   */
  busyInfo(path: string): { count: number; lastActivityAt: number } | null;
  start(): void;
  stop(): void;
}

/** Same lossy encoding Claude Code uses for its per-cwd transcript dirs. */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function isPathWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** Transcript facts that never change once written — cached per jsonl path. */
interface TranscriptMeta {
  cwd: string | null;
  sidechain: boolean;
  title: string | null;
}

const HEAD_BYTES = 16 * 1024; // titles live in the first few lines
const TAIL_BYTES = 64 * 1024; // recent entries almost always carry cwd

function readSlice(path: string, position: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, position);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Extract cwd/sidechain/title from a transcript without reading the whole
 * file: head slice for the title lines, tail slice for the latest message
 * entries (early lines can be megabyte-scale file-history snapshots that
 * would starve a head-only scan of the cwd).
 */
export function readTranscriptMeta(path: string, size: number): TranscriptMeta {
  const meta: TranscriptMeta = { cwd: null, sidechain: false, title: null };
  try {
    const head = readSlice(path, 0, Math.min(HEAD_BYTES, size));
    for (const line of head.split('\n')) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (meta.title === null && typeof obj.aiTitle === 'string' && obj.aiTitle) meta.title = obj.aiTitle;
      if (meta.title === null && typeof obj.agentName === 'string' && obj.agentName) meta.title = obj.agentName;
      if (meta.cwd === null && typeof obj.cwd === 'string' && obj.cwd) meta.cwd = obj.cwd;
      if (obj.isSidechain === true) meta.sidechain = true;
    }
    if (meta.cwd === null || !meta.sidechain) {
      const start = Math.max(0, size - TAIL_BYTES);
      const tail = readSlice(path, start, Math.min(TAIL_BYTES, size));
      const lines = tail.split('\n');
      // First line of a mid-file slice is almost surely partial — drop it.
      for (let i = start > 0 ? 1 : 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { continue; }
        if (typeof obj.cwd === 'string' && obj.cwd) meta.cwd = obj.cwd;
        if (obj.isSidechain === true) meta.sidechain = true;
      }
    }
  } catch { /* unreadable file → nulls; the dirName fallback still works */ }
  return meta;
}

export function createExternalSessionScanner(opts: ExternalSessionScannerOptions): ExternalSessionScanner {
  const projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
  const liveWindowMs = opts.liveWindowMs ?? 5 * 60_000;
  const scanIntervalMs = opts.scanIntervalMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string, err?: unknown) => console.warn(`[external-sessions] ${msg}`, err ?? ''));
  const ignoredRoots = opts.ignoredCwdRoots ?? [];
  const ignoredDirPrefixes = ignoredRoots.map(encodeClaudeCwd);

  // Immutable transcript facts, keyed by jsonl path. Bounded by the number of
  // transcripts that were EVER live during this process — small in practice.
  const metaCache = new Map<string, TranscriptMeta>();
  let current: ExternalClaudeSession[] = [];
  let lastBroadcastKey = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  function scanOnce(): ExternalClaudeSession[] {
    const t = now();
    const known = opts.knownSessionIds();
    const found: ExternalClaudeSession[] = [];
    let dirs: string[] = [];
    try { dirs = readdirSync(projectsRoot); } catch { /* no ~/.claude/projects → nothing external */ }
    for (const dirName of dirs) {
      if (ignoredDirPrefixes.some((p) => dirName.startsWith(p))) continue;
      const dirPath = join(projectsRoot, dirName);
      let files: string[] = [];
      try { files = readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const csid = basename(f, '.jsonl');
        if (known.has(csid)) continue;
        const jsonlPath = join(dirPath, f);
        let st;
        try { st = statSync(jsonlPath); } catch { continue; }
        if (!st.isFile()) continue;
        const mtime = st.mtimeMs;
        if (t - mtime > liveWindowMs) continue;
        let meta = metaCache.get(jsonlPath);
        // Re-read while the cwd is still unresolved: the file keeps growing and
        // a later entry may finally carry it.
        if (!meta || meta.cwd === null) {
          meta = readTranscriptMeta(jsonlPath, st.size);
          metaCache.set(jsonlPath, meta);
        }
        if (meta.sidechain) continue;
        if (meta.cwd && ignoredRoots.some((r) => isPathWithin(meta!.cwd!, r))) continue;
        found.push({
          claudeSessionId: csid,
          jsonlPath,
          dirName,
          cwd: meta.cwd,
          title: meta.title,
          lastActivityAt: Math.round(mtime),
        });
      }
    }
    found.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    current = found;

    // Broadcast only when something the client renders actually changed:
    // membership, cwd resolution, title, or activity moved by >= 30 s.
    const key = found
      .map((s) => `${s.claudeSessionId}:${s.cwd ?? s.dirName}:${s.title ?? ''}:${Math.floor(s.lastActivityAt / 30_000)}`)
      .join('|');
    if (key !== lastBroadcastKey) {
      lastBroadcastKey = key;
      try {
        opts.broadcast({ type: 'external-sessions:state', sessions: found, payload_version: 1 });
      } catch (err) { log('broadcast failed', err); }
    }
    return found;
  }

  function busyInfo(path: string): { count: number; lastActivityAt: number } | null {
    const encoded = encodeClaudeCwd(path);
    let count = 0;
    let last = 0;
    for (const s of current) {
      const hit = s.cwd
        ? (isPathWithin(s.cwd, path) || isPathWithin(path, s.cwd))
        : s.dirName === encoded;
      if (!hit) continue;
      count++;
      if (s.lastActivityAt > last) last = s.lastActivityAt;
    }
    return count > 0 ? { count, lastActivityAt: last } : null;
  }

  return {
    scanOnce,
    list: () => current,
    busyInfo,
    start() {
      if (timer) return;
      try { scanOnce(); } catch (err) { log('initial scan failed', err); }
      timer = setInterval(() => {
        try { scanOnce(); } catch (err) { log('scan failed', err); }
      }, scanIntervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
