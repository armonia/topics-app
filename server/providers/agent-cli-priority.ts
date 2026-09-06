/**
 * THE CLI OF A CARD IS DEMOTED TOO, not only the PTY of a terminal.
 *
 * KANBAN-78 covered three doors - the review checks, the native runtime's
 * commands, the PTY of an agent - and missed the widest one: a dispatched
 * card is a CHAT session, and its CLI (`claude`, `codex`) is spawned by the
 * provider, directly or through the ai-bridge daemon. Everything the card
 * runs afterwards - `bun test`, a Vite build, a Playwright battery with its
 * Chromiums - is a child of that CLI and inherits its priority. Measured on
 * 2026-09-06 at 16:30: two headless Chromiums of a card at nice 0 next to
 * WindowServer at 79 %, load 11 on twelve cores, the person's own browser
 * stuttering. The governor was live and had no hold on them.
 *
 * Two signs, either one enough: the session is BOUND TO A CARD (the topic's
 * session key belongs to a dispatched task, the same reading the job quota
 * uses), or its working directory is an agent worktree (`isAgentWorkspace`).
 * A person's chat in their own repo matches neither and keeps its priority:
 * that is the one somebody is waiting on. Best-effort, like every demotion:
 * a store that cannot answer means "not a card", never an exception in the
 * spawn path.
 */
import { homedir } from "os";
import { getDatabase } from "../db";
import { isAgentWorkspace, lowerPriority } from "../lib/low-priority";
import { readDispatchBinding } from "../services/agent-job-quota";

export interface AgentCliPriorityDeps {
  /** Whether this session key belongs to a dispatched card. */
  isDispatched: (sessionKey: string) => boolean;
  /** Whether this working directory is an agent's (worktree of a card or a subagent). */
  isAgentCwd: (cwd: string) => boolean;
  /** The demotion itself. */
  demote: (pid: number) => void;
}

function defaultDeps(): AgentCliPriorityDeps {
  return {
    isDispatched: (sessionKey) => {
      try { return readDispatchBinding(getDatabase(), sessionKey).dispatched; } catch { return false; }
    },
    isAgentCwd: (cwd) => isAgentWorkspace(cwd, undefined, homedir()),
    demote: (pid) => lowerPriority(pid),
  };
}

/**
 * Demote the CLI just spawned for `sessionKey` in `workspace` when it works
 * for an agent. Returns whether it did, for the log line and the tests.
 */
export function demoteAgentCli(
  sessionKey: string,
  workspace: string,
  pid: number | undefined,
  deps: AgentCliPriorityDeps = defaultDeps(),
): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  const agent = deps.isDispatched(sessionKey) || deps.isAgentCwd(workspace);
  if (!agent) return false;
  deps.demote(pid);
  return true;
}
