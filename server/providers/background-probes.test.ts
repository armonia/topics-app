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
 * And the work stays named while a later turn is open (BGVIS-05): on 29/09
 * chat 33966f4e lost the line naming its Bash the moment a message reopened
 * the chat, and the Bash ran six more minutes.
 *
 * @covers BGVIS-04, BGVIS-05
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { backgroundStatusRows, withBackgroundWork, type TurnStatusRow } from "./background-probes";
import { registerProvider, removeProvider } from "./index";
import type { ClaudeCodeProvider } from "./claude-code";
import { BACKGROUND_WORK_CAP_MS, WAKE_QUEUED_MS, newBackgroundWork, noteBackgroundLine } from "./claude/background-work";
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

  // Pre-existing behaviour (PR #141), not BGVIS-04: it passes on the tree
  // before the task list too. Kept as the guard that naming the tasks did not
  // give a session with a turn open a second, background row.
  test("a session with a turn open is the turn's row, not a background one", () => {
    childWithWork("topic:bg-open", [["d4", { type: "local_agent", description: "Monitor deploy" }]]);
    expect(backgroundStatusRows([{ sessionKey: "topic:bg-open" }], topicOf)).toEqual([]);
  });
});

describe("withBackgroundWork", () => {
  const job = { type: "local_bash", description: "npm run build" };
  const turnRow = (sessionKey: string): TurnStatusRow => ({ topicId: `t-${sessionKey}`, sessionKey, state: "streaming" });
  /** The lines the CLI prints, folded as the provider folds them. */
  const fold = (background: ReturnType<typeof newBackgroundWork>, unattended: boolean, ...events: unknown[]) => {
    for (const e of events) noteBackgroundLine(background, e, Date.now(), { unattended });
  };
  /** What names the job for the chat: its background row, or the background its turn row carries. */
  const named = (rows: ReturnType<typeof withBackgroundWork>, sessionKey: string) => {
    const mine = rows.filter((r) => r.sessionKey === sessionKey);
    return mine.flatMap((r) => (r.state === "background" ? r.tasks : r.background?.tasks ?? [])).map((t) => t.description);
  };

  test("a job launched, a turn that ends, a message that opens a new turn: the job stays named until it ends", () => {
    const sk = "topic:bg-keep";
    const { background } = childWithWork(sk, []);
    // The turn launches a background Bash and ends.
    fold(background, false,
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: job.type, description: job.description }] },
      { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_b1", task_type: job.type, description: job.description, is_backgrounded: true },
    );
    const idle = withBackgroundWork([], topicOf);
    // Named with the moment it was first seen, which the chat counts its running time from (BGVIS-06).
    expect(idle).toEqual([{ topicId: `t-${sk}`, sessionKey: sk, state: "background", tasks: [{ ...job, startedAt: expect.any(Number) }], lastSignalAt: background.lastSignalAt }]);

    // A message opens a turn: ONE row, the turn's, and it names the job.
    const open = withBackgroundWork([turnRow(sk)], topicOf);
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe("streaming");
    expect(named(open, sk)).toEqual([job.description]);

    // The job ends inside that turn: nothing named any more.
    fold(background, false,
      { type: "system", subtype: "background_tasks_changed", tasks: [] },
      { type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "toolu_b1", status: "completed" },
    );
    const ended = withBackgroundWork([turnRow(sk)], topicOf);
    expect(ended).toEqual([turnRow(sk)]);
  });

  test("a session with no background work keeps its turn row as it was", () => {
    const row = { ...turnRow("topic:bg-none"), state: "waiting" as const, awaitingSince: 5 };
    expect(withBackgroundWork([row], topicOf)).toEqual([row]);
  });
});
