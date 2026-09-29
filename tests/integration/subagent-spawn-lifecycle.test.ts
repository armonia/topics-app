/**
 * A `spawn_agent` child from a chat, end to end through the real terminal
 * router: where it starts, how its prompt is seeded, and that every way it can
 * end reaches the chat that spawned it with a status.
 *
 * The PTY bridge is fake (a unix socket speaking the real protocol) and it
 * plays the Claude CLI's part the way the CLI does today: it writes the
 * start-up transcript the moment it is created, draws a long prompt as a
 * `[Pasted text]` placeholder, and writes the user record only when an Enter
 * lands. No `claude` process is ever started.
 *
 * The transcript lives where the router reads it, `~/.claude/projects/<cwd>`:
 * `os.homedir()` is fixed per process under Bun, so the cwd is a throwaway
 * test directory and its project folder is removed afterwards (the same
 * precedent as `server/lib/claude-transcript-path.test.ts`).
 * @covers SUBAGENT-04, SUBAGENT-05, SUBAGENT-17
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-life");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const TOPIC_ID = "5a738995-0000-4000-8000-000000000001";
const PARENT = `topic:${TOPIC_ID}`;
const TOKEN = "subagent-life-token";
const LONG_PROMPT = "Sei il sotto-agente foglio-tab: rendi BrowserTabSheet l'unica chrome del foglio e riporta i file toccati. ".repeat(40);

interface FakeChild { cwd: string; sessionId: string; typed: string; promptWrites: number; enters: number; acceptFromEnter: number }

/** The fake bridge, playing the CLI: what it received, and each child's state. */
interface FakeBridge {
  received: Array<{ type?: string; id?: string; cwd?: string; args?: string[]; data?: string }>;
  children: Map<string, FakeChild>;
  /** Enter that makes the NEXT spawned child write its prompt record (1 = the first). */
  nextAcceptFromEnter: number;
  /** Drop every connection, as a bridge that died does; `list` then answers empty. */
  dropAll(): void;
  close(): Promise<void>;
}

/**
 * The transcript folders this file CREATED, and only those, are removed at the
 * end. A cwd outside the test root is refused outright: on the code before the
 * fix the child landed in `$HOME`, whose folder holds the owner's real sessions
 * and memory, and a cleanup that removed "the folder it wrote in" deleted it
 * (it happened once while proving this test red, 29/09).
 */
const createdTranscriptDirs = new Set<string>();
const insideTestRoot = (cwd: string) =>
  [ROOT, fs.realpathSync(ROOT)].some((root) => cwd === root || cwd.startsWith(`${root}/`));
function transcriptFile(cwd: string, sessionId: string): string | null {
  if (!insideTestRoot(cwd)) return null;
  const dir = join(homedir(), ".claude", "projects", claudeProjectDirName(cwd));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    createdTranscriptDirs.add(dir);
  }
  return join(dir, `${sessionId}.jsonl`);
}
const record = (o: unknown) => JSON.stringify(o) + "\n";
function append(child: FakeChild, o: unknown): void {
  const file = transcriptFile(child.cwd, child.sessionId);
  if (file) fs.appendFileSync(file, record(o));
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* not there */ }
  const sockets = new Set<net.Socket>();
  let pid = 7000;
  const bridge: FakeBridge = {
    received: [],
    children: new Map(),
    nextAcceptFromEnter: 1,
    dropAll() { for (const s of sockets) s.destroy(); },
    close() {
      return new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); });
    },
  };
  const reply = (socket: net.Socket, o: unknown) => { try { socket.write(JSON.stringify(o) + "\n"); } catch { /* closed */ } };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the server closes when it wants */ });
    createInterface({ input: socket }).on("line", (line) => {
      let msg: FakeBridge["received"][number];
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      const id = msg.id ?? "";
      if (msg.type === "list") reply(socket, { type: "list", sessions: [] });
      else if (msg.type === "ping") reply(socket, { type: "pong" });
      else if (msg.type === "create") {
        const args = msg.args ?? [];
        const flag = args.indexOf("--session-id") >= 0 ? args.indexOf("--session-id") : args.indexOf("--resume");
        const child: FakeChild = {
          cwd: msg.cwd ?? "", sessionId: flag >= 0 ? args[flag + 1]! : "", typed: "", promptWrites: 0, enters: 0,
          acceptFromEnter: bridge.nextAcceptFromEnter,
        };
        bridge.children.set(id, child);
        const file = transcriptFile(child.cwd, child.sessionId);
        // Today's CLI creates its transcript at start-up, before any prompt.
        if (file && !fs.existsSync(file)) {
          append(child, { type: "mode", mode: "default" });
          append(child, { type: "permission-mode", permissionMode: "bypassPermissions" });
          append(child, { type: "system", subtype: "informational", content: "AGENTS.md loaded" });
        }
        reply(socket, { type: "created", id, pid: pid++ });
      } else if (msg.type === "buffer") {
        const child = bridge.children.get(id);
        const screen = child?.typed
          ? "╭──────────╮\n│ > [Pasted text #1 +40 lines] │\n╰──────────╯"
          : "╭──────────╮\n│ >          │\n╰──────────╯\n Welcome to Claude Code";
        reply(socket, { type: "buffer", id, data: Buffer.from(screen).toString("base64") });
      } else if (msg.type === "write") {
        const child = bridge.children.get(id);
        if (!child) return;
        if (msg.data === "\r") {
          child.enters += 1;
          if (child.typed && child.enters >= child.acceptFromEnter) {
            append(child, { type: "user", cwd: child.cwd, message: { role: "user", content: child.typed } });
            child.typed = "";
          }
        } else {
          child.typed += msg.data ?? "";
          child.promptWrites += 1;
        }
      } else if (msg.type === "kill") {
        setTimeout(() => reply(socket, { type: "exit", id, exitCode: 0 }), 20);
      }
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

let bridge: FakeBridge;
let ctx: AppContext;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const reports: SubAgentExitInfo[] = [];

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }), url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}

async function until<T>(what: string, probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function spawn(name: string, prompt = LONG_PROMPT): Promise<{ agentId: string; cwd: string; child: FakeChild }> {
  const res = await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/spawn`, "POST", { prompt, name });
  expect(res.status).toBe(200);
  const body = await res.json() as { agentId: string; cwd: string };
  return { ...body, child: bridge.children.get(body.agentId)! };
}
const reportsFor = (agentId: string) => reports.filter((r) => r.childId === agentId);
const hasPrompt = (child: FakeChild) => {
  const file = transcriptFile(child.cwd, child.sessionId);
  return !!file && fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes('"type":"user"');
};

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = TOKEN;
  // A path that exists: the bridge is fake, so nothing ever runs it.
  process.env.CLAUDE_BIN = "/bin/echo";
  (await import("../../server/lib/claude-bin"))._resetClaudeBinCache();
  bridge = await startFakeBridge();
  ctx = await createTestAppContext();
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: TOPIC_ID, name: "Sunshine", slug: "sunshine", parentId: null, links: [], sessionKey: PARENT,
    color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, projectPath: PROJECT,
  } as Topic);
  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal.setSubAgentExitHandler((info) => { reports.push(info); });
  router = terminal.createTerminalRouter(ctx) as typeof router;
  await until("the reconcile list", () => bridge.received.some((m) => m.type === "list"), 5_000);
}, 30_000);

afterAll(async () => {
  const terminal = await import("../../server/routes/terminal");
  terminal.setSubAgentExitHandler(null);
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(null);
  await bridge?.close();
  delete process.env.CLAUDE_BIN;
  delete process.env.GATEWAY_TOKEN;
  (await import("../../server/lib/claude-bin"))._resetClaudeBinCache();
  for (const dir of createdTranscriptDirs) fs.rmSync(dir, { recursive: true, force: true });
  await cleanupTestDataDir(ROOT);
});

describe("spawn_agent from a chat", () => {
  test("the child starts in the chat's project, gets its long prompt ONCE, and keeps the name its parent chose", async () => {
    const { agentId, cwd, child } = await spawn("foglio-tab");
    // Was `$HOME` for every chat: `parent` is undefined for a `topic:` key.
    expect(cwd).toBe(PROJECT);
    expect(bridge.received.find((m) => m.type === "create" && m.id === agentId)?.cwd).toBe(PROJECT);
    await until("the prompt record", () => hasPrompt(child));
    // Was 7: the `[Pasted text]` placeholder never matched the echo probe.
    expect(child.promptWrites).toBe(1);
    const row = ctx.db.query("SELECT name, name_source FROM terminal_sessions WHERE id = ?").get(agentId) as { name: string; name_source: string };
    expect(row).toEqual({ name: "foglio-tab", name_source: "user" });
  }, 30_000);

  test("an Enter the TUI swallowed is sent again: a transcript file alone is not a delivered prompt", async () => {
    bridge.nextAcceptFromEnter = 2;
    const { child } = await spawn("dnd-fix-B");
    bridge.nextAcceptFromEnter = 1;
    // Was 1 Enter and a child idle forever: the start-up transcript already
    // existed, so the seed called the prompt accepted.
    await until("the prompt record after a second Enter", () => hasPrompt(child), 25_000);
    expect(child.enters).toBeGreaterThanOrEqual(2);
    expect(child.promptWrites).toBe(1);
  }, 40_000);

  test("a stop mid-turn reports `stopped`, quoting the last line as partial, under the chosen name", async () => {
    const { agentId, child } = await spawn("native-image-view", "Mappa il tool_result del provider nativo.");
    await until("the prompt record", () => hasPrompt(child));
    append(child, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Sto mappando dove il tool_result finisce" }] } });
    expect((await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/${agentId}/stop`, "POST")).status).toBe(200);
    const [report] = await until("the report", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 10_000);
    expect(report!.name).toBe("native-image-view");
    expect(report!.outcome).toEqual({
      status: "stopped", partial: true, text: "Sto mappando dove il tool_result finisce",
      reason: { code: "stopped-by-parent" },
    });
  }, 30_000);

  test("a Reload is not the child's end; closing its tab later reports it once, as closed", async () => {
    const { agentId, child } = await spawn("dnd-audit", "Audit del drag-and-drop degli split.");
    await until("the prompt record", () => hasPrompt(child));
    append(child, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Leggo PanelGrid" }] } });
    // The Reload kills the PTY and relaunches it under the same id. Its exit
    // used to be reported, and the dedup by id then swallowed the real end.
    expect((await call(`/api/terminal/sessions/${agentId}/reload`, "POST")).status).toBe(200);
    // A person closes the tab: retired before the bridge's exit frame, which
    // used to leave the chat with no report at all.
    expect((await call(`/api/terminal/sessions/${agentId}`, "DELETE")).status).toBe(200);
    const [report] = await until("the report", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 10_000);
    expect(report!.outcome).toEqual({ status: "stopped", partial: true, text: "Leggo PanelGrid", reason: { code: "tab-closed" } });
    // A report of the Reload would have started earlier on the same schedule,
    // so it would already be here.
    expect(reportsFor(agentId)).toHaveLength(1);
  }, 30_000);

  test("a built-in Agent id gets a 404 that says so", async () => {
    const res = await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/a6a16ed2dbeb2ede4/read`, "GET");
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("built-in Agent tool");
  });

  test("a child whose terminal died with the bridge is reported `lost`", async () => {
    const { agentId, child } = await spawn("pcctl-build", "Compila pcctl.");
    await until("the prompt record", () => hasPrompt(child));
    append(child, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Lancio la build" }] } });
    // The bridge dies: no `exit` frame for anyone, and its successor lists no PTY.
    bridge.dropAll();
    const [report] = await until("the report", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 15_000);
    expect(report!.outcome).toEqual({ status: "lost", partial: true, text: "Lancio la build", reason: { code: "terminal-lost" } });
  }, 30_000);
});
