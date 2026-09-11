/**
 * Kill the process tree an agent's CLI has grown, on a human "Ferma".
 *
 * WHY IT EXISTS (card 9b36ea1b). Stopping a card used to cut the TURN —
 * `cutLiveTurn` in `routes/tasks.ts` — and nothing else: the CLI got a SIGINT
 * (or, headless, an abort through the chat route), which cancels the chat
 * exchange but leaves anything the agent's `Bash` tool spawned running. A
 * `bun run test:unit:shards` launched synchronously was still alive as a
 * child of the server *after* the card that started it had been stopped —
 * exactly the load a stop is meant to escape.
 *
 * WHY A SEPARATE FILE. `server.ts` cannot be imported from a test (it is the
 * entry point: side effects on import). The primitive lives here so both the
 * production wiring (`server.ts`) and a test that spawns real processes can
 * reach it without dragging in the whole server.
 *
 * SCOPE, on purpose narrow: only the descendants of THIS session's own CLI
 * pid. A sibling card's agent, the pty-bridge, and the git worktree are
 * different trees (or not processes at all) and are never reached from here.
 */
import { getSessionCliPid } from "../providers/session-pids";
import { killProcessTree } from "./process-tree";

export async function killAgentProcessTree(sessionKey: string): Promise<void> {
  const pid = getSessionCliPid(sessionKey);
  if (!pid) return;
  await killProcessTree(pid).catch(() => { /* best-effort: a dead tree is not a failure */ });
}
