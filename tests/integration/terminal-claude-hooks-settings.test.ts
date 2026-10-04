/**
 * @covers CCS-06
 *
 * A `claude` terminal pane is spawned with Topics' hooks in its `--settings`.
 *
 * Once the entries leave the user's global `~/.claude/settings.json`, that
 * argv is the only way the pane's session reports its phase, its current tool
 * and its end of turn. The line that adds it is one push in `createSession`;
 * dropped, every pane goes quiet and no other test notices.
 *
 * The bridge is a fake unix socket speaking the real protocol (as in
 * `terminal-sessions-write-failure.test.ts`): it records the `create` frame,
 * the exact argv the PTY would run. The claude binary is `/bin/sh` through
 * `CLAUDE_BIN`, never started.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { TOPICS_HOOK_EVENTS, topicsHookCommand } from "../../server/lib/topics-hooks";

const TEST_ROOT = testTmpDir("terminal-hooks");
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;
const TOPICS_HOME = join(TEST_ROOT, "topics-home");

let bridgeServer: net.Server;
const bridgeSockets = new Set<net.Socket>();
const creates: Array<{ id: string; shell: string; args: string[] }> = [];
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
    createInterface({ input: socket }).on("line", (line) => {
      let msg: { type?: string; id?: string; shell?: string; args?: string[] };
      try { msg = JSON.parse(line); } catch { return; }
      const reply = (m: object) => { try { socket.write(JSON.stringify(m) + "\n"); } catch { /* closed */ } };
      if (msg.type === "list") { sawList = true; reply({ type: "list", sessions: [] }); }
      else if (msg.type === "ping") reply({ type: "pong" });
      else if (msg.type === "create") {
        creates.push({ id: msg.id!, shell: msg.shell!, args: msg.args ?? [] });
        reply({ type: "created", id: msg.id, pid: 6000 + creates.length });
      }
    });
  });
  return new Promise((resolve) => bridgeServer.listen(SOCKET_PATH, () => resolve()));
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
  for (const c of creates) cleanupMcpConfigForSession(c.id);
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

test("a claude-code pane's create frame has ONE --settings with the seven hooks on the TOPICS_HOME script", async () => {
  const url = new URL("http://h/api/terminal/sessions");
  const res = await terminalRouter(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "claude-code", cwd: CWD, name: "hooks" }),
    }),
    url,
    url.pathname,
    "POST",
  );
  expect(res?.status).toBe(200);
  const { id } = (await res!.json()) as { id: string };
  const frame = creates.find((c) => c.id === id);
  expect(frame?.shell).toBe("/bin/sh");

  const args = frame!.args;
  const at = args.flatMap((a, i) => (a === "--settings" ? [i] : []));
  // The CLI keeps the LAST `--settings` only: a second one would drop the first.
  expect(at).toHaveLength(1);
  const settings = JSON.parse(args[at[0]! + 1]!);
  const script = join(TOPICS_HOME, "claude-hooks", "post-hook.sh");
  for (const event of TOPICS_HOOK_EVENTS) {
    const commands = (settings.hooks[event] as Array<{ matcher?: string; hooks: Array<{ command: string }> }>)
      .filter((m) => !m.matcher)
      .flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toEqual([topicsHookCommand(script, event)]);
  }
}, 20_000);
