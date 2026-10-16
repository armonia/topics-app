/**
 * @covers TERM-WARM-02
 *
 * AN UNANSWERED REPLAY IS NOT AN EMPTY ONE.
 *
 * On attach the server asks the PTY bridge for the session's scrollback and
 * forwards it, then `replay-end`. The client reads a claude pane whose replay
 * carried zero bytes as a PTY that is gone, and covers it with «Sessione
 * terminata» and a Resume button. That inference holds only when the bridge
 * really answered "nothing": a live claude TUI always has a drawn screen to
 * replay.
 *
 * The incident, 2026-10-15: with load1 at 150-177 the server's event loop
 * stopped for 1.3-1.7 s several times (`[LAG]` lines), the one-second wait for
 * the bridge expired, and the server sent an empty replay as if the bridge had
 * said so. A claude session idle on a question emits nothing on its own, so its
 * pane stayed under the veil while the process was alive and waiting, and
 * Resume would have started a second claude on the same conversation.
 *
 * The bar: with the bridge silent, or not connected at all, the attach SHALL
 * end with the retryable close and SHALL NOT send `replay-end`; with the bridge
 * answering empty, `replay-end` SHALL still go out, because that is the real
 * "the PTY is gone" the veil exists for.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { TERMINAL_WS_CLOSE_REPLAY_UNANSWERED } from "../../shared/terminal-messages";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-replay-unanswered");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;

/** How the fake bridge treats a `buffer` request. */
let bufferMode: "silent" | "empty" = "empty";

interface FakeBridge {
  received: { type?: string; id?: string }[];
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  const sockets = new Set<net.Socket>();
  let nextPid = 5200;
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
      if (msg.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      else if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
      else if (msg.type === "create") socket.write(JSON.stringify({ type: "created", id: msg.id, pid: nextPid++ }) + "\n");
      else if (msg.type === "buffer" && bufferMode === "empty") socket.write(JSON.stringify({ type: "buffer", id: msg.id, data: "" }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

/** The client end of the WS, as `handleTerminalWebSocket` sees it. */
function fakeClientSocket() {
  const frames: string[] = [];
  const socket = {
    data: { remote: false },
    frames,
    closed: null as { code: number; reason: string } | null,
    send(payload: unknown) {
      if (typeof payload === "string") frames.push(payload);
    },
    close(code: number, reason: string) { socket.closed = { code, reason }; },
    sawReplayEnd() {
      return frames.some((f) => { try { return (JSON.parse(f) as { type?: string }).type === "replay-end"; } catch { return false; } });
    },
  };
  return socket;
}

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 20));
}

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

async function createShell(): Promise<string> {
  const url = new URL("http://h/api/terminal/sessions");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: CWD, type: "shell" }),
  });
  const res = await terminalRouter(req, url, url.pathname, "POST");
  if (!res) throw new Error("no route for POST /api/terminal/sessions");
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  fs.mkdirSync(CWD, { recursive: true });
  // This test's bridge is ITS OWN, never the real server's: the path freezes at
  // the module's first import, which under `bun test` may have happened in
  // another file, so the explicit seam is used.
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  bridge = await startFakeBridge();

  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, disconnectBridge } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  await until(() => bridge.received.some((m) => m.type === "list"), 5000);
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("the scrollback the bridge did not hand over", () => {
  test("a bridge that does not answer ends the attach as retryable, with no replay-end", async () => {
    const id = await createShell();
    const { handleTerminalWebSocket } = await import("../../server/routes/terminal");
    bufferMode = "silent";
    const ws = fakeClientSocket();
    expect(handleTerminalWebSocket(ws, id), "the session has to be attachable, or the test proves nothing").toBeTruthy();

    await until(() => ws.closed !== null || ws.sawReplayEnd(), 4000);

    expect(bridge.received.some((m) => m.type === "buffer" && m.id === id), "the scrollback was asked for").toBe(true);
    expect(ws.sawReplayEnd(), "an empty replay was sent for a buffer nobody handed over: the pane reads it as a dead PTY").toBe(false);
    expect(ws.closed?.code).toBe(TERMINAL_WS_CLOSE_REPLAY_UNANSWERED);
  }, 20_000);

  test("a bridge that answers empty still gets its replay-end", async () => {
    const id = await createShell();
    const { handleTerminalWebSocket } = await import("../../server/routes/terminal");
    bufferMode = "empty";
    const ws = fakeClientSocket();
    handleTerminalWebSocket(ws, id);

    await until(() => ws.closed !== null || ws.sawReplayEnd(), 4000);

    expect(ws.sawReplayEnd(), "a real empty answer is the dead-PTY signal the resume veil is built on").toBe(true);
    expect(ws.closed).toBeNull();
  }, 20_000);

  test("with the bridge not connected the attach is retryable at once, with no replay-end", async () => {
    const id = await createShell();
    const { handleTerminalWebSocket, disconnectBridge } = await import("../../server/routes/terminal");
    bufferMode = "empty";
    disconnectBridge();
    const ws = fakeClientSocket();
    handleTerminalWebSocket(ws, id);

    await until(() => ws.closed !== null || ws.sawReplayEnd(), 2000);

    expect(ws.sawReplayEnd(), "with no bridge there is no scrollback to call empty").toBe(false);
    expect(ws.closed?.code).toBe(TERMINAL_WS_CLOSE_REPLAY_UNANSWERED);
  }, 20_000);
});
