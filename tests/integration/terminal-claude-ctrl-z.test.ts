/**
 * @covers TERM-14
 *
 * Ctrl+Z never reaches a Claude Code pane; a shell still gets it.
 *
 * On ctrl+z Claude Code tears its UI down and sends itself SIGTSTP. Under Topics
 * it is the PTY's session leader, its process group is orphaned and the kernel
 * discards the signal: the process lives on but never redraws again, and the
 * pane stays frozen at whatever width it had (21/10: PTY at 83 columns, Claude
 * Code stuck at 25). The why lives in `server/lib/terminal-suspend-key.ts`.
 *
 * What this pins is the WIRING: the filter sits in `sendToBridge`, the one
 * place every PTY write goes through, so both the keyboard (WebSocket) and the
 * agents' path (`writeTopicsTerminal`) are covered. The bridge is a fake unix
 * socket speaking the real protocol; the claude binary is `/bin/sh` through
 * `CLAUDE_BIN`, never started.
 *
 * No sleeps for the negative case: a sentinel byte goes out right after the
 * ctrl+z on the same socket, so once it arrives anything sent before it has
 * arrived too.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { getDatabase } from "../../server/db";
import { getSubagent, setSubagentState } from "../../server/lib/subagent-store";
import { transcriptHasPrompt } from "../../server/lib/claude-subagent-transcript";

const TEST_ROOT = testTmpDir("terminal-ctrl-z");
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;
const TOPICS_HOME = join(TEST_ROOT, "topics-home");
const SENTINEL = "\u0007sentinel";

let bridgeServer: net.Server;
const bridgeSockets = new Set<net.Socket>();
const creates: string[] = [];
const writes: Array<{ id: string; data: string }> = [];
const screens = new Map<string, string>();
let sawList = false;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

function startFakeBridge(): Promise<void> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* it was not there */ }
  bridgeServer = net.createServer((socket) => {
    bridgeSockets.add(socket);
    socket.on("close", () => bridgeSockets.delete(socket));
    socket.on("error", () => { /* the server closes when it likes */ });
    const rl = createInterface({ input: socket });
    rl.on("error", () => { /* same error, already absorbed on the socket */ });
    rl.on("line", (line) => {
      let msg: { type?: string; id?: string; data?: string };
      try { msg = JSON.parse(line); } catch { return; }
      const reply = (m: object) => { try { socket.write(JSON.stringify(m) + "\n"); } catch { /* closed */ } };
      if (msg.type === "list") { sawList = true; reply({ type: "list", sessions: [] }); }
      else if (msg.type === "ping") reply({ type: "pong" });
      else if (msg.type === "create") {
        creates.push(msg.id!);
        reply({ type: "created", id: msg.id, pid: 7000 + creates.length });
      }
      else if (msg.type === "buffer") {
        const screen = screens.get(msg.id!) ?? "Welcome to Claude Code\n> ";
        reply({ type: "buffer", id: msg.id, data: Buffer.from(screen, "utf8").toString("base64") });
      }
      else if (msg.type === "write") {
        const data = msg.data ?? "";
        writes.push({ id: msg.id!, data });
        if (data && data !== "\r") screens.set(msg.id!, `Welcome to Claude Code\n> ${data}`);
      }
    });
  });
  return new Promise((resolve) => bridgeServer.listen(SOCKET_PATH, () => resolve()));
}

async function createSession(type: string): Promise<string> {
  const url = new URL("http://h/api/terminal/sessions");
  const res = await terminalRouter(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, cwd: CWD, name: `ctrl-z ${type}` }),
    }),
    url,
    url.pathname,
    "POST",
  );
  expect(res?.status).toBe(200);
  return ((await res!.json()) as { id: string }).id;
}

async function spawnCliChild(parentId: string, prompt: string): Promise<{ agentId: string; response: Response }> {
  const url = new URL(`http://h/api/sessions/${encodeURIComponent(parentId)}/agents/spawn`);
  const response = await terminalRouter(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": process.env.GATEWAY_TOKEN! },
      body: JSON.stringify({ prompt, cwd: CWD, runtime: "claude-code" }),
    }),
    url,
    url.pathname,
    "POST",
  );
  expect(response?.status).toBe(200);
  return { agentId: ((await response!.json()) as { agentId: string }).agentId, response: response! };
}

async function waitForWrite(id: string, predicate: (data: string) => boolean, timeoutMs = 5000, fromIndex = 0): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const found = () => writes.slice(fromIndex).some((write) => write.id === id && predicate(write.data));
  while (Date.now() < deadline && !found()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(found(), "expected bridge write never arrived").toBe(true);
}

async function stopCliChild(parentId: string, agentId: string): Promise<void> {
  // Avoid a detached result read after the test database closes.
  setSubagentState(getDatabase(), agentId, "retired");
  const url = new URL(`http://h/api/sessions/${encodeURIComponent(parentId)}/agents/${encodeURIComponent(agentId)}/stop`);
  await terminalRouter(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": process.env.GATEWAY_TOKEN! },
      body: "{}",
    }),
    url,
    url.pathname,
    "POST",
  );
}

/** What the bridge received for `id` up to the sentinel, once it arrives. */
async function writesUntilSentinel(id: string): Promise<string[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !writes.some((w) => w.id === id && w.data === SENTINEL)) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const mine = writes.filter((w) => w.id === id).map((w) => w.data);
  expect(mine, "the sentinel never reached the bridge: the test proves nothing").toContain(SENTINEL);
  return mine.slice(0, mine.indexOf(SENTINEL));
}

/** The client end of the WS, as `handleTerminalWebSocket` sees it. */
function fakeClientSocket() {
  return { data: { remote: false }, send() { /* frames are not under test */ }, close() { /* never closed here */ } };
}

beforeAll(async () => {
  setupTestDataDir(`${TEST_ROOT}/data`);
  fs.mkdirSync(CWD, { recursive: true });
  setEnv("TOPICS_HOME", TOPICS_HOME);
  setEnv("CLAUDE_BIN", "/bin/sh");
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin");
  _resetClaudeBinCache();
  await startFakeBridge();
  const ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, disconnectBridge } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !sawList) await new Promise((r) => setTimeout(r, 50));
  // The reconcile flips `rosterReconciled` right after the `list` answer.
  await new Promise((r) => setTimeout(r, 100));
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  for (const s of bridgeSockets) s.destroy();
  await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
  const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin");
  _resetClaudeBinCache();
  const { cleanupMcpConfigForSession } = await import("../../server/providers/claude-code");
  for (const id of creates) cleanupMcpConfigForSession(id);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await cleanupTestDataDir(TEST_ROOT);
});

test("typed into a Claude Code pane, ctrl+z never reaches the PTY and the rest of the keystroke does", async () => {
  const id = await createSession("claude-code");
  const { handleTerminalWebSocket } = await import("../../server/routes/terminal");
  const handlers = handleTerminalWebSocket(fakeClientSocket(), id);
  expect(handlers, "the session has to be attachable, or the test proves nothing").toBeTruthy();

  handlers!.message("\x1a");
  handlers!.message("\x1b\x1a");
  handlers!.message("a\x1ab");
  handlers!.message(SENTINEL);

  expect(await writesUntilSentinel(id)).toEqual(["ab"]);
}, 20_000);

test("sent by an agent through the live-terminals path, it is dropped the same way", async () => {
  const id = await createSession("claude-code");
  const { writeTopicsTerminal } = await import("../../server/routes/terminal");

  expect(writeTopicsTerminal(id, "\x1a")).toBe(true);
  writeTopicsTerminal(id, SENTINEL);

  expect(await writesUntilSentinel(id)).toEqual([]);
}, 20_000);

test("the agents' /send takes text only: an array of bytes would carry ctrl+z past the filter", async () => {
  const id = await createSession("claude-code");
  const gateway = crypto.randomUUID();
  setEnv("GATEWAY_TOKEN", gateway);
  const send = async (input: unknown) => {
    const url = new URL(`http://h/api/terminal/sessions/${id}/send`);
    const res = await terminalRouter(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-token": gateway },
        body: JSON.stringify({ input }),
      }),
      url,
      url.pathname,
      "POST",
    );
    return { status: res!.status, body: await res!.json() as Record<string, unknown> };
  };

  // The node bridge hands `data` to node-pty, which writes `Buffer.from([26])`:
  // a raw 0x1A the string filter never saw.
  expect(await send([26])).toMatchObject({ status: 400 });
  expect(await send("\x1a")).toEqual({ status: 200, body: { ok: false, dropped: true, sent: 0 } });
  expect(await send("a\x1ab")).toEqual({ status: 200, body: { ok: true, sent: 2 } });
  expect(await send(SENTINEL)).toEqual({ status: 200, body: { ok: true, sent: SENTINEL.length } });

  expect(await writesUntilSentinel(id)).toEqual(["ab"]);
}, 20_000);

test("seed writes the filtered prompt once and fingerprints the same transcript text", async () => {
  const parentId = await createSession("claude-code");
  setEnv("GATEWAY_TOKEN", crypto.randomUUID());
  const rawPrompt = "do it\x1a now";
  const { agentId } = await spawnCliChild(parentId, rawPrompt);

  try {
    const row = getSubagent(getDatabase(), agentId);
    expect(row?.promptSnippet).toBe("do it now");
    expect(transcriptHasPrompt(
      [JSON.stringify({ type: "user", message: { content: "do it now" } })],
      row?.promptSnippet ?? "",
    )).toBe(true);

    await waitForWrite(agentId, (data) => data.includes("do it now"));
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(writes.filter((write) => write.id === agentId && write.data.includes("do it now"))).toHaveLength(1);
    expect(writes.some((write) => write.id === agentId && write.data.includes("\x1a"))).toBe(false);
  } finally {
    await stopCliChild(parentId, agentId);
  }
}, 20_000);

test("send_to_agent drops an all-filtered prompt and counts the bytes written", async () => {
  const parentId = await createSession("claude-code");
  setEnv("GATEWAY_TOKEN", crypto.randomUUID());
  const { agentId } = await spawnCliChild(parentId, "ready");
  const { writeTopicsTerminal } = await import("../../server/routes/terminal");
  const row = getSubagent(getDatabase(), agentId);
  expect(row?.runtime).toBe("claude-code");

  try {
    await waitForWrite(agentId, (data) => data === "\r");
    const url = new URL(`http://h/api/sessions/${encodeURIComponent(parentId)}/agents/${encodeURIComponent(agentId)}/send`);
    const send = async (input: string) => {
      const response = await terminalRouter(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-token": process.env.GATEWAY_TOKEN! },
          body: JSON.stringify({ input }),
        }),
        url,
        url.pathname,
        "POST",
      );
      return { status: response!.status, body: await response!.json() as Record<string, unknown> };
    };

    const start = writes.length;
    expect(await send("\x1a")).toEqual({ status: 200, body: { ok: false, dropped: true, sent: 0 } });
    expect(writeTopicsTerminal(agentId, SENTINEL)).toBe(true);
    await waitForWrite(agentId, (data) => data === SENTINEL, 5000, start);
    expect(writes.slice(start).filter((write) => write.id === agentId).map((write) => write.data)).toEqual([SENTINEL]);

    const byteStart = writes.length;
    expect(await send("a\x1abé")).toEqual({ status: 200, body: { ok: true, sent: Buffer.byteLength("abé", "utf8") } });
    expect(writeTopicsTerminal(agentId, SENTINEL)).toBe(true);
    await waitForWrite(agentId, (data) => data === SENTINEL, 5000, byteStart);
    expect(writes.slice(byteStart).filter((write) => write.id === agentId).map((write) => write.data)).toEqual(["abé", "\r", SENTINEL]);
  } finally {
    await stopCliChild(parentId, agentId);
  }
}, 20_000);

test("a shell keeps its ctrl+z: there job control suspends the foreground job", async () => {
  const id = await createSession("shell");
  const { handleTerminalWebSocket } = await import("../../server/routes/terminal");
  const handlers = handleTerminalWebSocket(fakeClientSocket(), id);

  handlers!.message("\x1a");
  handlers!.message(SENTINEL);

  expect(await writesUntilSentinel(id)).toEqual(["\x1a"]);
}, 20_000);
