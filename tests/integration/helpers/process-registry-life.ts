#!/usr/bin/env bun
/**
 * ONE LIFE OF THE SERVER'S PROCESS REGISTRY, as a process of its own, for
 * `process-run-command.test.ts`. A reload of the server is a process that dies
 * and another that loads the same state folder (`DATA_DIR`), and that is what
 * two runs of this script are: the registry is module state and its boot is
 * its import, so no in-process trick would reproduce it.
 *
 *   start <project> <command>
 *     runs the command through the session route and dies at once, printing
 *     `{processId, pid}`: the server going away under a running command.
 *   crowd <project> <command> <n>
 *     runs the command (it owes the topic a wake), waits for it to end, then
 *     runs `n` more that owe nothing and waits for them too, and dies before
 *     any wake goes out: a server that reloads while the topic is busy.
 *     Prints `{processId}` of the first.
 *   load
 *     loads the registry the way a boot does and dies: what the boot itself
 *     wrote to `scripts.json` is what the test reads.
 *   boot <project> <processId> <db>
 *     loads the registry the way a boot does, starts the wakes with a chat
 *     route that writes the row into `<db>` (a sqlite file with `messages`),
 *     waits for that process's row to close and for the wakes to settle, and
 *     prints `{row, log, sent}`.
 */
import { Database } from "bun:sqlite";

const [mode, project, arg, dbPath] = process.argv.slice(2);
const TOPIC = { id: "topic-life", sessionKey: "topic:life" };

const { createProcessesRouter } = await import("../../../server/routes/processes");
const { startProcessExitWakes, processExitWakesIdle } = await import("../../../server/lib/process-exit-wake");

const router = createProcessesRouter({
  db: { query: () => ({ get: () => null }) },
  json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
  broadcastToAll: () => {},
  getTopicBySessionKey: (k: string) => (k === TOPIC.sessionKey ? TOPIC : null),
  resolveTopicCwd: () => project,
} as never);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await router(req, url, url.pathname, method))!;
}

if (mode === "start") {
  const resp = await call("POST", `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/commands/run`, { command: arg });
  process.stdout.write(`${JSON.stringify(await resp.json())}\n`);
  process.exit(0);
}

if (mode === "load") process.exit(0);

async function closed(processId: string): Promise<void> {
  const end = Date.now() + 20_000;
  for (;;) {
    const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Array<{ processId: string; status: string }> };
    const row = scripts.find((s) => s.processId === processId);
    if ((row && row.status !== "running") || Date.now() > end) return;
    await Bun.sleep(50);
  }
}

if (mode === "crowd") {
  const run = async (command: string, wake: boolean) =>
    ((await (await call("POST", `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/commands/run`, { command, wake })).json()) as { processId: string }).processId;
  const owed = await run(arg!, true);
  await closed(owed);
  for (let i = 0; i < Number(dbPath); i++) await closed(await run("true", false));
  process.stdout.write(`${JSON.stringify({ processId: owed })}\n`);
  process.exit(0);
}

if (mode === "boot") {
  const db = new Database(dbPath!);
  let sent = 0;
  startProcessExitWakes({
    db,
    getTopicById: (id) => (id === TOPIC.id ? { sessionKey: TOPIC.sessionKey } : null),
    ownedByRunningTask: () => false,
    isBusy: () => false,
    pollMs: 20,
    route: async (req) => {
      const body = await req.json() as { processExit: { processId: string; exitCode: number | null }; messages: Array<{ content: string }> };
      sent++;
      db.run("INSERT INTO messages (session_key, role, content, blocks) VALUES (?, 'user', ?, ?)", [
        TOPIC.sessionKey, body.messages[0]!.content, JSON.stringify([{ kind: "process-exit", ...body.processExit, label: "x" }]),
      ]);
      return new Response("data: [DONE]\n\n", { status: 200 });
    },
  });
  type Row = { processId: string; status: string };
  const end = Date.now() + 20_000;
  let row: Row | undefined;
  for (;;) {
    const { scripts } = await (await call("GET", "/api/scripts")).json() as { scripts: Row[] };
    row = scripts.find((s) => s.processId === arg);
    if ((row && row.status !== "running") || Date.now() > end) break;
    await Bun.sleep(200);
  }
  await processExitWakesIdle();
  const out = await (await call("GET", `/api/scripts/${arg}/output`)).json() as { output: string; pending?: string };
  process.stdout.write(`${JSON.stringify({ row, log: out.output + (out.pending ?? ""), sent })}\n`);
  process.exit(0);
}
