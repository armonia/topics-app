/**
 * claude-subagent-transcript.ts — discover the REAL transcript a Path-B
 * sub-agent (an MCP `spawn_agent` child, `parentSessionKey = topic:<id>`) wrote
 * on disk, so the parent chat can be woken with the sub-agent's actual final
 * result instead of "_(terminato senza output)_".
 *
 * WHY THIS EXISTS. `createSession` pre-assigns the child a `--session-id` and
 * records it as `claudeSessionId`, then reads the transcript at
 *   ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl
 * That assumption is WRONG for these sub-agents in practice: the claude-code we
 * launch does NOT honour the pre-assigned `--session-id` for them — it mints its
 * OWN session UUID and writes the transcript under THAT id. So a read keyed by
 * the pre-assigned id finds no file, falls back to the raw PTY scrollback (no
 * clean assistant text), and the wake delivers an empty body. Observed live:
 * pre-assigned `1dbf9713…` had no file anywhere; the child's real answer lived
 * in a differently-named `<minted>.jsonl` in the SAME project dir.
 *
 * DISAMBIGUATION. The parent topic's own chat and sibling sub-agents can share
 * the child's cwd, and the parent transcript is ACTIVELY appended (its mtime is
 * always fresh) — so "newest jsonl in the dir" grabs the parent, not the child.
 * The reliable signal is the child's UNIQUE spawn prompt: claude writes it as
 * the first `type:"user"` record, alongside a `cwd` field. We match on cwd +
 * prompt-snippet containment. A single-recent-file fallback covers sub-agents
 * spawned into an isolated cwd (no parent/sibling transcript to confuse).
 *
 * Pure + fs-only (no server imports) so it unit-tests against a fixture `root`,
 * exactly like discoverCodexSessionId / discoverOpencodeSessionId.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'fs';
import { claudeProjectDirName } from './claude-transcript-path';

/** ~/.claude/projects — where claude-code writes per-session transcripts. */
export function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Collapse whitespace + lowercase so prompt matching survives the TUI
 *  re-wrapping/normalising the text it stores. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** First `len` chars of a normalised prompt — a stable, unique-enough fingerprint
 *  to find the child's transcript by its opening user turn. Exported so the
 *  caller stores exactly what the matcher will compare against. */
export function normalizePromptSnippet(prompt: string, len = 80): string {
  return normalizeForMatch(prompt).slice(0, len);
}

function safeJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read up to the first `maxBytes` of a file and return its complete lines. The
 *  first `user` record (with cwd + prompt) is within the first few KB even after
 *  the mode/permission/file-history preamble; 128 KB is a generous cap that
 *  never slurps a long transcript. */
function readEarlyLines(file: string, maxBytes = 131072): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, n).split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** cwd + text of the FIRST `type:"user"` record in a claude transcript, or null.
 *  Handles both string content and the `[{type:'text',text}]` array shape. */
function firstUserRecord(lines: string[]): { cwd: string | null; text: string } | null {
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || ev.type !== 'user') continue;
    const content = ev?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }
    return { cwd: typeof ev.cwd === 'string' ? ev.cwd : null, text };
  }
  return null;
}

/**
 * Best-effort: the real session id of the sub-agent just spawned in `cwd` with
 * `promptSnippet` as its opening prompt. Scans the cwd's project dir for a
 * transcript whose first user turn contains the snippet (and, when the record
 * carries one, whose cwd matches). Falls back to the sole recent transcript when
 * the cwd is isolated. Returns null when nothing matches — the caller then keeps
 * the pre-assigned id (no regression vs. today's buffer fallback).
 */
export function discoverClaudeSubAgentSessionId(opts: {
  cwd: string;
  promptSnippet: string;
  sinceMs: number;
  root?: string;
  skewMs?: number;
}): string | null {
  const root = opts.root ?? claudeProjectsRoot();
  const dir = join(root, claudeProjectDirName(opts.cwd));
  if (!existsSync(dir)) return null;
  const skewMs = opts.skewMs ?? 5000;
  const snippet = normalizeForMatch(opts.promptSnippet);

  let bestMatch: { id: string; mtimeMs: number } | null = null;
  // Fallback candidates must be BORN after the spawn, not merely appended to.
  // A long-lived session sharing this cwd (the orchestrator's OWN chat, or a
  // human CLI running here) has a fresh mtime forever, so mtime-recency would
  // wrongly adopt it; its birthtime, though, predates the spawn. Only a
  // transcript created at/after spawn time can be this child.
  const freshBorn: { id: string; mtimeMs: number }[] = [];

  for (const name of safeJsonlFiles(dir)) {
    const file = join(dir, name);
    let mtimeMs: number;
    let birthtimeMs: number;
    try {
      const st = statSync(file);
      mtimeMs = st.mtimeMs;
      birthtimeMs = st.birthtimeMs;
    } catch { continue; }
    // Too old to belong to this spawn — prunes stale sessions (and old
    // sub-agents with a coincidentally similar prompt) and keeps the scan cheap.
    if (mtimeMs < opts.sinceMs - skewMs) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (birthtimeMs >= opts.sinceMs - skewMs) freshBorn.push({ id, mtimeMs });

    if (!snippet) continue;
    const rec = firstUserRecord(readEarlyLines(file));
    if (!rec) continue;
    if (rec.cwd && rec.cwd !== opts.cwd) continue; // belt: wrong working dir
    if (!normalizeForMatch(rec.text).includes(snippet)) continue;
    if (!bestMatch || mtimeMs > bestMatch.mtimeMs) bestMatch = { id, mtimeMs };
  }

  if (bestMatch) return bestMatch.id;
  // Isolated cwd: exactly one transcript BORN for this spawn is unambiguously
  // the child (a shared long-lived session is excluded by birthtime above).
  if (freshBorn.length === 1) return freshBorn[0].id;
  return null;
}
