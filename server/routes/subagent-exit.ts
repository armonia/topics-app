/**
 * Pure helpers for the Path-B sub-agent wake (see terminal.ts exit handler +
 * topics.ts deliverSubAgentExit). Kept side-effect-free so the message-shaping
 * logic can be unit-tested without importing the terminal runtime (bridge,
 * timers, session maps).
 */

/** A sub-agent spawned FROM a topic chat (`parentSessionKey` = `topic:<id>`) has
 *  exited. The topics router turns this into a chat message so the conversation
 *  that delegated the work reaches its end instead of hanging on a promise it
 *  can't keep ("ti aggiorno quando consegna"). */
export interface SubAgentExitInfo {
  parentSessionKey: string;
  childId: string;
  name: string;
  /** Last assistant message from the child's own transcript (may be empty when
   *  the child produced no assistant text or exited before writing one). */
  result: string;
  exitCode: number | null;
  /** The branch of the worktree the child worked in, when it had one of its own
   *  (WORKTREE-14). Absent for a child that inherited the parent's directory,
   *  which is exactly the case where the report must not change by a byte. */
  branch?: string | null;
}

/** The body of the chat message that reports a sub-agent's exit. Prefers the
 *  child's final assistant text; falls back to an italic status note when there
 *  is no recoverable output, distinguishing a non-zero exit (error) from a clean
 *  but silent finish. */
export function formatSubAgentExitBody(info: Pick<SubAgentExitInfo, 'result' | 'exitCode'>): string {
  const trimmed = info.result?.trim();
  if (trimmed) return trimmed;
  if (info.exitCode != null && info.exitCode !== 0) {
    return `_(terminato con codice ${info.exitCode}, nessun output recuperato)_`;
  }
  return '_(terminato senza output)_';
}

/** Full assistant-message content for a sub-agent exit: a bold header naming the
 *  sub-agent, then its result body, and, for a child that worked in a worktree
 *  of its own, the line saying WHERE that work is. The parent no longer has the
 *  files under its hand: the branch is all it has left to read. */
export function formatSubAgentExitMessage(info: Pick<SubAgentExitInfo, 'name' | 'result' | 'exitCode' | 'branch'>): string {
  const head = `🤖 **Sotto-agente "${info.name}", esito:**\n\n${formatSubAgentExitBody(info)}`;
  if (!info.branch) return head;
  return `${head}\n\nRamo: \`${info.branch}\`. Per leggerlo: \`git log main..${info.branch}\`.`;
}
