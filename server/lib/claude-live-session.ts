/**
 * The conversation a running Claude Code CLI is on NOW. The CLI keeps a file for
 * its own process, `~/.claude/sessions/<pid>.json`, and a `/clear` moves it to a
 * fresh session id that this file follows. The `--session-id` a pane was spawned
 * with does not, and that is the id a park resumes: on 18/10 a pane cleared on
 * 13/10 would have reopened the conversation from five days before.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const defaultSessionsDir = () => join(homedir(), ".claude", "sessions");
let sessionsDirInUse = defaultSessionsDir();
/** Test seam: a test must never write next to the live CLI files. `null` restores the default. */
export function _setClaudeSessionsDirForTests(dir: string | null): void { sessionsDirInUse = dir ?? defaultSessionsDir(); }

export function liveClaudeSessionId(pid: number, sessionsDir = sessionsDirInUse): string | null {
  try {
    const entry = JSON.parse(readFileSync(join(sessionsDir, `${pid}.json`), "utf8")) as { sessionId?: unknown };
    return typeof entry.sessionId === "string" && entry.sessionId !== "" ? entry.sessionId : null;
  } catch {
    // No file yet (the CLI is still starting), none any more (it exited), or a torn write.
    return null;
  }
}

export interface ClaudePane {
  type: string;
  ptyPid?: number;
  claudeSessionId?: string;
  /** Sub-agents find their transcript their own way (`spawnPromptSnippet`) and are left to it. */
  parentSessionKey?: string;
}

/** Each Claude pane whose resume id is behind the conversation its CLI is on, with the id it moves to. */
export function panesToFollow<P extends ClaudePane>(
  panes: Iterable<P>,
  live: (pid: number) => string | null,
): Array<{ pane: P; sessionId: string }> {
  const out: Array<{ pane: P; sessionId: string }> = [];
  for (const pane of panes) {
    if (pane.type !== "claude-code" && pane.type !== "claude-code-team") continue;
    if (pane.parentSessionKey || !pane.ptyPid || pane.ptyPid <= 0) continue;
    const sessionId = live(pane.ptyPid);
    if (sessionId && sessionId !== pane.claudeSessionId) out.push({ pane, sessionId });
  }
  return out;
}
