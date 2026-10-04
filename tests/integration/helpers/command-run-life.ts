#!/usr/bin/env bun
/**
 * ONE LIFE OF THE SERVER for `server/routes/command-runs.test.ts`: the real
 * database and the real process registry on the state folder `DATA_DIR`
 * names. A reload is a process that dies and another that loads the same
 * folder: the registry is module state, loaded once per process.
 *
 *   start <messageId>[,<messageId>...] <command>
 *     writes a finished reply with each id, runs the command from each through
 *     the route and dies at once, printing `{runId, pid}` of the first and
 *     `runs` with every one: the server going away under running commands.
 *   boot <messageId>[,<messageId>...] <runId>[,<runId>...]
 *     boots (database, then registry, then router), waits for the rows of the
 *     runs to close and prints `{run}` with the first, `runs` with every one
 *     and `atBoot` with each row as the boot left it, before any request.
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
  const runIds: string[] = [];
  for (const id of messageId!.split(",")) {
    db.run("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, ?, 'assistant', 'x', ?, 0)", [id, SESSION, new Date().toISOString()]);
    runIds.push(((await (await call("POST", runsPath, { messageId: id, blockKey: 0, command: arg })).json()) as { runId: string }).runId);
  }
  const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Array<{ processId: string; pid: number }> };
  const runs = runIds.map((runId) => ({ runId, pid: scripts.find((s) => s.processId === runId)?.pid }));
  process.stdout.write(`${JSON.stringify({ ...runs[0], runs })}\n`);
  process.exit(0);
}

if (mode === "boot") {
  type Run = { runId: string; status: string };
  const runIds = arg!.split(",");
  // Read from the database itself: a request would close a row the boot left running.
  const atBoot = runIds.map((id) => db.query("SELECT status, exit_code AS exitCode FROM command_runs WHERE id = ?").get(id));
  const end = Date.now() + 20_000;
  let runs: Array<Run | undefined> = [];
  for (;;) {
    runs = [];
    for (const [k, id] of messageId!.split(",").entries()) {
      const { runs: rows } = await (await call("GET", `${runsPath}?messageId=${encodeURIComponent(id)}`)).json() as { runs: Run[] };
      runs.push(rows.find((r) => r.runId === runIds[k]));
    }
    if (runs.every((run) => run && run.status !== "running") || Date.now() > end) break;
    await Bun.sleep(100);
  }
  process.stdout.write(`${JSON.stringify({ run: runs[0], runs, atBoot })}\n`);
  process.exit(0);
}
