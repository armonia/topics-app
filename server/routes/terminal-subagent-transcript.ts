import { getDatabase } from "../db";
import { warnThrottled } from "../lib/warn-throttled";
import fs from "fs";
import { liveClaudeSessionId } from "../lib/claude-live-session";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import { discoverClaudeSubAgentSessionId } from "../lib/claude-subagent-transcript";
import { setSubagentSessionId } from "../lib/subagent-store";
import { type ChildRef } from "../lib/subagent-runtime";
import { sessions } from "./terminal-state";
import { _tracker, broadcastTerminalSessions } from "./terminal-shared";

/** The lines of a sub-agent's own transcript (which survives the PTY death),
 *  or null when none can be found. Adopts the real transcript id first, for a
 *  child whose capture missed it. */
export async function readChildTranscriptLines(child: ChildRef): Promise<string[] | null> {
  resolveChildTranscriptSessionId(child);
  if (!child.claudeSessionId) return null;
  try {
    const raw = await fs.promises.readFile(claudeTranscriptPath(child.cwd, child.claudeSessionId), 'utf-8');
    return raw.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

/** Discover a sub-agent's REAL transcript id (claude-code ignores the pre-assigned
 *  `--session-id` for children) and adopt it onto the session + DB row so every
 *  subsequent transcript read hits the right .jsonl. No-op unless this is a
 *  sub-agent. Returns true when it adopted a new id. Cheap and idempotent — safe
 *  to call from the read/wake paths. */
export function resolveChildTranscriptSessionId(child: ChildRef): boolean {
  if (!child.parentSessionKey) return false;
  const found = cliReportedSessionId(child) ?? transcriptFoundByPrompt(child);
  if (!found || found === child.claudeSessionId) return false;
  const prev = child.claudeSessionId;
  child.claudeSessionId = found;
  try {
    getDatabase().run("UPDATE terminal_sessions SET claude_session_id = ? WHERE id = ?", [found, child.id]);
  } catch (e) {
    console.warn(`[Terminal] sub-agent session-id adopt failed for ${child.id}:`, e);
  }
  // The row is what a resume reads once the terminal row is gone.
  setSubagentSessionId(getDatabase(), child.id, found);
  // Re-key the phase tracker onto the id claude actually uses (its hooks carry
  // the minted id, so the pre-assigned registration never matched).
  if (prev) _tracker?.dropTerminalSession(prev);
  _tracker?.registerTerminalSession(found, { cwd: child.cwd });
  return true;
}

/**
 * The conversation the child's own CLI says it is on (`~/.claude/sessions/<pid>.json`),
 * while its process lives. It comes first, and it wins over an id recorded
 * earlier: two siblings are two processes, so two ids, whatever their prompts
 * say, and a guess the content scan made before this file appeared is put right.
 */
function cliReportedSessionId(child: ChildRef): string | null {
  const pid = sessions.get(child.id)?.ptyPid;
  return pid && pid > 0 ? liveClaudeSessionId(pid) : null;
}

/** Without the CLI's word (the child is gone, or its CLI writes no session
 *  file): the transcript found by the child's opening prompt, never one that
 *  another session holds. A recorded id whose transcript exists is kept. */
function transcriptFoundByPrompt(child: ChildRef): string | null {
  if (!child.spawnPromptSnippet) return null;
  if (child.claudeSessionId && fs.existsSync(claudeTranscriptPath(child.cwd, child.claudeSessionId))) return null;
  return discoverClaudeSubAgentSessionId({
    cwd: child.cwd,
    promptSnippet: child.spawnPromptSnippet,
    sinceMs: Date.parse(child.createdAt) || 0,
    excludeIds: sessionIdsHeldByOthers(child.id),
  });
}

/** The conversations held by every session but `childId`: a live pane or
 *  child, or a sub-agent row, which is what a resume of that child opens. */
function sessionIdsHeldByOthers(childId: string): Set<string> {
  const held = new Set<string>();
  for (const s of sessions.values()) if (s.id !== childId && s.claudeSessionId) held.add(s.claudeSessionId);
  try {
    const rows = getDatabase()
      .query("SELECT claude_session_id AS id FROM subagents WHERE id <> ? AND claude_session_id IS NOT NULL")
      .all(childId) as Array<{ id: string }>;
    for (const r of rows) held.add(r.id);
  } catch (e) {
    warnThrottled("subagents:held-ids", `[Terminal] subagents: reading the held conversations failed, only the live sessions are excluded:`, e);
  }
  return held;
}

/** After a sub-agent PTY launches, poll for the transcript claude actually wrote
 *  (matched by cwd + the child's opening prompt) and adopt its id, mirroring the
 *  codex id-capture. Bounded, self-cancelling, unref'd. Best-effort — the wake
 *  path re-attempts discovery if this misses. */
export function scheduleClaudeSubAgentIdCapture(childId: string): void {
  let attempts = 0;
  const poll = () => {
    const child = sessions.get(childId);
    if (!child) return; // stopped before the transcript appeared
    if (resolveChildTranscriptSessionId(child)) {
      broadcastTerminalSessions();
      return;
    }
    if (++attempts < 20) {
      const t = setTimeout(poll, 1000);
      t.unref?.();
    }
  };
  const t = setTimeout(poll, 1000);
  t.unref?.();
}

