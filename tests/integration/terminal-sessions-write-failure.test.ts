/**
 * @covers TERM-01
 *
 * A failed write to `terminal_sessions` is reported, and the route still
 * answers the way it did.
 *
 * Eight writes to that table sat inside a bare `catch {}`: a locked or full
 * database left a renamed tab with its old name after a restart, a closed tab
 * resurrected, a revived shell still `dormant` in the DB, and nothing in the
 * log said so. Each one now reports through `warnThrottled` with what failed;
 * the control flow is unchanged (the write is still best effort).
 *
 * The failure is real: SQLite triggers abort every UPDATE and DELETE on the
 * table. The bridge is a fake unix socket speaking the real protocol, as in
 * `terminal-revive-race.test.ts`; everything else is production code.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-write-failure");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;

let bridgeServer: net.Server;
const bridgeSockets = new Set<net.Socket>();
let sawList = false;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
let warn: ReturnType<typeof spyOn<Console, "warn">>;

function startFakeBridge(): Promise<void> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  let nextPid = 5000;
  bridgeServer = net.createServer((socket) => {
    bridgeSockets.add(socket);
    socket.on("close", () => bridgeSockets.delete(socket));
    socket.on("error", () => { /* the server closes when it likes */ });
    createInterface({ input: socket }).on("line", (line) => {
      let msg: { type?: string; id?: string };
      try { msg = JSON.parse(line); } catch { return; }
      const reply = (m: object) => { try { socket.write(JSON.stringify(m) + "\n"); } catch { /* closed */ } };
      if (msg.type === "list") { sawList = true; reply({ type: "list", sessions: [] }); }
      else if (msg.type === "ping") reply({ type: "pong" });
      else if (msg.type === "create") reply({ type: "created", id: msg.id, pid: nextPid++ });
    });
  });
  return new Promise((resolve) => bridgeServer.listen(SOCKET_PATH, () => resolve()));
}

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await terminalRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}

function seedDormant(id: string): void {
  ctx.db.run(
    `INSERT INTO terminal_sessions (id, name, cwd, command, type, cols, rows, skip_permissions, created_at, status)
     VALUES (?, ?, ?, ?, 'shell', 120, 30, 1, ?, 'dormant')`,
    [id, id, CWD, "/bin/sh", new Date().toISOString()],
  );
}

/** The warnings about `terminal_sessions` printed since `from`. */
function tableWarnings(from: number): string[] {
  return warn.mock.calls.slice(from).map((args) => String(args[0])).filter((m) => m.includes("terminal_sessions"));
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  fs.mkdirSync(CWD, { recursive: true });
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  await startFakeBridge();
  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, disconnectBridge } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !sawList) await new Promise((r) => setTimeout(r, 50));
  // The reconcile flips `rosterReconciled` right after the `list` answer.
  await new Promise((r) => setTimeout(r, 100));
  warn = spyOn(console, "warn");
}, 30_000);

afterAll(async () => {
  warn?.mockRestore();
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  for (const s of bridgeSockets) s.destroy();
  await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("a terminal_sessions write that fails is reported, and the route answers as before", () => {
  test("revive, park, rename, list sweep and close each name what failed", async () => {
    const id = "term-write-fail-1";
    seedDormant(id);
    // A dormant shell older than the 1h sweep, so the list route's DELETE runs.
    ctx.db.run(
      `INSERT INTO terminal_sessions (id, name, cwd, command, type, cols, rows, skip_permissions, created_at, status)
       VALUES ('term-write-fail-old', 'old', ?, '/bin/sh', 'shell', 120, 30, 1, datetime('now', '-2 hours'), 'dormant')`,
      [CWD],
    );
    ctx.db.run("CREATE TRIGGER fail_update BEFORE UPDATE ON terminal_sessions BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
    ctx.db.run("CREATE TRIGGER fail_delete BEFORE DELETE ON terminal_sessions BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
    const { parkTerminalSession } = await import("../../server/routes/terminal");

    let from = warn.mock.calls.length;
    const revived = await call(`/api/terminal/sessions/${id}/revive`, "POST");
    expect(revived.status).toBe(200);
    expect(tableWarnings(from)).toEqual([expect.stringContaining(`revived ${id}`)]);

    from = warn.mock.calls.length;
    expect(parkTerminalSession(id)).toBe(true);
    expect(tableWarnings(from)).toEqual([expect.stringContaining(`parked ${id}`)]);

    from = warn.mock.calls.length;
    const renamed = await call(`/api/terminal/sessions/${id}`, "PATCH", { name: "kept in memory" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ ok: true, id, name: "kept in memory" });
    expect(tableWarnings(from)).toEqual([expect.stringContaining(`new name of ${id}`)]);

    from = warn.mock.calls.length;
    const listed = await call("/api/terminal/sessions", "GET");
    expect(listed.status).toBe(200);
    expect(tableWarnings(from)).toEqual([expect.stringContaining("sweeping dormant shells")]);

    from = warn.mock.calls.length;
    const closed = await call(`/api/terminal/sessions/${id}`, "DELETE");
    expect(closed.status).toBe(200);
    expect(tableWarnings(from)).toEqual([expect.stringContaining(`retired ${id}`)]);

    // The failures were real: the row is still there, as the revive's INSERT
    // left it, neither parked, nor renamed, nor deleted.
    const row = ctx.db.query("SELECT name, status FROM terminal_sessions WHERE id = ?").get(id) as { name: string; status: string } | null;
    expect(row?.status).toBe("active");
    expect(row?.name).not.toBe("kept in memory");
    ctx.db.run("DROP TRIGGER fail_update");
    ctx.db.run("DROP TRIGGER fail_delete");
  }, 20_000);
});
