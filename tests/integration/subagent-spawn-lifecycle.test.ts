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
 * @covers SUBAGENT-04, SUBAGENT-05, SUBAGENT-07, SUBAGENT-12, SUBAGENT-17
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir, installDaemonToken } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge, type FakeChild } from "./helpers/fake-claude-bridge";
import { _setClaudeSessionsDirForTests } from "../../server/lib/claude-live-session";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-life");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
/** The CLI's `~/.claude/sessions`, kept inside the test root: the bridge's pids (7000 on) can be a real CLI's pid. */
const CLI_SESSIONS = `${ROOT}/cli-sessions`;
const TOPIC_ID = "5a738995-0000-4000-8000-000000000001";
const PARENT = `topic:${TOPIC_ID}`;
let TOKEN = "";
const LONG_PROMPT = "Sei il sotto-agente foglio-tab: rendi BrowserTabSheet l'unica chrome del foglio e riporta i file toccati. ".repeat(40);

let bridge: FakeBridge;
const transcriptFile = (cwd: string, sessionId: string) => bridge.transcriptFile(cwd, sessionId);
const append = (child: FakeChild, o: unknown) => bridge.append(child, o);

let ctx: AppContext;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const reports: SubAgentExitInfo[] = [];
/** The slow-seeding child, started in the first test so its Enter retry overlaps the tests that follow. */
let slowChild: { agentId: string; cwd: string; child: FakeChild } | null = null;

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-daemon-token": TOKEN },
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
const stateOf = (agentId: string) => (ctx.db.query("SELECT state FROM subagents WHERE id = ?").get(agentId) as { state: string } | null)?.state;
const reportsFor = (agentId: string) => reports.filter((r) => r.childId === agentId);
/** The user records of a child's transcript, in order. */
const userRecords = (child: FakeChild): string[] => {
  const file = transcriptFile(child.cwd, child.sessionId);
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      return e.type === "user" && typeof e.message?.content === "string" ? [e.message.content] : [];
    } catch { return []; }
  });
};
/**
 * A brief shaped like the one of the child that was to build a filings
 * register (04/11): one line of 1179 bytes whose opening says what to do.
 * Written in one go it reached the child as its last 54 bytes, which started
 * mid-word.
 */
const briefOf = (head: string) =>
  `${head} Repo di prova, worktree di prova, branch feat/invio-diretto-enti. ` +
  "Implementa solo la traccia del registro invii per ditta, con la barra eseguibile e un test che va rosso senza il codice. ".repeat(9) +
  "Alla fine rispondi in italiano in 5 righe: cosa c'è, comandi della barra con exit code, cosa manca.";
const stopChild = async (agentId: string) => {
  expect((await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/${agentId}/stop`, "POST")).status).toBe(200);
};
const hasPrompt = (child: FakeChild) => {
  const file = transcriptFile(child.cwd, child.sessionId);
  return !!file && fs.existsSync(file) && fs.readFileSync(file, "utf-8").includes('"type":"user"');
};

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(CLI_SESSIONS, { recursive: true });
  _setClaudeSessionsDirForTests(CLI_SESSIONS);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  TOKEN = installDaemonToken();
  // A path that exists: the bridge is fake, so nothing ever runs it.
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
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
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge?.cleanup();
  _setClaudeSessionsDirForTests(null);
  await cleanupTestDataDir(ROOT);
});

/**
 * Two children of the chat briefed with the same opening, longer than the
 * prompt fingerprint, spawned together in one directory of their own. The
 * first takes its prompt at the first Enter, the second only at the retry 6 s
 * later: in that window, on 08/11, the second matched the first's transcript
 * by its opening and kept that conversation for good.
 */
async function spawnSameOpeningPair(dir: string): Promise<{ early: { agentId: string; child: FakeChild }; late: { agentId: string; child: FakeChild } }> {
  const cwd = join(ROOT, dir);
  fs.mkdirSync(cwd, { recursive: true });
  const opening = "Rispondi sempre in italiano. Repo ~/Projects/zenocms (GitHub armonia/zenocms). Compito: ";
  const launch = async (name: string, task: string) => {
    const res = await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/spawn`, "POST", { prompt: opening + task, name, cwd, runtime: "claude-code" });
    expect(res.status).toBe(200);
    const { agentId } = await res.json() as { agentId: string };
    return { agentId, child: bridge.children.get(agentId)! };
  };
  bridge.nextAcceptFromEnter = 2;
  const late = await launch(`${dir}-168`, "le PR #168 e #169 sono in conflitto con main.");
  bridge.nextAcceptFromEnter = 1;
  const early = await launch(`${dir}-183`, "le PR #183 e #166 sono in conflitto con main.");
  return { early, late };
}

/** The conversation a resume of the child opens: its sub-agent row, and its terminal row. */
const conversationOf = (agentId: string) => {
  const sub = ctx.db.query("SELECT claude_session_id AS id FROM subagents WHERE id = ?").get(agentId) as { id: string | null } | null;
  const tab = ctx.db.query("SELECT claude_session_id AS id FROM terminal_sessions WHERE id = ?").get(agentId) as { id: string | null } | null;
  return { subagent: sub?.id ?? null, terminal: tab?.id ?? null };
};

async function stopChildren(...agentIds: string[]): Promise<void> {
  for (const id of agentIds) await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/${id}/stop`, "POST");
}

describe("spawn_agent from a chat", () => {
  test("the child starts in the chat's project, gets its long prompt ONCE, and keeps the name its parent chose", async () => {
    // The next test's child needs a 6 s Enter retry: start it here so that wait overlaps the tests below.
    bridge.nextAcceptFromEnter = 2;
    slowChild = await spawn("dnd-fix-B");
    bridge.nextAcceptFromEnter = 1;
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

  test("a brief longer than 1022 bytes reaches the child whole, its opening included", async () => {
    // Was its last piece only: macOS hands a long write to the TUI 1022 bytes
    // at a time and the CLI dropped every full piece (13 of 14 cut briefs since 25/10).
    const brief = briefOf("APERTURA-DEL-BRIEF.");
    expect(Buffer.byteLength(brief, "utf8")).toBeGreaterThan(1022);
    const { agentId, child } = await spawn("registro-invii", brief);
    try {
      await until("the prompt record", () => hasPrompt(child));
      const [first] = userRecords(child);
      expect(first).toContain("APERTURA-DEL-BRIEF.");
      expect(first).toContain(brief);
      expect(child.promptWrites).toBe(1);
    } finally {
      // A live child holds one of the parent's five slots.
      await stopChild(agentId);
    }
  }, 30_000);

  test("send_to_agent with a long input reaches a live child whole", async () => {
    // The filings-register child got its brief this way: 1076 bytes in, the last 54 out.
    const { agentId, child } = await spawn("registro-invii-bis", "Aspetta le istruzioni.");
    try {
      await until("the prompt record", () => hasPrompt(child));
      const input = briefOf("SECONDA-APERTURA.");
      const res = await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/${agentId}/send`, "POST", { input });
      expect(res.status).toBe(200);
      await until("the second user record", () => userRecords(child).length > 1);
      expect(userRecords(child)[1]).toContain("SECONDA-APERTURA.");
      expect(userRecords(child)[1]).toContain(input);
    } finally {
      await stopChild(agentId);
    }
  }, 30_000);

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
    // Marked as the parent's own stop on the report itself, not only through
    // the reason: a child without a transcript has another one.
    expect(report!.stoppedByParent).toBe(true);
    expect(stateOf(agentId)).toBe("stopped");
  }, 30_000);

  test("a Reload ends the open turn as stopped, not the child; closing its tab later reports the next turn once, as closed", async () => {
    const { agentId, child } = await spawn("dnd-audit", "Audit del drag-and-drop degli split.");
    await until("the prompt record", () => hasPrompt(child));
    append(child, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Leggo PanelGrid" }] } });
    // The Reload kills the PTY and relaunches it under the same id with
    // `--resume`, which does not go on with the cut turn: that turn ends here.
    expect((await call(`/api/terminal/sessions/${agentId}/reload`, "POST")).status).toBe(200);
    const [cut] = await until("the reload's report", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 10_000);
    expect(cut!.outcome).toEqual({ status: "stopped", partial: true, text: "Leggo PanelGrid", reason: { code: "reloaded" } });
    expect(stateOf(agentId)).toBe("running");
    // The child lives on and is given a second turn.
    const resumed = bridge.children.get(agentId)!;
    append(resumed, { type: "user", message: { role: "user", content: "Ora gli split annidati." } });
    append(resumed, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Leggo SplitPane" }] } });
    // A person closes the tab: retired before the bridge's exit frame, which
    // used to leave the chat with no report at all.
    expect((await call(`/api/terminal/sessions/${agentId}`, "DELETE")).status).toBe(200);
    await until("the close's report", () => reportsFor(agentId).length > 1, 10_000);
    expect(reportsFor(agentId)[1]).toMatchObject({ turn: 2, outcome: { status: "stopped", partial: true, text: "Leggo SplitPane", reason: { code: "tab-closed" } } });
    // A person's stop is not the parent's: it wakes the parent.
    expect(reportsFor(agentId).some((r) => r.stoppedByParent)).toBe(false);
    expect(stateOf(agentId)).toBe("stopped");
    expect(reportsFor(agentId)).toHaveLength(2);
  }, 30_000);

  test("a built-in Agent id gets a 404 that says so", async () => {
    const res = await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/a6a16ed2dbeb2ede4/read`, "GET");
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("built-in Agent tool");
  });

  test("a stop from inside the parent's open turn is kept at once, and is written as a row when that turn ends, without waking it", async () => {
    // The real wiring: the topics router registers the watcher that hands the
    // result to the wake, and the wake posts it through the real chat route.
    // The collector goes back in `finally`.
    const terminal = await import("../../server/routes/terminal");
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { createChatRouter } = await import("../../server/routes/chat");
    const { startSubagentWakes, _resetSubagentWakes } = await import("../../server/services/subagent-wake");
    createTopicsRouter(ctx);
    let turn: StreamHandler | undefined;
    const provider = {
      name: "fake-stream",
      capabilities: new Set(["streaming"]),
      contextStrategy: "history-aware",
      get connected() { return true; },
      registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { turn = h; },
      unregisterStreamHandler: () => {},
      // The turn stays open until the test ends it with `onDone`.
      sendChat: () => new Promise<{ runId?: string }>(() => {}),
      defaultModel: () => "fake-model",
      abort: async () => {},
      start: () => {}, stop: () => {},
      complete: async () => ({ content: "" }),
    } as unknown as AIProvider;
    const chat = createChatRouter(ctx, {
      resolveProvider: () => provider,
      detectLocalhostAutoNav: () => {},
      bindTopicToProject: () => {},
      resolveProjectRef: () => null,
      getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => [],
      autoBindProject: () => {},
      watchSessionForSubagents: () => {},
      updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR: join(ROOT, "ws"),
    } as never);
    startSubagentWakes({
      route: chat, isBusy: (sk) => ctx.activeStreams.has(sk), canWake: () => "wake", debounceMs: 50, pollMs: 50, endGraceMs: 100,
    });
    const rows = (role: "user" | "assistant") => ctx.db.query(
      `SELECT id, content, blocks FROM messages WHERE session_key = ? AND role = '${role}' ORDER BY sort_order, rowid`,
    ).all(PARENT) as Array<{ id: string; content: string; blocks: string | null }>;
    try {
      const url = new URL("http://h/api/chat");
      const res = await chat(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: PARENT, messages: [{ role: "user", content: "Ferma lo scout e dimmi cosa ha trovato." }] }),
      }), url, url.pathname, "POST");
      expect(res?.status).toBe(200);
      res?.body?.cancel().catch(() => {});
      const handler = await until("the parent's turn", () => turn);
      turn = undefined;
      const turnRowId = rows("assistant").at(-1)!.id;
      let text = "";
      for (let i = 1; i <= 12; i++) { const d = `Fermo lo scout ${i}. `; text += d; handler.onTextDelta(d, text); }

      const { agentId, child } = await spawn("scout-open-turn", "Cerca i call site di deliverExit.");
      await until("the prompt record", () => hasPrompt(child));
      append(child, { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Found 2 call sites" }] } });
      expect((await call(`/api/sessions/${encodeURIComponent(PARENT)}/agents/${agentId}/stop`, "POST")).status).toBe(200);

      // Kept at once on the child's row, while the turn is still open: a
      // restart now would send it again instead of losing it (SUBAGENT-07).
      const pending = await until("the result kept on the sub-agent's row", () => {
        const r = ctx.db.query("SELECT pending_results FROM subagents WHERE id = ?").get(agentId) as { pending_results: string | null } | null;
        return r?.pending_results ?? undefined;
      }, 10_000);
      expect(JSON.parse(pending)[0]).toMatchObject({ agentId, status: "completed", text: "Found 2 call sites" });
      expect(ctx.activeStreams.has(PARENT)).toBe(true);
      // ...and not yet in the chat: a busy parent is not interrupted (SUBAGENT-12).
      await new Promise((r) => setTimeout(r, 300));
      expect(rows("user").some((r) => r.content.includes("scout-open-turn"))).toBe(false);

      handler.onDone({ content: [{ type: "text", text: text + "Fatto." }] } as never);
      // The stop is the parent's own, so its end starts no turn, whatever the
      // result says (here `completed`: the child had ended its turn): the
      // card lands as a row once the parent's turn is over (03/10; before, a
      // `completed` result of a stopped child woke the parent).
      const card = await until("the result row", () => rows("assistant").find((r) => r.id !== turnRowId && r.content.includes("scout-open-turn")), 15_000);
      expect(card.content).toContain("Found 2 call sites");
      expect(JSON.parse(card.blocks!)).toEqual([{ kind: "subagent-result", results: [expect.objectContaining({ agentId, name: "scout-open-turn", status: "completed" })] }]);
      expect(rows("user").some((r) => r.content.includes('agent="scout-open-turn"'))).toBe(false);
      expect(turn).toBeUndefined();
      expect(rows("assistant").find((r) => r.id === turnRowId)?.content).toContain("Fermo lo scout 12.");
      await until("the pending copy dropped", () => {
        const r = ctx.db.query("SELECT pending_results FROM subagents WHERE id = ?").get(agentId) as { pending_results: string | null };
        return r.pending_results === null;
      }, 5_000);
    } finally {
      _resetSubagentWakes();
      terminal.setSubAgentExitHandler((info) => { reports.push(info); });
    }
  }, 60_000);

  test("an Enter the TUI swallowed is sent again: a transcript file alone is not a delivered prompt", async () => {
    // Spawned in the first test: the 6 s Enter retry overlapped the tests above.
    // Was 1 Enter and a child idle forever: the start-up transcript already
    // existed, so the seed called the prompt accepted.
    await until("the prompt record after a second Enter", () => hasPrompt(slowChild!.child), 25_000);
    expect(slowChild!.child.enters).toBeGreaterThanOrEqual(2);
    expect(slowChild!.child.promptWrites).toBe(1);
  }, 40_000);

  test("two children briefed with the same opening each keep the conversation their own CLI is on", async () => {
    bridge.mintSessionIds = true;
    bridge.sessionsDir = CLI_SESSIONS;
    let pair: Awaited<ReturnType<typeof spawnSameOpeningPair>> | null = null;
    try {
      pair = await spawnSameOpeningPair("same-opening");
      const { early, late } = pair;
      const own = (c: { child: FakeChild }) => ({ subagent: c.child.sessionId, terminal: c.child.sessionId });
      // The late prompt lands at the Enter retry, about 6 s in.
      await until("both prompts delivered, each child on its own conversation", () =>
        hasPrompt(early.child) && hasPrompt(late.child)
        && Bun.deepEquals(conversationOf(early.agentId), own(early)) && Bun.deepEquals(conversationOf(late.agentId), own(late)), 25_000,
      ).catch(() => { /* the assertions below say what went wrong */ });
      // Was the early sibling's conversation for both: a resume of the late
      // one, or its transcript read for the parent, opened the other's work.
      expect({ early: conversationOf(early.agentId), late: conversationOf(late.agentId) }).toEqual({ early: own(early), late: own(late) });
      // And the late prompt was then never sent: its seed read the other's
      // transcript, found the shared opening there and took it as delivered.
      expect({ early: hasPrompt(early.child), late: hasPrompt(late.child) }).toEqual({ early: true, late: true });
    } finally {
      bridge.mintSessionIds = false;
      bridge.sessionsDir = null;
      if (pair) await stopChildren(pair.early.agentId, pair.late.agentId);
    }
  }, 45_000);

  test("a child whose terminal died with the bridge is reported `lost`", async () => {
    // Last: dropAll kills every PTY.
    const { agentId, child } = await spawn("pcctl-build", "Compila pcctl.");
    await until("the prompt record", () => hasPrompt(child));
    append(child, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Lancio la build" }] } });
    // The bridge dies: no `exit` frame for anyone, and its successor lists no PTY.
    bridge.dropAll();
    const [report] = await until("the report", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 15_000);
    expect(report!.outcome).toEqual({ status: "lost", partial: true, text: "Lancio la build", reason: { code: "terminal-lost" } });
    // The row says so too: a lost child holds no slot, and can be resumed (SUBAGENT-14).
    expect(stateOf(agentId)).toBe("lost");
  }, 30_000);
});
