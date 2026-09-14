/**
 * @covers TERM-WARM-01
 *
 * THE WARMING WINDOW HAS TO CLOSE EVEN WHEN THE BRIDGE IS LATE AT BOOT.
 *
 * `createTerminalRouter` connects to the pty bridge and then reconciles. The
 * reconcile is the only thing that promotes the roster, and until it does the
 * warming gate answers 503 to DELETE, resize, send, rename and reload. The
 * reconcile used to hang off the `.then` of the first connect, so a bridge that
 * took longer than the 3s spawn deadline skipped it for good: the bridge came
 * up a moment later, the next POST connected to it and created sessions, and
 * every DELETE on those sessions answered 503 until the process died.
 *
 * Measured in CI, run 34799985301 shard 1 (and the same signature in five more
 * shards, two of them on main): "Bridge init failed" with an empty bridge log at boot,
 * then 9.282 `DELETE /api/terminal/sessions/<id> 503` from the e2e teardown,
 * and every later spec file red at 0 ms.
 *
 * HOW THE LATE BRIDGE IS BUILT. `TOPICS_PTY_BRIDGE_BIN` points at a script that
 * sleeps and never opens the socket: a bridge still booting, which is what the
 * CI runner had. Once the router has given up on it, a fake bridge starts
 * listening on the same socket, the way the real one did a few seconds later.
 * The bar is the same request the warming test uses: an id nobody created must
 * go from 503 to 404, and only a reconcile can make it.
 */
import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-boot-late");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const SLOW_BRIDGE_BIN = `${TEST_ROOT}/slow-bridge.sh`;
const UNKNOWN_ID = "99999999-8888-7777-6666-555555555555";

let server: net.Server | null = null;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
let errorSpy: ReturnType<typeof spyOn> | null = null;
const previousBridgeBin = process.env.TOPICS_PTY_BRIDGE_BIN;

/** A bridge that answers `ping` and `list`: the late bridge, finally up. */
function startLateBridge(): Promise<void> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  const listener = net.createServer((socket) => {
    socket.on("error", () => { /* the router closes when it wants to */ });
    const rl = createInterface({ input: socket });
    rl.on("error", () => { /* same error, already absorbed on the socket */ });
    rl.on("line", (line) => {
      let msg: { type?: string };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
      if (msg.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
    });
  });
  server = listener;
  return new Promise((resolve) => listener.listen(SOCKET_PATH, () => resolve()));
}

async function deleteUnknown(): Promise<number> {
  const url = new URL(`http://h/api/terminal/sessions/${UNKNOWN_ID}`);
  const res = await terminalRouter(new Request(url, { method: "DELETE" }), url, url.pathname, "DELETE");
  if (!res) throw new Error("no route for DELETE");
  return res.status;
}

function bootFailureLogged(): boolean {
  return (errorSpy?.mock.calls ?? []).some((args) => String(args[0]).includes("Bridge init failed"));
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  // Started, silent, no socket: `ensureBridge` waits its whole deadline for it.
  fs.writeFileSync(SLOW_BRIDGE_BIN, "#!/bin/sh\nexec sleep 6\n", { mode: 0o755 });
  process.env.TOPICS_PTY_BRIDGE_BIN = SLOW_BRIDGE_BIN;
  errorSpy = spyOn(console, "error");

  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, _resetRosterReconciled, disconnectBridge } =
    await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  // Every file under `bun test` shares this module: another one may already
  // have promoted the roster, and then this file would assert nothing.
  _resetRosterReconciled();
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  if (previousBridgeBin === undefined) delete process.env.TOPICS_PTY_BRIDGE_BIN;
  else process.env.TOPICS_PTY_BRIDGE_BIN = previousBridgeBin;
  errorSpy?.mockRestore();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("a bridge that misses the boot deadline and comes up afterwards", () => {
  test("the roster still gets reconciled: an unknown id goes from 503 to 404", async () => {
    // The CI precondition, asserted rather than assumed: the first connect
    // really gave up on a bridge that was still booting.
    const bootDeadline = Date.now() + 10_000;
    while (Date.now() < bootDeadline && !bootFailureLogged()) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(bootFailureLogged()).toBe(true);
    expect(await deleteUnknown()).toBe(503);

    await startLateBridge();

    // The reconcile's own ladder (2s per unanswered `list`, then a reconnect)
    // is what has to find the bridge. Waiting on the answer, not on a clock.
    const deadline = Date.now() + 15_000;
    let status = 503;
    while (Date.now() < deadline) {
      status = await deleteUnknown();
      if (status !== 503) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(404);
  }, 40_000);
});
