/**
 * POST and GET `/api/sessions/:sessionKey/command-runs`: Run under a code block
 * of a reply (CMDRUN-05, CMDRUN-06).
 *
 * A PERSON runs a command the agent wrote. No new power: an owner already has
 * a shell (the terminal) and the agent already has `run_command` on the same
 * road; this is that road with another origin. What it adds are the
 * conditions under which the chat offers it, checked again here: a reply of
 * the agent of THIS session, finished (a fence still streaming is drawn
 * closed, and `rm -rf ./build/cache` cut at `rm -rf ./` would run). The
 * command runs where the agent's Bash runs, wakes nobody, and its outcome is
 * kept in `command_runs`. Guests never reach it: the path is outside their
 * allowlist (`lib/grants.ts`), and the role is checked again here.
 *
 * The process itself belongs to the registry (`routes/processes.ts`), which
 * hands in the three gestures this needs.
 */
import type { AppContext } from "../types";
import { hasCommandShell } from "../lib/command-process";
import { agentWorkspaceForSession } from "../lib/agent-workspace";
import { closeRun, insertRun, latestRuns } from "../lib/command-runs";

export interface CommandRunRegistry {
  /** Start `command` as a person's run; null when there is no POSIX shell. */
  start(o: { cwd: string; command: string; sessionKey: string; topicId: string | null }): { processId: string; startedAt: string } | null;
  /** Where the registry stands with a run: still running, ended (its row is closed now), or no longer known. */
  reconcile(runId: string): "running" | "ended" | "gone";
  /** Stop a run the registry has. */
  kill(runId: string): void;
}

const NO_SHELL = { error: "Running a command needs a POSIX shell, and this system has none", code: "no_shell" };

export function createCommandRunsRoute(ctx: AppContext, registry: CommandRunRegistry) {
  const { json } = ctx;
  return async function commandRunsRoute(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    const m = (method === "POST" || method === "GET") && pathname.match(/^\/api\/sessions\/([^/]+)\/command-runs$/);
    if (!m) return null;
    if (ctx.requestIdentity?.(req)?.role === "guest") return json({ error: "guest_forbidden", code: "guest_forbidden" }, 403);
    const sessionKey = decodeURIComponent(m[1]!);

    if (method === "GET") {
      const messageId = url.searchParams.get("messageId") ?? "";
      if (!messageId) return json({ error: "messageId is required" }, 400);
      // A run still `running` whose process the registry no longer has (killed
      // with the server, never re-adopted): unknown, not running forever.
      for (const run of latestRuns(ctx.db, sessionKey, messageId)) {
        if (run.status === "running" && registry.reconcile(run.runId) === "gone") {
          closeRun(ctx.db, run.runId, { status: "unknown", exitCode: null, endedAt: new Date().toISOString(), output: "", droppedLines: 0 });
        }
      }
      return json({ runs: latestRuns(ctx.db, sessionKey, messageId) });
    }

    if (!hasCommandShell()) return json(NO_SHELL, 501);
    let body: { command?: unknown; blockKey?: unknown; messageId?: unknown } | null;
    try { body = await req.json(); } catch { body = null; }
    const command = typeof body?.command === "string" ? body.command : "";
    if (!command.trim()) return json({ error: "command (non-empty string) is required" }, 400);
    const blockKey = body?.blockKey;
    if (typeof blockKey !== "number" || !Number.isSafeInteger(blockKey) || blockKey < 0) return json({ error: "blockKey (non-negative integer) is required" }, 400);
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    const msg = messageId
      ? ctx.db.query("SELECT session_key, role, partial FROM messages WHERE id = ?").get(messageId) as { session_key: string; role: string; partial: number | null } | null
      : null;
    if (!msg || msg.session_key !== sessionKey || msg.role !== "assistant") return json({ error: "No reply of the agent with this id in this session", code: "message_not_found" }, 404);
    if (msg.partial) return json({ error: "The reply is still being written", code: "message_partial" }, 409);

    const cwd = agentWorkspaceForSession(sessionKey);
    try {
      const started = registry.start({ cwd, command, sessionKey, topicId: ctx.getTopicBySessionKey(sessionKey)?.id ?? null });
      if (!started) return json(NO_SHELL, 501);
      // Synchronously after the spawn: the process cannot have closed its row before the row exists.
      try {
        insertRun(ctx.db, {
          id: started.processId, sessionKey, messageId, blockKey, command, cwd, startedAt: started.startedAt,
          authorDeviceId: ctx.requestIdentity?.(req)?.deviceId ?? null,
        });
      } catch (err) {
        // No row, no run: a command nobody can see under its block is not left running.
        registry.kill(started.processId);
        throw err;
      }
      ctx.broadcastToAll({ type: "command-run:updated", sessionKey, messageId, runId: started.processId, status: "running" });
      return json({ runId: started.processId, processId: started.processId, cwd, startedAt: started.startedAt });
    } catch (err) {
      return json({ error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  };
}
