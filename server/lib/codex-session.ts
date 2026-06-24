/**
 * codex-session.ts — discover the OpenAI Codex CLI's per-session rollout id so a
 * Topics terminal PTY running `codex` can be RESUMED across a server/bridge
 * restart (the codex analogue of claude-code's `--resume`).
 *
 * Codex — unlike `claude`, which accepts `--session-id` to PRE-assign an id —
 * mints its OWN session UUID at startup and writes a JSONL "rollout" to
 *   ($CODEX_HOME || ~/.codex)/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl
 * whose FIRST line is a `session_meta` record:
 *   {"type":"session_meta","payload":{"id":"<UUID>","cwd":"<abs>","originator":"codex-tui",...}}
 * The UUID in payload.id (== the filename suffix) is exactly what
 * `codex resume <UUID>` expects.
 *
 * Because the id isn't known until codex has started, `createSession` kicks off
 * a best-effort discovery shortly after spawn that matches the freshly-written
 * rollout by cwd + recency and stores its id on the terminal_sessions row (the
 * generic resumable-pointer slot, reusing the `claude_session_id` column). If
 * discovery fails the pane is simply non-resumable and relaunches fresh — never
 * worse than the prior behaviour.
 *
 * KNOWN LIMITATION: matching is by cwd + newest-mtime-after-spawn. Two codex
 * panes started in the SAME cwd within the discovery window could resolve to
 * the same rollout. Topics panes are project/cwd-scoped so this is not an
 * encouraged pattern, and the failure mode is "resume the other codex in the
 * same directory", not data loss. Documented and accepted.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'fs';

/** ($CODEX_HOME || ~/.codex)/sessions — where codex writes rollout JSONL files.
 *  $CODEX_HOME is honoured by the codex CLI itself and is on the chat
 *  provider's env allowlist, so respecting it here keeps the two surfaces
 *  consistent. */
export function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(home, 'sessions');
}

interface RolloutMeta {
  id: string;
  cwd: string;
  mtimeMs: number;
  isSubagent: boolean;
  originator: string | null;
}

function safeSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function safeFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read just the first line of a (potentially huge) rollout without slurping the
 *  whole file. session_meta is always line 1; 64 KB is comfortably larger than
 *  any real first record. Returns null if no newline is found within the cap
 *  (a pathologically long first line — treat as unparseable rather than guess). */
function readFirstLine(file: string, maxBytes = 65536): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.toString('utf-8', 0, n);
    const nl = s.indexOf('\n');
    if (nl !== -1) return s.slice(0, nl);
    // No newline yet: only trust it as the whole first line if we hit EOF.
    return n < maxBytes ? s : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readRolloutMeta(file: string): RolloutMeta | null {
  const line = readFirstLine(file);
  if (!line) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== 'session_meta' || !obj.payload) return null;
  const p = obj.payload;
  if (typeof p.id !== 'string' || typeof p.cwd !== 'string') return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const isSubagent = p.thread_source === 'subagent' || !!(p.source && p.source.subagent);
  return {
    id: p.id,
    cwd: p.cwd,
    mtimeMs,
    isSubagent,
    originator: typeof p.originator === 'string' ? p.originator : null,
  };
}

/** Rollout files under the most-recent `maxDayDirs` date directories. Date dirs
 *  are YYYY/MM/DD so lexicographic sort == chronological; a brand-new rollout
 *  lives under today's dir, so scanning the latest few is enough for discovery
 *  while staying O(small). */
function recentRolloutFiles(root: string, maxDayDirs: number): string[] {
  const dayDirs: { path: string; key: string }[] = [];
  for (const y of safeSubdirs(root)) {
    for (const m of safeSubdirs(join(root, y))) {
      for (const d of safeSubdirs(join(root, y, m))) {
        dayDirs.push({ path: join(root, y, m, d), key: `${y}/${m}/${d}` });
      }
    }
  }
  dayDirs.sort((a, b) => b.key.localeCompare(a.key));
  const out: string[] = [];
  for (const dd of dayDirs.slice(0, maxDayDirs)) {
    for (const f of safeFiles(dd.path)) {
      if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(join(dd.path, f));
    }
  }
  return out;
}

/**
 * Best-effort: find the UUID of the codex session most likely just started in
 * `cwd`. Matches a non-subagent, codex-tui rollout in the same cwd whose file
 * mtime is at/after the spawn time (minus a small clock-skew tolerance), taking
 * the newest. Returns null when nothing matches (caller treats the pane as
 * non-resumable).
 */
export function discoverCodexSessionId(opts: {
  cwd: string;
  sinceMs: number;
  root?: string;
  skewMs?: number;
}): string | null {
  const root = opts.root ?? codexSessionsRoot();
  const skewMs = opts.skewMs ?? 5000;
  if (!existsSync(root)) return null;
  let best: RolloutMeta | null = null;
  for (const file of recentRolloutFiles(root, 3)) {
    const meta = readRolloutMeta(file);
    if (!meta) continue;
    if (meta.isSubagent) continue;
    // codex-tui = an interactive TUI session (what a PTY pane runs). Skip
    // exec/non-interactive rollouts. Tolerate a missing originator.
    if (meta.originator && meta.originator !== 'codex-tui') continue;
    if (meta.cwd !== opts.cwd) continue;
    if (meta.mtimeMs < opts.sinceMs - skewMs) continue;
    if (!best || meta.mtimeMs > best.mtimeMs) best = meta;
  }
  return best?.id ?? null;
}

/**
 * Does a rollout file for `id` still exist on disk? The resume guard — mirrors
 * claude's transcript-exists check so a `codex resume <id>` is only attempted
 * when codex can actually honour it (else the caller relaunches fresh instead
 * of looping "appears then closes"). The UUID is the rollout filename suffix,
 * so this is a cheap suffix scan across date dirs.
 */
export function codexRolloutExists(id: string, root?: string): boolean {
  const r = root ?? codexSessionsRoot();
  if (!id || !existsSync(r)) return false;
  const suffix = `-${id}.jsonl`;
  for (const y of safeSubdirs(r)) {
    for (const m of safeSubdirs(join(r, y))) {
      for (const d of safeSubdirs(join(r, y, m))) {
        for (const f of safeFiles(join(r, y, m, d))) {
          if (f.startsWith('rollout-') && f.endsWith(suffix)) return true;
        }
      }
    }
  }
  return false;
}
