#!/usr/bin/env bun
/**
 * ONE LIFE OF THE SERVER for `server/routes/command-runs.test.ts`: the real
 * database and the real process registry on the state folder `DATA_DIR`
 * names. A reload is a process that dies and another that loads the same
 * folder: the registry is module state and its boot is its import.
 *
 *   start <messageId> <command>
 *     writes a finished reply with that id, runs the command from it through
 *     the route and dies at once, printing `{runId, pid}`: the server going
 *     away under a running command.
 *   boot <messageId> <runId>
 *     boots (database, then registry, then router), waits for the run's row to
 *     close and prints `{run}`.
 */
import { join } from "path";

const [mode, messageId, arg] = process.argv.slice(2);
const SESSION = "topic:life";

const { initDatabase } = await import("../../../server/db");
const db = initDatabase(join(import.meta.dir, "..", "..", ".."));
const { createProcessesRouter } = await import("../../../server/routes/processes");

const router = createProcessesRouter({
  db,
  json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
  broadcastToAll: () => {},
  getTopicBySessionKey: () => null,
} as never);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await router(req, url, url.pathname, method))!;
}
const runsPath = `/api/sessions/${encodeURIComponent(SESSION)}/command-runs`;

if (mode === "start") {
  db.run("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, ?, 'assistant', 'x', ?, 0)", [messageId!, SESSION, new Date().toISOString()]);
  const { runId } = await (await call("POST", runsPath, { messageId, blockKey: 0, command: arg })).json() as { runId: string };
  const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Array<{ processId: string; pid: number }> };
  process.stdout.write(`${JSON.stringify({ runId, pid: scripts.find((s) => s.processId === runId)?.pid })}\n`);
  process.exit(0);
}

if (mode === "boot") {
  type Run = { runId: string; status: string };
  const end = Date.now() + 20_000;
  let run: Run | undefined;
  for (;;) {
    const { runs } = await (await call("GET", `${runsPath}?messageId=${encodeURIComponent(messageId!)}`)).json() as { runs: Run[] };
    run = runs.find((r) => r.runId === arg);
    if ((run && run.status !== "running") || Date.now() > end) break;
    await Bun.sleep(100);
  }
  process.stdout.write(`${JSON.stringify({ run })}\n`);
  process.exit(0);
}
