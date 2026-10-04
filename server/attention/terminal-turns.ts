/**
 * A TERMINAL'S TURNS AND ITS END, FOR THE ATTENTION STORE
 * (notifications-redesign, design sections 4.2 and 5.5).
 *
 * A claude-code terminal whose hooks never spoke has only its PTY activity
 * for a turn: busy opens it (T1), the quiet after it closes it with something
 * to read (T2), as the client read it before. A terminal with hooks is driven
 * by them (`tracker-sync.ts`). The exit of the PTY ends what it was waiting
 * on (T16) unless the person ended it; a retired terminal (closed, swept) is
 * idle with its rows seen (T13).
 */
import { processEnded, turnEnded, turnStarted } from "./store";
import { terminalClosed } from "./wire";
import { terminalSubject } from "../../shared/attention";

export { terminalClosed };

interface TerminalLike {
  type: string;
  claudeSessionId?: string | null;
}

interface TrackerLike {
  getSession(claudeSessionId: string): { lastHookAt?: number } | null;
}

function isHooklessClaudeTerminal(session: TerminalLike, tracker: TrackerLike | null | undefined): boolean {
  if (session.type !== "claude-code" && session.type !== "claude-code-team") return false;
  if (!session.claudeSessionId) return true;
  return !tracker?.getSession(session.claudeSessionId)?.lastHookAt;
}

/** The PTY went busy (a turn opens) or quiet after work (the turn ends with something to read). */
export function terminalActivity(id: string, session: TerminalLike, busy: boolean, tracker: TrackerLike | null | undefined): void {
  if (!isHooklessClaudeTerminal(session, tracker)) return;
  if (busy) turnStarted(terminalSubject(id));
  else turnEnded(terminalSubject(id), { turnId: `pty:${id}:${Date.now()}`, outcome: "done" });
}

/** The PTY exited; `byPerson`: a clean exit or a reload the person asked for. */
export function terminalExited(id: string, byPerson: boolean): void {
  processEnded(terminalSubject(id), { cause: "pty-exit", byPerson });
}
