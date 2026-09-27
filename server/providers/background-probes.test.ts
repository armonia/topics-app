/**
 * WHAT A CHAT IS WAITING ON, as the status route tells it.
 *
 * A turn that ends with an Agent, a Bash or a Monitor still running leaves a
 * `background` row in `/api/topics/streaming`. The row used to carry only the
 * topic and the session, so the chat could say "something is running" and not
 * what. Here the registered claude-code provider holds a child whose last turn
 * left two tasks behind, one of them without a description, and the row has to
 * name both and date the last news about them.
 *
 * The same sessions are working ones for the presence count behind the tail of
 * the system row: the work holds a CLI in RAM right now.
 *
 * @covers BGVIS-03, BGVIS-04
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createStatusRouter } from "../routes/status";
import { backgroundOnlySessionCount, backgroundStatusRows } from "./background-probes";
import { registerProvider, removeProvider } from "./index";
import type { ClaudeCodeProvider } from "./claude-code";
import { BACKGROUND_WORK_CAP_MS, WAKE_QUEUED_MS, newBackgroundWork } from "./claude/background-work";
import { SidechainTracker } from "./claude/sidechain-tracker";

const ROOT = testTmpDir("topics-background-probes");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));
afterEach(() => removeProvider("claude-code"));

/** A live child whose closed turn left `tasks` running, news `ageMs` ago. */
function childWithWork(sessionKey: string, tasks: Array<[string, { type: string; description: string }]>, ageMs = 1_000) {
  const provider = registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider;
  const background = newBackgroundWork();
  for (const [id, t] of tasks) background.tasks.set(id, t);
  background.lastSignalAt = Date.now() - ageMs;
  // The shape `claude-code-background-clocks.test.ts` gives a child: enough for
  // the provider's own `stop()` to tear it down when the test removes it.
  const pp = {
    sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
    fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
    pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
    readline: { close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    background,
  };
  (provider as unknown as { processes: Map<string, unknown> }).processes.set(sessionKey, pp);
  return { provider, background };
}

const topicOf = (sessionKey: string) => ({ id: `t-${sessionKey}`, sessionKey });

describe("backgroundStatusRows", () => {
  test("the row names every task, a task without a description by its type, and dates the news", () => {
    const { background } = childWithWork("topic:bg-rows", [
      ["a1", { type: "local_agent", description: "Verifica build" }],
      ["b2", { type: "local_bash", description: "" }],
    ]);
    const rows = backgroundStatusRows([], topicOf);
    expect(rows).toEqual([{
      topicId: "t-topic:bg-rows",
      sessionKey: "topic:bg-rows",
      state: "background",
      tasks: [
        { type: "local_agent", description: "Verifica build" },
        { type: "local_bash", description: "local_bash" },
      ],
      lastSignalAt: background.lastSignalAt,
    }]);
    expect(typeof rows[0].lastSignalAt).toBe("number");
  });

  test("a task that reported and is about to wake the CLI is no work in progress: the list is empty", () => {
    const { background } = childWithWork("topic:bg-wake", []);
    background.wakeQueuedAt = Date.now() - WAKE_QUEUED_MS / 2;
    const rows = backgroundStatusRows([], topicOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].tasks).toEqual([]);
  });

  test("a list past the bound the server already gave up on is not shown as running", () => {
    const { background } = childWithWork("topic:bg-lost", [["c3", { type: "local_bash", description: "tail -f" }]], BACKGROUND_WORK_CAP_MS + 1_000);
    // It reported once, so the wake keeps the session busy for a minute.
    background.wakeQueuedAt = Date.now();
    const rows = backgroundStatusRows([], topicOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].tasks).toEqual([]);
  });

  test("a session with a turn open is the turn's row, not a background one", () => {
    childWithWork("topic:bg-open", [["d4", { type: "local_agent", description: "Monitor deploy" }]]);
    expect(backgroundStatusRows([{ sessionKey: "topic:bg-open" }], topicOf)).toEqual([]);
  });
});

describe("backgroundOnlySessionCount", () => {
  test("a session whose only work is in the background is counted once, and never next to its own open turn", () => {
    childWithWork("topic:bg-count", [["e5", { type: "local_bash", description: "watch" }]]);
    expect(backgroundOnlySessionCount(new Map())).toBe(1);
    expect(backgroundOnlySessionCount(new Map([["topic:bg-count", {}]]))).toBe(0);
  });

  test("the presence route, behind the tail of the system row, counts it among the working sessions", async () => {
    childWithWork("topic:bg-presence", [["f6", { type: "local_agent", description: "Verifica build" }]]);
    const router = createStatusRouter(await createTestAppContext());
    const url = new URL("http://topics.test/api/system/presence");
    const res = (await router(new Request(url.toString()), url, url.pathname, "GET")) as Response;
    expect(((await res.json()) as { workingSessions: number }).workingSessions).toBe(1);
  });
});
