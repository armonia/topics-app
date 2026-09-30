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

/** One JSONL record of a claude transcript, as far as this module reads it. */
interface TranscriptEvent {
  type?: unknown;
  isMeta?: unknown;
  isApiErrorMessage?: unknown;
  cwd?: unknown;
  message?: { content?: unknown; stop_reason?: unknown };
}

/** The record on this line, or null when the line is not a JSON object. */
function parseEvent(line: string): TranscriptEvent | null {
  try {
    const ev: unknown = JSON.parse(line);
    return ev && typeof ev === 'object' ? (ev as TranscriptEvent) : null;
  } catch {
    return null;
  }
}

/** The text blocks of a message's content, joined; a string content as is. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}

/** cwd + text of the FIRST `type:"user"` record in a claude transcript, or null.
 *  Handles both string content and the `[{type:'text',text}]` array shape. */
function firstUserRecord(lines: string[]): { cwd: string | null; text: string } | null {
  for (const line of lines) {
    const ev = parseEvent(line);
    if (!ev || ev.type !== 'user') continue;
    return { cwd: typeof ev.cwd === 'string' ? ev.cwd : null, text: contentText(ev.message?.content) };
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

// ── Did the child get its prompt, and how did it end? ───────────────────────

/** A `type:"user"` record that is a PROMPT: typed text, not a tool result, not a
 *  meta line the CLI injects, not the marker of an Escape. */
function promptText(ev: TranscriptEvent | null): string | null {
  if (!ev || ev.type !== 'user' || ev.isMeta) return null;
  const content = ev.message?.content;
  if (Array.isArray(content) && content.some((c) => !!c && typeof c === 'object' && c.type === 'tool_result')) return null;
  const text = contentText(content);
  if (!text.trim() || text.startsWith('[Request interrupted by user')) return null;
  return text;
}

/**
 * True when the transcript holds a user record carrying the spawn prompt.
 *
 * The seed used to call a prompt accepted as soon as the transcript FILE
 * existed, and today's CLI creates it at start-up with nothing but its mode,
 * permission-mode and system records. So a seed whose single Enter was lost
 * reported success and nobody sent another one: the child sat idle until the
 * parent stopped it, and the chat read "finished with no output"
 * (d6158ec6 and c82359c1 on 22/09, both with zero user records).
 */
export function transcriptHasPrompt(lines: string[], promptSnippet: string): boolean {
  const snippet = normalizeForMatch(promptSnippet);
  for (const line of lines) {
    const text = promptText(parseEvent(line));
    if (text !== null && (!snippet || normalizeForMatch(text).includes(snippet))) return true;
  }
  return false;
}

/** How the child's process came to an end, as the server saw it. */
export type SubAgentEnding = 'exited' | 'stopped' | 'closed' | 'swept' | 'lost';

/**
 * The status vocabulary of the `subagent-tool-standard` proposal (SUBAGENT-11):
 * `completed` is the only one whose text is an outcome.
 */
export type SubAgentStatus = 'completed' | 'failed' | 'stopped' | 'undelivered' | 'lost';

export interface SubAgentOutcome {
  status: SubAgentStatus;
  /** The turn was cut before its end and `text` is the last line seen, not a result. */
  partial: boolean;
  /** The final text for `completed`; the last text seen otherwise (may be empty). */
  text: string;
  /** Why it is not `completed`, in words: an API error line, an exit code, a closed tab. */
  reason?: SubAgentReason;
}

/** The reasons, as codes: the words are the formatter's (`routes/subagent-exit.ts`). */
export type SubAgentReason =
  | { code: 'api-error'; detail: string }
  | { code: 'no-prompt' }
  | { code: 'no-transcript' }
  | { code: 'exit-code'; exitCode: number }
  | { code: 'exited-mid-turn' }
  | { code: 'stopped-by-parent' }
  | { code: 'tab-closed' }
  | { code: 'swept' }
  | { code: 'terminal-lost' };

/**
 * Classify a finished child from its transcript lines and the way it ended.
 *
 * It used to be "the last assistant text, whatever it was". A child stopped in
 * the middle of its work then reported a working sentence as its outcome (a
 * line announcing what it was about to map, 26/09), and a child that never got its
 * prompt, or died on a spend limit, reported "finished with no output". The
 * transcript says which of these happened: the record that closed the turn
 * carries `stop_reason: "end_turn"`, an API failure is a `<synthetic>` record
 * flagged `isApiErrorMessage`, and a prompt is a user record.
 *
 * `lines` is null when no transcript could be found at all.
 */
export function classifySubAgentTranscript(
  lines: string[] | null,
  ending: SubAgentEnding,
  exitCode: number | null = null,
): SubAgentOutcome {
  const cut = (text: string): SubAgentOutcome => {
    const partial = text.length > 0;
    if (ending === 'lost') return { status: 'lost', partial, text, reason: { code: 'terminal-lost' } };
    if (ending === 'stopped') return { status: 'stopped', partial, text, reason: { code: 'stopped-by-parent' } };
    if (ending === 'closed') return { status: 'stopped', partial, text, reason: { code: 'tab-closed' } };
    if (ending === 'swept') return { status: 'stopped', partial, text, reason: { code: 'swept' } };
    return {
      status: 'failed', partial, text,
      reason: exitCode != null && exitCode !== 0 ? { code: 'exit-code', exitCode } : { code: 'exited-mid-turn' },
    };
  };
  if (!lines) return { ...cut(''), reason: { code: 'no-transcript' } };

  let prompted = false;
  // The state after the last record that moved the conversation.
  let state: 'waiting' | 'working' | 'done' | 'api-error' = 'waiting';
  let turnText = '';
  let errorText = '';
  for (const line of lines) {
    const ev = parseEvent(line);
    if (!ev) continue;
    if (ev.type === 'user') {
      if (promptText(ev) !== null) {
        prompted = true;
        state = 'waiting';
        turnText = '';
      } else if (prompted) {
        // A tool result or an Escape marker: the turn is still open.
        state = 'working';
      }
      continue;
    }
    if (ev.type !== 'assistant') continue;
    const text = contentText(ev.message?.content).trim();
    if (ev.isApiErrorMessage) {
      state = 'api-error';
      errorText = text;
      continue;
    }
    if (text) turnText = text;
    state = ev.message?.stop_reason === 'end_turn' ? 'done' : 'working';
  }

  if (!prompted) return { status: 'undelivered', partial: false, text: '', reason: { code: 'no-prompt' } };
  if (state === 'done') return { status: 'completed', partial: false, text: turnText };
  if (state === 'api-error') {
    return { status: 'failed', partial: false, text: turnText, reason: { code: 'api-error', detail: errorText } };
  }
  return cut(turnText);
}

