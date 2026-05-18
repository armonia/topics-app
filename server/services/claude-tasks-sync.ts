/**
 * claude-tasks-sync.ts — Phase B (shared task list watcher).
 *
 * Watches Claude Code Agent Teams' shared task list at
 *   ~/.claude/projects/<project-hash>/tasks/*.json
 * and mirrors entries into Topics' `tasks` table so the kanban board
 * reflects what the lead and teammates are doing.
 *
 * Bidirectional sync semantics (see openspec/.../kanban/spec.md
 * KANBAN-DELTA-02):
 *   - File change → upsert task with `claude_task_id`
 *   - Last-write-wins on conflict (newer updated_at wins)
 *
 * Standalone: takes a small interface (file-system + DB-like callbacks)
 * so it can be unit-tested without booting the full server.
 */
import { existsSync, statSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClaudeTaskShape {
  id: string;
  // The shape Anthropic ships is still evolving. We accept whatever's there.
  title?: string;
  description?: string;
  status?: string;
  priority?: number | string;
  assigned_to?: string;
  updated_at?: string | number;
  [k: string]: unknown;
}

export interface SyncTarget {
  /** Returns the existing row (if any) so we can decide which wins. */
  findByClaudeTaskId(claudeTaskId: string): TopicsTaskRow | null;
  /** Upsert from claude side. */
  upsertFromClaude(input: TopicsTaskUpsert): void;
}

export interface TopicsTaskRow {
  id: string;
  claude_task_id: string;
  text: string;
  description: string | null;
  status: string;
  priority: number;
  updated_at: string;
}

export interface TopicsTaskUpsert {
  claude_task_id: string;
  text: string;
  description: string | null;
  status: string;
  priority: number;
  updated_at: string;
}

const VALID_STATUS = new Set(["backlog", "todo", "in_progress", "review", "done"]);

/** Normalize a Claude task into Topics' task shape, applying defaults. */
export function normalize(t: ClaudeTaskShape): TopicsTaskUpsert | null {
  if (!t?.id) return null;
  const text = String(t.title ?? t.id);
  let status = String(t.status ?? "todo").toLowerCase().replace(/-/g, "_");
  if (status === "pending") status = "todo";
  if (status === "completed") status = "done";
  if (!VALID_STATUS.has(status)) status = "todo";
  let priority = 2;
  if (typeof t.priority === "number") priority = Math.max(0, Math.min(4, t.priority));
  else if (typeof t.priority === "string") {
    const map: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3, p4: 4, high: 1, medium: 2, low: 3 };
    priority = map[t.priority.toLowerCase()] ?? 2;
  }
  const updated_at = t.updated_at
    ? new Date(typeof t.updated_at === "number" ? t.updated_at : String(t.updated_at)).toISOString()
    : new Date().toISOString();
  return {
    claude_task_id: t.id,
    text,
    description: t.description ? String(t.description) : null,
    status,
    priority,
    updated_at,
  };
}

/** Returns true if the claude side has newer data than the Topics side. */
export function claudeWins(existing: TopicsTaskRow | null, incoming: TopicsTaskUpsert): boolean {
  if (!existing) return true;
  return new Date(incoming.updated_at).getTime() >= new Date(existing.updated_at).getTime();
}

/** Pure ingest: read a JSON file and upsert all valid task entries. */
export function ingestFile(filePath: string, target: SyncTarget): { upserted: number; skipped: number } {
  let upserted = 0;
  let skipped = 0;
  let raw: string;
  try { raw = readFileSync(filePath, "utf-8"); } catch { return { upserted: 0, skipped: 0 }; }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return { upserted: 0, skipped: 0 }; }
  const items: ClaudeTaskShape[] = Array.isArray(payload)
    ? payload as ClaudeTaskShape[]
    : (payload && typeof payload === "object" && "tasks" in payload && Array.isArray((payload as any).tasks))
      ? (payload as any).tasks
      : [];
  for (const item of items) {
    const norm = normalize(item);
    if (!norm) { skipped++; continue; }
    const existing = target.findByClaudeTaskId(norm.claude_task_id);
    if (claudeWins(existing, norm)) {
      target.upsertFromClaude(norm);
      upserted++;
    } else {
      skipped++;
    }
  }
  return { upserted, skipped };
}

export interface SyncOptions {
  /** Override the discovery root (default ~/.claude/projects). */
  claudeProjectsDir?: string;
  /** Sync target (DB adapter). */
  target: SyncTarget;
  /** Poll interval ms for fallback (default 5000). */
  pollMs?: number;
}

export interface SyncHandle {
  stop(): void;
  /** Force a full scan now (returns counts for tests). */
  scanNow(): { upserted: number; skipped: number; files: number };
}

export function startClaudeTasksSync(opts: SyncOptions): SyncHandle {
  const root = opts.claudeProjectsDir
    || join(homedir(), ".claude", "projects");
  const pollMs = opts.pollMs ?? 5000;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const fileMtimes = new Map<string, number>();
  const watchers: FSWatcher[] = [];

  function listTaskFiles(): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { return out; }
    for (const e of entries) {
      const projDir = join(root, e);
      const tasksDir = join(projDir, "tasks");
      if (!existsSync(tasksDir)) continue;
      let files: string[] = [];
      try { files = readdirSync(tasksDir); } catch { continue; }
      for (const f of files) {
        if (f.endsWith(".json")) out.push(join(tasksDir, f));
      }
    }
    return out;
  }

  function scanNow(): { upserted: number; skipped: number; files: number } {
    let upserted = 0, skipped = 0, files = 0;
    for (const f of listTaskFiles()) {
      let mtime = 0;
      try { mtime = statSync(f).mtimeMs; } catch { continue; }
      if (fileMtimes.get(f) === mtime) continue;
      fileMtimes.set(f, mtime);
      const r = ingestFile(f, opts.target);
      upserted += r.upserted;
      skipped += r.skipped;
      files++;
    }
    return { upserted, skipped, files };
  }

  // Initial scan to populate mtimes (no upsert needed because target may be empty intentionally).
  scanNow();

  // FS watch on root (best effort; not all FS implementations support recursive watch).
  try {
    if (existsSync(root)) {
      const w = watch(root, { persistent: false, recursive: true } as any, () => {
        if (!stopped) scanNow();
      });
      watchers.push(w);
    }
  } catch {
    // Recursive watch unsupported (e.g. Linux without inotify-recursive). Fall back to poll.
  }

  // Polling fallback.
  timer = setInterval(() => { if (!stopped) scanNow(); }, pollMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    },
    scanNow,
  };
}
