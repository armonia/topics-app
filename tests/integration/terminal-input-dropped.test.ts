/**
 * @covers TERM-SAY-02
 *
 * A KEYSTROKE THAT GOES NOWHERE HAS TO SAY SO.
 *
 * With the PTY bridge down, `sendToBridge` throws and the server catches it in
 * `noteDroppedInput`: the key is discarded on purpose (replaying it into a PTY
 * that came back as a different, `--resume`d process is worse than losing it)
 * and the fact is written to the SERVER log. Measured on 2026-08-21: 432
 * `Bridge not connected` lines, about 51 of them on this path.
 *
 * On the other end there was nothing. The WebSocket stays open, xterm does no
 * local echo and none of the pane's overlays watches the bridge, so typing into
 * a dead terminal looked exactly like typing into a live one.
 *
 * THE BAR, and it is not a unit test's to check: the fake bridge is torn down
 * with the session already created and attached, one byte goes in, and a
 * control frame has to reach the client. The wall clock is capped well under
 * the reconnect backoff, so passing by waiting is not an option.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { TERMINAL_INPUT_DROPPED } from "../../shared/terminal-messages";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-input-dropped");
const TEST_DATA = `${TEST_ROOT}/data`;
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;

interface FakeBridge {
  received: { type?: string; id?: string }[];
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  const sockets = new Set<net.Socket>();
  let nextPid = 5100;
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
    rl.on("line", (line) => {
      let msg: { type?: string; id?: string };
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      if (msg.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      else if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
      else if (msg.type === "create") socket.write(JSON.stringify({ type: "created", id: msg.id, pid: nextPid++ }) + "\n");
      else if (msg.type === "buffer") socket.write(JSON.stringify({ type: "buffer", id: msg.id, data: "" }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

/** The client end of the WS, as `handleTerminalWebSocket` sees it. */
function fakeClientSocket() {
  const frames: string[] = [];
  return {
    data: { remote: false },
    frames,
    send(payload: unknown) {
      if (typeof payload === "string") frames.push(payload);
    },
    close() { /* the test never closes from the server side */ },
  };
}

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !bridge.received.some((m) => m.type === "list")) {
    await new Promise((r) => setTimeout(r, 50));
  }
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("the bridge is down and someone is typing", () => {
  test("one dropped byte, one control frame at the client, well inside 500 ms", async () => {
    const created = await call("/api/terminal/sessions", "POST", { cwd: CWD, type: "shell" });
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };

    const { handleTerminalWebSocket, disconnectBridge } = await import("../../server/routes/terminal");
    const ws = fakeClientSocket();
    const handlers = handleTerminalWebSocket(ws, id);
    expect(handlers, "the session has to be attachable, or the test proves nothing").toBeTruthy();

    // The bridge goes away UNDER an attached session: exactly the shape of the
    // reconnect window in which the 432 lines were written.
    disconnectBridge();
    ws.frames.length = 0;

    const started = Date.now();
    handlers!.message("q");

    const deadline = started + 500;
    while (Date.now() < deadline && !ws.frames.some((f) => f.includes(TERMINAL_INPUT_DROPPED))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const said = ws.frames.map((f) => { try { return JSON.parse(f) as { type?: string }; } catch { return {}; } });

    expect(
      said.some((f) => f.type === TERMINAL_INPUT_DROPPED),
      "the byte was dropped and the client was not told: the cursor keeps blinking on a dead terminal",
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  }, 20_000);

  test("with the bridge up the same byte produces no frame at all", async () => {
    // The band must not be able to appear on a healthy terminal: what proves it
    // is the same gesture with the bridge answering, which writes nothing back.
    const { _setPtyBridgeSocketPath, ensureBridge, handleTerminalWebSocket } = await import("../../server/routes/terminal");
    _setPtyBridgeSocketPath(SOCKET_PATH);
    await ensureBridge();

    const created = await call("/api/terminal/sessions", "POST", { cwd: CWD, type: "shell" });
    const { id } = await created.json() as { id: string };
    const ws = fakeClientSocket();
    const handlers = handleTerminalWebSocket(ws, id);
    ws.frames.length = 0;

    handlers!.message("q");
    await new Promise((r) => setTimeout(r, 200));

    expect(ws.frames.some((f) => f.includes(TERMINAL_INPUT_DROPPED))).toBe(false);
    expect(bridge.received.some((m) => m.type === "write" && m.id === id)).toBe(true);
  }, 20_000);
});
