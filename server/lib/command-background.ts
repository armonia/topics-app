/**
 * THE COMMANDS A CHAT IS STILL RUNNING, for its background line (BGVIS-07).
 *
 * On 30/09 an agent started a loop with `run_command`, told the person "this
 * topic gets a message when it ends" and ended its turn: the chat showed
 * nothing at all, no turn, no line, for as long as the loop ran. The line read
 * only the CLI's own tasks (`providers/background-probes.ts`), and a command
 * is not the CLI's: it lives in the process registry (`routes/processes.ts`),
 * a child of the server.
 *
 * Every running command of the session is listed, with a wake owed or not, as
 * Claude Code lists every running background shell, a dev server included:
 * what the line says is what is running, and it goes when the process exits.
 * A command re-adopted after a restart is a running row again, so it keeps its
 * place; one found dead is closed at boot and never listed.
 *
 * Pure over the registry's rows, which the registry hands in.
 */
import type { AppContext } from "../types";
import type { CommandWork } from "../providers/background-probes";
import type { BackgroundTaskSummary, ListenAddress } from "../../shared/background-work";
import { isServiceRow } from "./command-services";

/** The part of a registry row this reads. */
interface CommandRowLike {
  processId: string;
  scriptName: string;
  startedAt: string;
  status: string;
  cmd?: { sessionKey: string; wake: boolean };
}

/**
 * The registry's rows read as the background work of their sessions. A server
 * (`isServiceRow`: no wake, a listening port, `listenOf`) is not work the chat
 * waits for: it is left out here, and the chat shows it as a server (BGVIS-08).
 */
export function commandWorkOver(
  rows: () => Iterable<CommandRowLike>,
  listenOf: (processId: string) => ReadonlyArray<ListenAddress> | undefined = () => undefined,
): CommandWork {
  const running = function* (): Generator<CommandRowLike & { cmd: { sessionKey: string; wake: boolean } }> {
    for (const r of rows()) {
      if (r.cmd && r.status === "running" && !isServiceRow(r, listenOf(r.processId))) yield r as CommandRowLike & { cmd: { sessionKey: string; wake: boolean } };
    }
  };
  return {
    sessions: () => [...new Set([...running()].map((r) => r.cmd.sessionKey))],
    tasks(sessionKey) {
      const out: BackgroundTaskSummary[] = [];
      for (const r of running()) {
        if (r.cmd.sessionKey !== sessionKey) continue;
        const startedAt = Date.parse(r.startedAt);
        out.push({
          type: "command", description: r.scriptName, processId: r.processId, wakes: r.cmd.wake,
          ...(Number.isFinite(startedAt) ? { startedAt } : {}),
        });
      }
      return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    },
  };
}

/**
 * A command started or ended: every window reads the chat's background line
 * again now, not at its next 15 s status poll. The same push the CLI's own
 * tasks send (`observeBackgroundChanged` in `server.ts`). A command with no
 * topic (a terminal's session) has no chat to tell.
 */
export function pushBackgroundChanged(ctx: Pick<AppContext, "broadcastToAll">, cmd: { topicId: string | null; sessionKey: string }): void {
  if (cmd.topicId) ctx.broadcastToAll({ type: "background:changed", topicId: cmd.topicId, sessionKey: cmd.sessionKey });
}

/**
 * The name of a `run_command` process in the panel, the chat's background line
 * and its wake: the description the agent gave, else the command's first line,
 * cut as the panel cuts a shell's (48 characters). A loop written over several
 * lines read as one run of text cut in the middle of its body; its first line
 * is what the agent wrote first.
 */
export function commandLabel(command: string, description?: unknown): string {
  // A backtick would end the code span the wake writes the name in (`processExitText`).
  const given = typeof description === "string" ? description.replace(/`/g, "'").replace(/\s+/g, " ").trim() : "";
  if (given) return given.length > 80 ? `${given.slice(0, 79)}…` : given;
  const first = (command.split("\n").find((l) => l.trim()) ?? command).replace(/\s+/g, " ").trim();
  return first.length > 48 ? `${first.slice(0, 47)}…` : first || "shell";
}
