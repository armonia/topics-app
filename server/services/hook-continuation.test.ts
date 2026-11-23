/**
 * The brakes of the turn a `turn-end` hook asks for, on a real table and
 * without a route.
 * @covers HOOKS-04
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { HOOK_CONTINUATION_LIMIT, continueAfterTurnEndHook, goalBoughtTurn, hookChainLength, lastRowIdOf } from "./hook-continuation";

function db() {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT, sort_order INTEGER, parent_id TEXT)`);
  let n = 0;
  let prev: string | null = null;
  const add = (role: string, blocks?: unknown[]) => {
    const id = `m${++n}`;
    d.query(`INSERT INTO messages VALUES (?, 's', ?, 'x', ?, ?, ?)`).run(id, role, blocks ? JSON.stringify(blocks) : null, n, prev);
    prev = id;
    return id;
  };
  return { d, add };
}
const HOOK = [{ kind: "hook-nudge", attempt: 1 }];

describe("hookChainLength: counted on the rows, reset only by the person", () => {
  test("machine rows in between neither count nor reset the chain (review of PR 1623, defect 1)", () => {
    const { d, add } = db();
    add("user"); add("assistant");
    add("user", HOOK); add("assistant");
    add("user", [{ kind: "goal-nudge", attempt: 1 }]); add("assistant");
    add("user", HOOK); add("assistant");
    add("user", [{ kind: "process-exit", processId: "p", exitCode: 0, label: "x" }]); add("assistant");
    add("user", HOOK); add("assistant");
    expect(hookChainLength(d, "s")).toBe(3);
  });

  test("a resume's unmarked row (its answer carries `ripreso`) does not reset it either", () => {
    const { d, add } = db();
    add("user"); add("assistant");
    add("user", HOOK); add("assistant");
    add("user"); add("assistant", [{ kind: "ripreso", attempt: 1 }]);
    add("user", HOOK); add("assistant");
    expect(hookChainLength(d, "s")).toBe(2);
  });

  test("the person's words reset it", () => {
    const { d, add } = db();
    add("user", HOOK); add("assistant");
    add("user", HOOK); add("assistant");
    add("user"); add("assistant");
    expect(hookChainLength(d, "s")).toBe(0);
    add("user", HOOK);
    expect(hookChainLength(d, "s")).toBe(1);
  });
});

const base = {
  sessionKey: "s", subagentChat: false, text: "carry on", chainLength: 0,
  endedCleanly: true, pendingAsk: false, goalOwnsTurn: false,
};

function deps(d: Database, resend: () => Promise<void> = async () => {}) {
  const sent: unknown[] = [];
  const log: string[] = [];
  return { sent, log, deps: { db: d, resend: async (i: unknown) => { sent.push(i); await resend(); }, log: (m: string) => log.push(m) } };
}

describe("continueAfterTurnEndHook", () => {
  test("sends the text once, marked hook-nudge, with the next attempt", async () => {
    const { d, add } = db();
    const last = add("assistant");
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, chainLength: 1, turnLastRowId: last }, x.deps)).toBe("sent");
    expect(x.sent).toEqual([{ sessionKey: "s", text: "carry on", attempt: 2, mark: "hook-nudge" }]);
  });

  test(`at ${HOOK_CONTINUATION_LIMIT} in a row: ignored and logged`, async () => {
    const { d, add } = db();
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, chainLength: HOOK_CONTINUATION_LIMIT, turnLastRowId: add("assistant") }, x.deps)).toBe("capped");
    expect(x.sent).toEqual([]);
    expect(x.log[0]).toContain("ceiling");
  });

  test("a newer row since the turn ended: the verdict is stale, not sent (defect 2)", async () => {
    const { d, add } = db();
    const last = add("assistant");
    add("user"); add("assistant");
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, turnLastRowId: last }, x.deps)).toBe("stale");
    expect(x.sent).toEqual([]);
  });

  test("a native sub-agent's chat is never continued by a hook (defect 4)", async () => {
    const { d, add } = db();
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, subagentChat: true, turnLastRowId: add("assistant") }, x.deps)).toBe("subagent");
    expect(x.sent).toEqual([]);
  });

  test("goalBoughtTurn: only a continuation or a resume the goal loop sent", () => {
    expect(goalBoughtTurn("continued")).toBe(true);
    expect(goalBoughtTurn("tool-budget-resumed")).toBe(true);
    for (const o of ["achieved", "capped", "stalled", "blocked", "undecided", "busy", "skipped", "background", "error"]) expect(goalBoughtTurn(o)).toBe(false);
  });

  test("a machine notice written after the turn (a goal's stop line) is not a newer turn", async () => {
    const { d, add } = db();
    const last = add("assistant");
    add("assistant", [{ kind: "goal-stop", reason: "capped" }]);
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, turnLastRowId: last }, x.deps)).toBe("sent");
  });

  test("the goal loop bought a turn for this end: the hook does not buy a second one (defect 5)", async () => {
    const { d, add } = db();
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, goalOwnsTurn: true, turnLastRowId: add("assistant") }, x.deps)).toBe("goal-owns");
    expect(x.sent).toEqual([]);
  });

  test("a turn that did not end on its own, or waits on a question, is not continued", async () => {
    const { d, add } = db();
    const last = add("assistant");
    const x = deps(d);
    expect(await continueAfterTurnEndHook({ ...base, endedCleanly: false, turnLastRowId: last }, x.deps)).toBe("not-clean");
    expect(await continueAfterTurnEndHook({ ...base, pendingAsk: true, turnLastRowId: last }, x.deps)).toBe("waiting-human");
    expect(x.sent).toEqual([]);
  });

  test("never fatal: a 409 from the route is a log line, not a throw", async () => {
    const { d, add } = db();
    const x = deps(d, async () => { throw new Error("the chat route answered 409"); });
    expect(await continueAfterTurnEndHook({ ...base, turnLastRowId: add("assistant") }, x.deps)).toBe("failed");
    expect(x.log[0]).toContain("409");
  });

  test("lastRowIdOf: the newest row of the session", () => {
    const { d, add } = db();
    expect(lastRowIdOf(d, "s")).toBeNull();
    add("user");
    const newest = add("assistant");
    expect(lastRowIdOf(d, "s")).toBe(newest);
  });
});
