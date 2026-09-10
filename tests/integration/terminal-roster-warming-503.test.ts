/**
 * A 404 IS A VERDICT. THE BOOT WINDOW HAS NO RIGHT TO ONE.
 *
 * Five terminal routes decide whether a session exists by looking at the
 * in-memory `sessions` map: send, resize, DELETE, PATCH rename, reload. That
 * map is EMPTY until `reconcileSessions` has asked the PTY bridge which PTYs
 * survived, and the HTTP layer does not wait for it — `createTerminalRouter`
 * fires the reconcile and returns. When the bridge is slow to answer, the
 * window is up to ~24s wide (a `list` that times out at 2s retries 8 times with
 * a 1s pause), and every client reconnect that lands in it was told "Terminal
 * session not found" about a terminal that was alive.
 *
 * Measured on the production error log
 * (`~/.claude/jarvis/logs/topics-server-error.log`, 2026-09-10): that single
 * warning is 33.246 of the last 60.000 lines — 55% — in bursts, the largest
 * 8.222 consecutive identical lines.
 *
 * THE BAR, and it is two-sided on purpose: while the reconcile is unfinished
 * the five routes must answer 503 with `Retry-After` (ask again), and once it
 * has finished the very same request for an id nobody has ever created must go
 * back to answering 404 (it is gone, prune it). A fix that only proved the
 * first half would be indistinguishable from deleting the 404.
 *
 * HOW THE WINDOW IS HELD OPEN. The fake bridge below simply does not reply to
 * `list` at first. That is the real mechanism, not a stub of it: the router's
 * own retry ladder keeps `rosterReconciled` false. Flipping `answersList` then
 * lets the NEXT attempt through, so the second half of the bar runs against a
 * roster the production code path promoted, not one a test poked.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { TERMINAL_ROSTER_WARMING_CODE } from "../../shared/terminal-messages";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-roster-warming");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;

// An id nobody ever created. It is the SAME id in both halves of the bar, so
// the only thing that changes between the 503 and the 404 is whether the
// reconcile has finished.
const UNKNOWN_ID = "11111111-2222-3333-4444-555555555555";

interface FakeBridge {
  /** Flip to true and the next `list` gets an answer — the reconcile completes. */
  answersList: boolean;
  sawList: number;
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  const sockets = new Set<net.Socket>();
  const bridge: FakeBridge = {
    answersList: false,
    sawList: 0,
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
      let msg: { type?: string };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "ping") { socket.write(JSON.stringify({ type: "pong" }) + "\n"); return; }
      if (msg.type !== "list") return;
      bridge.sawList++;
      // Silence IS the test fixture: an unanswered `list` is exactly what keeps
      // the roster unreconciled in production while a slow bridge comes up.
      if (bridge.answersList) socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

/** `/send` is token-gated (it is raw stdin into a `--dangerously-skip-permissions`
 *  PTY). The test presents the gateway token so the request reaches the routing
 *  decision under test instead of stopping at the credential check. */
const GATEWAY_TOKEN = "warming-test-gateway-token";

async function call(method: string, path: string, body?: unknown, authed = false): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authed) headers["x-gateway-token"] = GATEWAY_TOKEN;
  const req = new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await terminalRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}

/** The five roster-dependent routes, each as one callable request. */
const ROSTER_ROUTES: { name: string; run: () => Promise<Response> }[] = [
  { name: "POST send", run: () => call("POST", `/api/terminal/sessions/${UNKNOWN_ID}/send`, { input: "x" }, true) },
  { name: "POST resize", run: () => call("POST", `/api/terminal/sessions/${UNKNOWN_ID}/resize`, { cols: 80, rows: 24 }) },
  { name: "DELETE session", run: () => call("DELETE", `/api/terminal/sessions/${UNKNOWN_ID}`) },
  { name: "PATCH rename", run: () => call("PATCH", `/api/terminal/sessions/${UNKNOWN_ID}`, { name: "nuovo" }) },
  { name: "POST reload", run: () => call("POST", `/api/terminal/sessions/${UNKNOWN_ID}/reload`) },
];

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = GATEWAY_TOKEN;
  bridge = await startFakeBridge();

  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, _resetRosterReconciled, disconnectBridge } =
    await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  // Under `bun test` this module is shared with every other file in the run,
  // and another one of them may already have let a reconcile finish. Without
  // this the whole first half of the bar would assert the OLD behaviour and
  // pass — see `_resetRosterReconciled`. It is set before the router is built,
  // because building it is what starts the reconcile that promotes it back.
  _resetRosterReconciled();
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  // Wait for the bridge to have HEARD the first `list` — from here the router
  // is inside the window, and stays there because nobody answers.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && bridge.sawList === 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(bridge.sawList).toBeGreaterThan(0);
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("reconcile unfinished: the five routes ask for a retry, they do not pass a verdict", () => {
  for (const route of ROSTER_ROUTES) {
    test(`${route.name} answers 503, not 404`, async () => {
      const res = await route.run();
      expect(res.status).toBe(503);
    });
  }

  test("the 503 carries Retry-After, so the caller knows it is worth asking again", async () => {
    const res = await ROSTER_ROUTES[1].run();
    const after = Number(res.headers.get("Retry-After"));
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(0);
  });

  test("the body names WHICH 503 this is: these routes already answer two others", async () => {
    const res = await ROSTER_ROUTES[1].run();
    const body = await res.json() as { code?: string };
    expect(body.code).toBe(TERMINAL_ROSTER_WARMING_CODE);
  });

  test("an UNAUTHORIZED /send is deferred too, and that is a refusal either way", async () => {
    // Worth pinning rather than hiding: for the width of the window the gate
    // answers before `/send`'s token check, so a caller with no credential gets
    // 503 instead of 401. It is the same trade the standalone gate above the
    // guard already makes, and it costs nothing that matters — the gate never
    // ADMITS a request, it only postpones one. What leaks is "this server
    // restarted a moment ago", which the standalone 503 tells anyone anyway.
    const res = await call("POST", `/api/terminal/sessions/${UNKNOWN_ID}/send`, { input: "x" });
    expect(res.status).toBe(503);
  });

  test("GET /sessions is untouched by the gate: an empty roster is still a 200", async () => {
    // The gate must not spread to the read. The roster read has its OWN way of
    // saying "I asked too early" (the X-Roster-Reconciled header), and a 503
    // there would break every client that lists sessions during boot.
    const res = await call("GET", "/api/terminal/sessions");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("reconcile finished: a session nobody created is gone, and says so", () => {
  test("the same five requests go back to 404 once the bridge has answered", async () => {
    bridge.answersList = true;
    // The router's own ladder retries `list` about once a second; the promotion
    // is what we wait for, not a fixed sleep.
    const deadline = Date.now() + 20_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await ROSTER_ROUTES[1].run()).status;
      if (status !== 503) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(404);

    // And the credential gate is BACK in charge of `/send` the moment the
    // window closes: no token, no 404 — 401, exactly as before this change.
    const noToken = await call("POST", `/api/terminal/sessions/${UNKNOWN_ID}/send`, { input: "x" });
    expect(noToken.status).toBe(401);

    for (const route of ROSTER_ROUTES) {
      const res = await route.run();
      expect(`${route.name}: ${res.status}`).toBe(`${route.name}: 404`);
    }
  }, 30_000);
});
