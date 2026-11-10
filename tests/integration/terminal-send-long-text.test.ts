/**
 * @covers TERM-14
 *
 * POST /api/terminal/sessions/:id/send with a long text, against the fake
 * Claude CLI (tests/integration/helpers/fake-claude-bridge.ts), which keeps
 * only the last 1022-byte piece of a long plain write and takes a bracketed
 * paste whole. Text for a Claude session is pasted and the route says so;
 * keys and shells are written as they came.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir, installDaemonToken } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";

const ROOT = testTmpDir("send-long-text");
const SOCKET_PATH = `${ROOT}/b.sock`;
const CWD = `${ROOT}/wt`;
let daemonToken = "";
const LONG_TEXT = "HEAD marker: the opening of the brief. " + "Do the careful thing, then report. ".repeat(80) + "TAIL";

let bridge: FakeBridge;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-daemon-token": daemonToken },
    body: body ? JSON.stringify(body) : undefined,
  }), url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}

async function createSession(type: string): Promise<string> {
  const res = await call("/api/terminal/sessions", "POST", { type, cwd: CWD, name: `send ${type}` });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const send = async (id: string, input: string) => {
  const res = await call(`/api/terminal/sessions/${id}/send`, "POST", { input });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** The bridge socket is asynchronous: let the writes land before reading what it saw. */
const settle = () => new Promise((r) => setTimeout(r, 300));

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(CWD, { recursive: true });
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  daemonToken = installDaemonToken();
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
  const ctx = await createTestAppContext();
  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  router = terminal.createTerminalRouter(ctx) as typeof router;
}, 30_000);

afterAll(async () => {
  const terminal = await import("../../server/routes/terminal");
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(null);
  await bridge?.close();
  bridge?.cleanup();
  delete process.env.CLAUDE_BIN;
  await cleanupTestDataDir(join(ROOT, "data"));
});

describe("POST /api/terminal/sessions/:id/send, long text", () => {
  test("a long text for a Claude session arrives whole and the route says it was pasted", async () => {
    const id = await createSession("claude-code");
    const r = await send(id, LONG_TEXT);
    expect(r.body).toMatchObject({ ok: true, pasted: true, sent: Buffer.byteLength(LONG_TEXT, "utf8") });
    await settle();
    const child = bridge.children.get(id)!;
    expect(child.pasted).toEqual([LONG_TEXT]);
    expect(child.typed).toBe("");
  }, 20_000);

  test("keys and short text are written as they came, not pasted", async () => {
    const id = await createSession("claude-code");
    expect((await send(id, "y")).body).toEqual({ ok: true, sent: 1, pasted: false });
    expect((await send(id, "\x1b[B")).body).toMatchObject({ pasted: false });
    // An Enter in the middle of the text makes it a key sequence, however long.
    expect((await send(id, LONG_TEXT + "\r" + LONG_TEXT)).body).toMatchObject({ pasted: false });
    await settle();
    expect(bridge.children.get(id)!.pasted).toEqual([]);
  }, 20_000);

  test("the legacy text plus Enter is pasted with the Enter as its own key", async () => {
    const id = await createSession("claude-code");
    expect((await send(id, LONG_TEXT + "\r")).body).toMatchObject({ pasted: true });
    await settle();
    const writes = bridge.received.filter((m) => m.type === "write" && m.id === id).map((m) => m.data);
    expect(writes).toEqual([`\x1b[200~${LONG_TEXT}\x1b[201~`, "\r"]);
  }, 20_000);

  test("a shell keeps a long text as plain bytes", async () => {
    const id = await createSession("shell");
    const r = await send(id, LONG_TEXT);
    expect(r.body).toMatchObject({ ok: true, pasted: false });
    await settle();
    const writes = bridge.received.filter((m) => m.type === "write" && m.id === id);
    expect(writes.map((m) => m.data)).toEqual([LONG_TEXT]);
  }, 20_000);
});

describe("writeTopicsTerminal (live-terminals send, topics-term, gateway session_send)", () => {
  test("long text plus Enter reaches a Claude session whole, Enter as a separate key", async () => {
    const terminal = await import("../../server/routes/terminal");
    const id = await createSession("claude-code");
    expect(terminal.writeTopicsTerminal(id, LONG_TEXT + "\r")).toBe(true);
    const child = bridge.children.get(id)!;
    await new Promise((r) => setTimeout(r, 500));
    // Without the paste the CLI keeps only the last 1022-byte piece in `typed`.
    expect(child.typed).toBe("");
    expect(child.enters).toBe(1);
    const writes = bridge.received.filter((m) => m.type === "write" && m.id === id).map((m) => m.data);
    expect(writes).toEqual([`\x1b[200~${LONG_TEXT}\x1b[201~`, "\r"]);
  }, 20_000);
});
