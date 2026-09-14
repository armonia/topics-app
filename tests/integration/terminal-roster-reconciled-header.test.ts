/**
 * @covers TERM-01
 *
 * AN EMPTY ROSTER HAS TO SAY WHICH KIND OF EMPTY IT IS.
 *
 * `GET /api/terminal/sessions` answers `200 []` in two situations that mean
 * opposite things: there really is no terminal session, or the reconcile
 * against the PTY bridge has not finished yet. That reconcile is
 * fire-and-forget and the HTTP layer does not wait for it, so a client cannot
 * tell the two apart and refuses to believe any empty list. A pane whose
 * session no longer exists therefore never declares itself expired, and
 * reattaches every 3 s for as long as the tab is open.
 *
 * The bit already existed server-side (`rosterReconciled`) but left the process
 * only as a field of the `terminal:sessions` broadcast. This is the REST door
 * for it: a HEADER, because the body is a bare array that MCP, the phone and
 * the tests read exactly as it is.
 *
 * THE BAR: with a fake bridge that answers `list` and no session created, the
 * GET must carry the header AND the body must still be a bare `[]`.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { TIME_SLACK_ENV, parseForcedSlack } from "../../shared/test-time-slack";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { ROSTER_RECONCILED_HEADER } from "../../shared/terminal-messages";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-roster-reconciled");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;

interface FakeBridge {
  received: { type?: string; id?: string }[];
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  const sockets = new Set<net.Socket>();
  const bridge: FakeBridge = {
    received: [],
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the server closes when it wants to */ });
    const rl = createInterface({ input: socket });
    rl.on("error", () => { /* same error, already absorbed on the socket */ });
    rl.on("line", (line) => {
      let msg: { type?: string; id?: string };
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      // The answer that matters: a REAL empty list, which is what promotes
      // `rosterReconciled`. A timeout would leave it false, on purpose.
      if (msg.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      else if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

async function get(path: string): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, { method: "GET" });
  const res = await terminalRouter(req, url, url.pathname, "GET");
  if (!res) throw new Error(`no route for GET ${path}`);
  return res;
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  bridge = await startFakeBridge();

  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, disconnectBridge } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  // The bridge handshake is a socket connect plus a round trip: 5 s is plenty
  // on a quiet machine and not always enough under a loaded fleet, where this
  // setup timing out left the header at 0 and the test red for no fault of
  // its own (card 289391a3). Scaled by the slack the runner hands down.
  //
  // WAITING FOR THE `list` TO ARRIVE IS NOT THE SAME AS WAITING FOR THE ROSTER
  // TO BE PROMOTED, and the difference is what went red again under a full
  // shard. `reconcileSessions` receives the answer and then still has work to
  // do before it sets the bit, so a setup that stops at the socket message
  // hands the first test a roster that is a few ticks away from ready. It also
  // misses the other way the bit can arrive: a bridge too slow to answer is
  // retried eight times and then the roster is restored from the DB, which
  // promotes just the same, later than any fixed deadline. So the wait below
  // asks the QUESTION THE TEST IS ABOUT, through the same door the test uses,
  // and it stops as soon as the answer is yes.
  await waitForReconciledRoster();
}, 90_000);

/**
 * Poll the real route until the roster says it has been reconciled.
 *
 * Silence is not an option here: if the budget runs out, the tests below would
 * all report the same missing header and blame the header, so this throws
 * while the cause is still in view.
 */
async function waitForReconciledRoster(): Promise<void> {
  const budgetMs = 30_000 * (parseForcedSlack(process.env[TIME_SLACK_ENV]) ?? 1);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const res = await get("/api/terminal/sessions");
    if (res.headers.get(ROSTER_RECONCILED_HEADER) === "1") return;
    if (Date.now() >= deadline) {
      const sawList = bridge.received.some((m) => m.type === "list");
      throw new Error(
        `the roster was never reconciled within ${Math.round(budgetMs)}ms `
        + `(the fake bridge ${sawList ? "did" : "did NOT"} receive a list request)`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("the REST roster says whether it has been reconciled", () => {
  test("the bridge answered, so the header vouches for the empty list", async () => {
    const res = await get("/api/terminal/sessions");
    expect(res.status).toBe(200);
    expect(res.headers.get(ROSTER_RECONCILED_HEADER)).toBe("1");
  });

  test("the body is still a bare array: nothing wrapped it to carry the bit", async () => {
    const res = await get("/api/terminal/sessions");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
