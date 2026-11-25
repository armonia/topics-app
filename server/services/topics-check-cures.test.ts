/**
 * The cures of the self-check: a known cause is healed and the line is written,
 * an absent cause writes nothing, a cure that does not clear the red opens one
 * investigation card per problem key, under the daily cap, and nothing opens
 * without a chosen board.
 *
 * @covers CHECK-03
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createTaskService } from "./tasks";
import { createCures, cureDepsOf, problemsOf, UNKNOWN_RETRY_CAP } from "./topics-check-cures";
import { createWakeBreaker, WAKE_FAIL_THRESHOLD } from "./wake-breaker";
import { createTopicsCheck, DEFAULT_THRESHOLDS, parseSettings, summarizeCures, type Sample, type StuckCard } from "./topics-check";

let NOW = Date.parse("2026-11-22T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const T = DEFAULT_THRESHOLDS;
const SCHEMA = (() => {
  const d = new Database(":memory:");
  for (const m of EMBEDDED_MIGRATIONS) d.run(m.sql);
  return d.serialize();
})();

function setup(opts: { reassign?: boolean } = {}) {
  NOW = Date.parse("2026-11-22T12:00:00.000Z");
  const db = Database.deserialize(SCHEMA);
  db.run("PRAGMA foreign_keys = OFF");
  // The same clock as the cures: a card made "today" is today whatever day the suite runs.
  const svc = createTaskService(db, { now: () => new Date(NOW).toISOString() });
  /** `placed`: the system put the card on its machine (a person's pin has no `overflowed_at`). */
  const card = (id: string, machineId: string | null = null, status = "todo", runOpen = 0, placed = true) => {
    db.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, machine_id, node_run_open, overflowed_at) VALUES (?, 'work', 'c', ?, 'x', 'x', ?, ?, ?)").run(id, status, machineId, runOpen, machineId && placed ? "x" : null);
  };
  const emitted: string[] = [];
  const reassigned: string[] = [];
  const failureCalls: string[] = [];
  const open = new Set<string>();
  const cures = createCures({
    db, svc, now: () => NOW, emit: (task) => emitted.push(task.id),
    reassign: (task) => { reassigned.push(task.id); return opts.reassign ?? true; },
    breaker: { failure: (id) => { failureCalls.push(id); open.add(id); }, isOpen: (id) => open.has(id) },
  });
  const lines = (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content);
  const opened = () => (db.query("SELECT id, text FROM tasks WHERE claude_task_id LIKE 'topics-check:%'").all() as { id: string; text: string }[]);
  return { db, svc, card, cures, reassigned, failureCalls, lines, opened, emitted };
}
const stuck = (id: string, cause: StuckCard["cause"]): StuckCard => ({ id, status: "todo", hours: 3, cause });
const sample = (stuckCards: StuckCard[] = [], moves: Sample["moves"] = []): Sample => ({ at: NOW, todo: 1, machines: [], stuck: stuckCards, moves });
const ON_BOARD = { boardId: "inv", perDay: 3 };
const OFF = { boardId: null, perDay: 3 };
const bounces = (id: string, from = NOW) => Array.from({ length: 4 }, (_, i) => ({ id, at: from - i * 60_000, to: "n1", silent: false }));

describe("a known cause is cured", () => {
  test("a card pinned to a dead machine is reassigned through the dispatcher's own cure", () => {
    const h = setup(); h.card("a", "m1");
    expect(h.cures.run(sample([stuck("a", "offline")]), T, OFF)).toEqual([{ key: "offline:a", outcome: "cured" }]);
    expect(h.reassigned).toEqual(["a"]);
  });
  test("no dead pin, no cure: nothing is reassigned and nothing is written", () => {
    const h = setup(); h.card("a", null);
    h.cures.run(sample([stuck("a", "offline")]), T, OFF);
    expect(h.reassigned).toEqual([]);
    expect(h.lines("a")).toEqual([]);
  });
  test("a hung node's breaker is opened and the card says so", () => {
    const h = setup(); h.card("h", "m1");
    expect(h.cures.run(sample([stuck("h", "hung-node")]), T, OFF)[0]!.outcome).toBe("cured");
    expect(h.failureCalls.length).toBeGreaterThan(0);
    expect(h.failureCalls.every((id) => id === "m1")).toBe(true);
    expect(h.lines("h").join(" ")).toContain("nodo");
  });
  test("a node whose breaker is already open is left alone", () => {
    const h = setup(); h.card("h", "m1");
    h.cures.run(sample([stuck("h", "hung-node")]), T, OFF);
    const before = h.failureCalls.length;
    h.cures.run(sample([stuck("h", "hung-node")]), T, OFF);
    expect(h.failureCalls.length).toBe(before);
  });
  test("a bouncing card is pinned here for six hours and the card says so", () => {
    const h = setup(); h.card("b", "m1");
    expect(h.cures.run(sample([], bounces("b")), T, OFF)).toEqual([{ key: "bounce:b", outcome: "cured" }]);
    const row = h.db.query("SELECT machine_id, stay_local, stay_local_until FROM tasks WHERE id = 'b'").get() as { machine_id: string | null; stay_local: number; stay_local_until: string };
    expect(row.machine_id).toBeNull();
    expect(row.stay_local).toBe(1);
    expect(Date.parse(row.stay_local_until)).toBe(NOW + 6 * 3_600_000);
    expect(h.lines("b").join(" ")).toContain("6 ore");
  });
  test("a card that does not bounce is not pinned", () => {
    const h = setup(); h.card("b", "m1");
    expect(h.cures.run(sample([], bounces("b").slice(0, 3)), T, OFF)).toEqual([]);
    expect((h.db.query("SELECT stay_local FROM tasks WHERE id = 'b'").get() as { stay_local: number }).stay_local).toBe(0);
  });
});

describe("the cures touch only the cards they are made for", () => {
  test("a card with a run still open keeps its machine: no reassignment, it goes to the investigation", () => {
    const h = setup(); h.card("r", "m1", "in_progress", 1);
    expect(h.cures.run(sample([stuck("r", "offline")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.reassigned).toEqual([]);
  });
  test("a card in progress is never reassigned even with no run open", () => {
    const h = setup(); h.card("r", "m1", "in_progress", 0);
    h.cures.run(sample([stuck("r", "seats")]), T, OFF);
    expect(h.reassigned).toEqual([]);
  });
  test("a bounce read over the day but older than the window is not a bounce", () => {
    const h = setup(); h.card("b", "m1");
    const old = Array.from({ length: 4 }, (_, i) => ({ id: "b", at: NOW - 5 * 3_600_000 - i * 60_000, to: "n1", silent: false }));
    expect(h.cures.run(sample([], old), T, OFF)).toEqual([]);
    expect((h.db.query("SELECT stay_local FROM tasks WHERE id = 'b'").get() as { stay_local: number }).stay_local).toBe(0);
  });
  test("a bounce on a card that is no longer in todo is left alone", () => {
    const h = setup(); h.card("v", "m1", "review"); h.card("w", "m1", "in_progress", 1);
    expect(h.cures.run(sample([], [...bounces("v"), ...bounces("w")]), T, ON_BOARD)).toEqual([]);
    expect(h.opened()).toHaveLength(0);
    expect(h.db.query("SELECT machine_id FROM tasks WHERE id = 'v'").get()).toEqual({ machine_id: "m1" });
  });
  test("a bouncing card with a run still open is not pinned", () => {
    const h = setup(); h.card("o", "m1", "todo", 1);
    expect(h.cures.run(sample([], bounces("o")), T, OFF)[0]!.outcome).toBe("off");
    expect(h.db.query("SELECT machine_id FROM tasks WHERE id = 'o'").get()).toEqual({ machine_id: "m1" });
  });
  test("the pin is published to the views", () => {
    const h = setup(); h.card("b", "m1");
    h.cures.run(sample([], bounces("b")), T, OFF);
    expect(h.emitted).toEqual(["b"]);
  });
  test("one hung node is one problem, however many cards sit on it", () => {
    const h = setup(); h.card("h1", "m1"); h.card("h2", "m1"); h.card("h3", "m2");
    const out = h.cures.run(sample([stuck("h1", "hung-node"), stuck("h2", "hung-node"), stuck("h3", "hung-node")]), T, OFF);
    expect(out.map((o) => o.key)).toEqual(["hung-node:m1", "hung-node:m2"]);
  });
});

describe("what the cures cannot clear opens one card", () => {
  test("the title of a bounce investigation describes a bounce, not the stay-local cause", () => {
    const h = setup(); h.card("b", "m1");
    h.cures.run(sample([], bounces("b")), T, ON_BOARD);
    NOW += 10 * 60_000;
    h.cures.run(sample([], bounces("b", NOW)), T, ON_BOARD);
    expect(h.opened()[0]!.text).toContain("rimbalza");
  });
  test("a curable problem under the cap stays capped: it is not cured again every other round", () => {
    const h = setup(); h.card("a", "m1");
    const none = { boardId: "inv", perDay: 0 };
    const outcomes = [1, 2, 3, 4].map(() => h.cures.run(sample([stuck("a", "offline")]), T, none)[0]!.outcome);
    expect(outcomes).toEqual(["cured", "capped", "capped", "capped"]);
    expect(h.reassigned).toEqual(["a"]);
  });
  test("a capped problem is asked again the next day, and says so only once a day", () => {
    const h = setup(); h.card("1"); h.card("2");
    const db = h.db;
    const cures = createCures({ db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    const s = sample([stuck("1", "memory"), stuck("2", "memory")]);
    const one = { boardId: "inv", perDay: 1 };
    expect(cures.run(s, T, one).map((o) => o.outcome)).toEqual(["investigated", "capped"]);
    expect(cures.run(s, T, one).map((o) => o.outcome)).toEqual(["skipped", "capped"]);
    expect(h.lines("2")).toHaveLength(1);
    NOW += DAY;
    expect(cures.run(s, T, one).map((o) => o.outcome)).toEqual(["skipped", "investigated"]);
  });
  test("a cause with no cure opens its investigation card on the chosen board", () => {
    const h = setup(); h.card("m");
    expect(h.cures.run(sample([stuck("m", "memory")]), T, ON_BOARD)).toEqual([{ key: "memory:m", outcome: "investigated" }]);
    expect(h.opened()).toHaveLength(1);
    expect(h.lines("m").join(" ")).toContain("Indagine aperta");
  });
  test("a cause that needs a person opens nothing: waiting on a person is not a fault", () => {
    const h = setup(); h.card("p");
    expect(h.cures.run(sample([stuck("p", "person")]), T, ON_BOARD)).toEqual([]);
  });
  test("a cure that did not clear the red by the next round opens the card, once", () => {
    const h = setup(); h.card("a", "m1");
    const s = sample([stuck("a", "offline")]);
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("cured");
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("skipped");
    expect(h.opened()).toHaveLength(1);
    expect(h.reassigned).toEqual(["a"]);
  });
  test("a cure that worked leaves no card", () => {
    const h = setup(); h.card("a", "m1");
    h.cures.run(sample([stuck("a", "offline")]), T, ON_BOARD);
    h.cures.run(sample(), T, ON_BOARD);
    expect(h.opened()).toHaveLength(0);
  });
  test("key mutation: two different problems are two cards, not one", () => {
    const h = setup(); h.card("x"); h.card("y");
    h.cures.run(sample([stuck("x", "memory"), stuck("y", "memory"), stuck("y", "resources")]), T, ON_BOARD);
    expect(h.opened()).toHaveLength(3);
    expect(new Set(problemsOf(sample([stuck("x", "memory"), stuck("y", "memory")]), T).map((p) => p.key)).size).toBe(2);
  });
  test("with no board chosen no card opens and nothing throws", () => {
    const h = setup(); h.card("m");
    expect(h.cures.run(sample([stuck("m", "memory")]), T, OFF)).toEqual([{ key: "memory:m", outcome: "off" }]);
    expect(h.opened()).toHaveLength(0);
  });
  test("the daily cap: the fourth problem opens no card and the line says so", () => {
    const h = setup();
    for (const id of ["1", "2", "3", "4"]) h.card(id);
    const out = h.cures.run(sample(["1", "2", "3", "4"].map((id) => stuck(id, "memory"))), T, ON_BOARD);
    expect(out.map((o) => o.outcome)).toEqual(["investigated", "investigated", "investigated", "capped"]);
    expect(h.opened()).toHaveLength(3);
    expect(h.lines("4").join(" ")).toContain("Tetto di 3");
  });
});

describe("chain-parked: no cure of its own, it is investigated", () => {
  test("the upstream card is still parked in backlog: it is investigated, no blocker is touched", () => {
    const h = setup(); h.card("root", null, "backlog"); h.card("a");
    h.db.run("UPDATE tasks SET blocked_by_task_id = 'root' WHERE id = 'a'");
    expect(h.cures.run(sample([stuck("a", "chain-parked")]), T, ON_BOARD)).toEqual([{ key: "chain-parked:a", outcome: "investigated" }]);
    expect(h.db.query("SELECT blocked_by_task_id AS b FROM tasks WHERE id = 'a'").get()).toEqual({ b: "root" });
  });
  test("the card's direct blocker is already done: nothing to cure here, `isDispatchBlocked` already clears it", () => {
    const h = setup(); h.card("root", null, "done"); h.card("a");
    h.db.run("UPDATE tasks SET blocked_by_task_id = 'root' WHERE id = 'a'");
    expect(h.cures.run(sample([stuck("a", "chain-parked")]), T, OFF)).toEqual([{ key: "chain-parked:a", outcome: "off" }]);
    expect(h.db.query("SELECT blocked_by_task_id AS b FROM tasks WHERE id = 'a'").get()).toEqual({ b: "root" });
  });
});

describe("unknown: a readable rule of two requeues then a park", () => {
  test("the first time, the card is requeued and says so", () => {
    const h = setup(); h.card("a", null, "in_progress");
    expect(h.cures.run(sample([stuck("a", "unknown")]), T, OFF)).toEqual([{ key: "unknown:a", outcome: "cured" }]);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'a'").get()).toEqual({ status: "todo" });
    expect(h.lines("a").join(" ")).toContain("giro 1 di 2");
  });
  test("after the cap of retries, it is parked to backlog with the reason instead of requeued again", () => {
    const h = setup(); h.card("a", null, "in_progress");
    for (let i = 0; i < UNKNOWN_RETRY_CAP; i++) {
      h.svc.addComment({ taskId: "a", author: "topics-check", content: `Rimessa in coda (giro ${i + 1} di ${UNKNOWN_RETRY_CAP}): x` });
    }
    expect(h.cures.run(sample([stuck("a", "unknown")]), T, OFF)).toEqual([{ key: "unknown:a", outcome: "cured" }]);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'a'").get()).toEqual({ status: "backlog" });
    expect(h.lines("a").join(" ")).toContain("serve un occhio umano");
  });
  test("a run still open is left alone", () => {
    const h = setup(); h.card("r", "m1", "in_progress", 1);
    expect(h.cures.run(sample([stuck("r", "unknown")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'r'").get()).toEqual({ status: "in_progress" });
  });
  test("a card bound to its node, with no run open, is left alone", () => {
    const h = setup(); h.card("r", "m1", "in_progress", 0);
    h.db.run("UPDATE tasks SET claude_task_id = 'node-run:1' WHERE id = 'r'");
    expect(h.cures.run(sample([stuck("r", "unknown")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'r'").get()).toEqual({ status: "in_progress" });
  });
  test("a card still in todo was never 'unknown': the sample's status does not decide, the fresh read does", () => {
    const h = setup(); h.card("t", null, "todo");
    h.cures.run(sample([stuck("t", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status, dispatch_error AS e FROM tasks WHERE id = 't'").get()).toEqual({ status: "todo", e: null });
  });
  test("a card already back in review is left alone: review is not in_progress", () => {
    const h = setup(); h.card("v", null, "review");
    h.cures.run(sample([stuck("v", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'v'").get()).toEqual({ status: "review" });
  });
  test("a card already done is left alone, no note", () => {
    const h = setup(); h.card("d", null, "done");
    h.cures.run(sample([stuck("d", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'd'").get()).toEqual({ status: "done" });
    expect(h.lines("d")).toEqual([]);
  });
  test("a live agent turn (dispatch_state) is left alone, even with no node run", () => {
    const h = setup(); h.card("w", null, "in_progress");
    h.db.run("UPDATE tasks SET dispatch_state = 'working' WHERE id = 'w'");
    h.cures.run(sample([stuck("w", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'w'").get()).toEqual({ status: "in_progress" });
  });
  test("an open question to a person is left alone", () => {
    const h = setup(); h.card("q", null, "in_progress");
    h.db.run("UPDATE tasks SET human_ask = 'conferma?' WHERE id = 'q'");
    h.cures.run(sample([stuck("q", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'q'").get()).toEqual({ status: "in_progress" });
  });
  test("the human_review stage is left alone", () => {
    const h = setup(); h.card("hr", null, "in_progress");
    h.db.run("UPDATE tasks SET stage = 'human_review' WHERE id = 'hr'");
    h.cures.run(sample([stuck("hr", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'hr'").get()).toEqual({ status: "in_progress" });
  });
  test("a card held by a person's name is left alone", () => {
    const h = setup(); h.card("p", null, "in_progress");
    h.db.run("UPDATE tasks SET assigned_to = 'someone' WHERE id = 'p'");
    h.cures.run(sample([stuck("p", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'p'").get()).toEqual({ status: "in_progress" });
  });
  test("a card pinned to a machine by a person is left alone", () => {
    const h = setup(); h.card("m1card", "m1", "in_progress", 0, false);
    expect(h.cures.run(sample([stuck("m1card", "unknown")]), T, OFF)).toEqual([{ key: "unknown:m1card", outcome: "off" }]);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'm1card'").get()).toEqual({ status: "in_progress" });
  });
  test("a card pinned 'stay local' by a person is left alone", () => {
    const h = setup(); h.card("sl", null, "in_progress");
    h.db.run("UPDATE tasks SET stay_local = 1 WHERE id = 'sl'");
    h.cures.run(sample([stuck("sl", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'sl'").get()).toEqual({ status: "in_progress" });
  });
  test("the park writes a dispatch_state, not a chip the board reads as a silent nothing", () => {
    const h = setup(); h.card("a", null, "in_progress");
    for (let i = 0; i < UNKNOWN_RETRY_CAP; i++) {
      h.svc.addComment({ taskId: "a", author: "topics-check", content: `Rimessa in coda (giro ${i + 1} di ${UNKNOWN_RETRY_CAP}): x` });
    }
    h.cures.run(sample([stuck("a", "unknown")]), T, OFF);
    expect(h.db.query("SELECT status, dispatch_state AS s FROM tasks WHERE id = 'a'").get()).toEqual({ status: "backlog", s: "stopped" });
  });
  test("a person putting the parked card back in todo resets the count: it gets fresh requeues again", () => {
    const h = setup(); h.card("a", null, "in_progress");
    for (let i = 0; i < UNKNOWN_RETRY_CAP; i++) {
      h.svc.addComment({ taskId: "a", author: "topics-check", content: `Rimessa in coda (giro ${i + 1} di ${UNKNOWN_RETRY_CAP}): x` });
    }
    h.db.run("UPDATE tasks SET status = 'in_progress' WHERE id = 'a'");
    h.db.run("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ev1', 'a', 'someone', 'backlog→todo', 'status', 'y')");
    expect(h.cures.run(sample([stuck("a", "unknown")]), T, OFF)).toEqual([{ key: "unknown:a", outcome: "cured" }]);
    expect(h.db.query("SELECT status FROM tasks WHERE id = 'a'").get()).toEqual({ status: "todo" });
    expect(h.lines("a").join(" ")).toContain("giro 1 di 2");
  });
  test("a →todo written by system, dispatcher or this cure itself does not reset the count: only a PERSON's hand does", () => {
    for (const author of ["system", "dispatcher", "topics-check"]) {
      const h = setup(); h.card("a", null, "in_progress");
      for (let i = 0; i < UNKNOWN_RETRY_CAP; i++) {
        h.svc.addComment({ taskId: "a", author: "topics-check", content: `Rimessa in coda (giro ${i + 1} di ${UNKNOWN_RETRY_CAP}): x` });
      }
      h.db.run("UPDATE tasks SET status = 'in_progress' WHERE id = 'a'");
      h.db.run("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('ev1', 'a', ?, 'backlog→todo', 'status', 'y')", [author]);
      expect(h.cures.run(sample([stuck("a", "unknown")]), T, OFF)).toEqual([{ key: "unknown:a", outcome: "cured" }]);
      expect(h.db.query("SELECT status FROM tasks WHERE id = 'a'").get()).toEqual({ status: "backlog" });
    }
  });
});

describe("the settings", () => {
  test("the investigation board is off by default, the cap is 3", () => {
    expect(parseSettings(null).investigation).toEqual({ boardId: null, perDay: 3 });
  });
  test("a chosen board and cap are read; nonsense falls back", () => {
    expect(parseSettings(JSON.stringify({ investigation: { boardId: "inv", perDay: 5 } })).investigation).toEqual({ boardId: "inv", perDay: 5 });
    expect(parseSettings(JSON.stringify({ investigation: { boardId: 7, perDay: -1 } })).investigation).toEqual({ boardId: null, perDay: 3 });
  });
});

describe("offline and seats: only queued cards, with the board's own settings", () => {
  test("a todo card with a run still open is not reassigned", () => {
    const h = setup(); h.card("r", "m1", "todo", 1);
    h.cures.run(sample([stuck("r", "offline")]), T, OFF);
    expect(h.reassigned).toEqual([]);
  });
  test("seats: a queued card on a machine is cured", () => {
    const h = setup(); h.card("s", "m1");
    expect(h.cures.run(sample([stuck("s", "seats")]), T, OFF)).toEqual([{ key: "seats:s", outcome: "cured" }]);
    expect(h.reassigned).toEqual(["s"]);
  });
  test("seats: a card with no machine has nothing to reassign", () => {
    const h = setup(); h.card("s");
    expect(h.cures.run(sample([stuck("s", "seats")]), T, OFF)).toEqual([{ key: "seats:s", outcome: "off" }]);
    expect(h.reassigned).toEqual([]);
    expect(h.lines("s")).toEqual([]);
  });
  test("the wiring hands the dispatcher the settings of the card's own board", () => {
    const seen: unknown[] = [];
    const published: string[] = [];
    const h = setup(); h.card("a", "m1");
    const deps = cureDepsOf(h.db, Object.assign(Object.create(h.svc), { getBoardSettings: (projectId: string) => ({ dispatchModel: `model-of-${projectId}` }) }), {
      reassignFromForbidden: (_t, settings) => { seen.push(settings); return true; },
      emitTask: (task) => published.push(task.id),
    });
    expect(deps.reassign(h.svc.get("a")!.task)).toBe(true);
    expect(seen).toEqual([{ dispatchModel: "model-of-work" }]);
    deps.emit(h.svc.get("a")!.task);
    expect(published).toEqual(["a"]);
  });
  test("a delegated or mirror card is bound to its node: no cure moves it", () => {
    const h = setup(); h.card("d", "m1"); h.card("m", "m1");
    h.db.run("UPDATE tasks SET delegated_start_capability_id = 'cap' WHERE id = 'd'");
    h.db.run("UPDATE tasks SET claude_task_id = 'node-run:1' WHERE id = 'm'");
    h.cures.run(sample([stuck("d", "offline"), stuck("m", "seats")], [...bounces("d"), ...bounces("m")]), T, OFF);
    expect(h.reassigned).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM tasks WHERE stay_local = 1").get()).toEqual({ n: 0 });
  });
  test("an archived card is left alone", () => {
    const h = setup(); h.card("z", "m1");
    h.db.run("UPDATE tasks SET archived = 1 WHERE id = 'z'");
    expect(h.cures.run(sample([stuck("z", "offline")], bounces("z")), T, ON_BOARD)).toEqual([]);
    expect(h.reassigned).toEqual([]);
  });
});

describe("a bounce", () => {
  test("a pin a person chose is not touched", () => {
    const h = setup(); h.card("p", "m1", "todo", 0, false);
    h.cures.run(sample([], bounces("p")), T, OFF);
    expect(h.db.query("SELECT machine_id, stay_local FROM tasks WHERE id = 'p'").get()).toEqual({ machine_id: "m1", stay_local: 0 });
    expect(h.emitted).toEqual([]);
  });
  test("a card already held here is neither updated nor written on", () => {
    const h = setup(); h.card("l", null);
    h.db.run("UPDATE tasks SET stay_local = 1 WHERE id = 'l'");
    expect(h.cures.run(sample([], bounces("l")), T, OFF)).toEqual([{ key: "bounce:l", outcome: "off" }]);
    expect(h.emitted).toEqual([]);
    expect(h.lines("l")).toEqual([]);
  });
  test("no new move since the cure: nothing more is asked of it", () => {
    const h = setup(); h.card("b", "m1");
    const moves = bounces("b");
    expect(h.cures.run(sample([], moves), T, ON_BOARD)[0]!.outcome).toBe("cured");
    NOW += 5 * 60_000;
    expect(h.cures.run(sample([], moves), T, ON_BOARD)).toEqual([]);
    expect(h.opened()).toHaveLength(0);
  });
  test("new moves after the cure: the cure did not work, so it is investigated", () => {
    const h = setup(); h.card("b", "m1");
    h.cures.run(sample([], bounces("b")), T, ON_BOARD);
    NOW += 5 * 60_000;
    expect(h.cures.run(sample([], bounces("b", NOW)), T, ON_BOARD)[0]!.outcome).toBe("investigated");
  });
});

describe("a hung node waits behind its open breaker", () => {
  test("a breaker that is open is a wait, never an investigation, however many cards and rounds", () => {
    const h = setup(); h.card("h1", "m1"); h.card("h2", "m1"); h.card("h3", "m1");
    const s = sample([stuck("h1", "hung-node"), stuck("h2", "hung-node"), stuck("h3", "hung-node")]);
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("cured");
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("skipped");
    expect(h.opened()).toHaveLength(0);
  });
  test("three rounds with the board off: failure() is called WAKE_FAIL_THRESHOLD times, no more", () => {
    const h = setup(); h.card("h", "m1");
    const breaker = createWakeBreaker("t", () => NOW);
    const spy: string[] = [];
    const counted = { failure: (id: string) => { spy.push(id); breaker.failure(id); }, isOpen: (id: string) => breaker.isOpen(id) };
    const counting = createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false, breaker: counted });
    counting.run(sample([stuck("h", "hung-node")]), T, OFF);
    expect(breaker.isOpen("m1")).toBe(true);
    for (let i = 0; i < 2; i++) counting.run(sample([stuck("h", "hung-node")]), T, OFF);
    expect(spy).toHaveLength(WAKE_FAIL_THRESHOLD);
    expect(breaker.isOpen("m1")).toBe(true);
  });
  test("a breaker already open before the first round: no failure call, no line, not cured", () => {
    const h = setup(); h.card("h", "m1");
    const failures: string[] = [];
    const cures = createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false, breaker: { failure: (id) => failures.push(id), isOpen: () => true } });
    expect(cures.run(sample([stuck("h", "hung-node")]), T, ON_BOARD)[0]!.outcome).not.toBe("cured");
    expect(failures).toEqual([]);
    expect(h.lines("h")).toEqual([]);
    expect(h.opened()).toHaveLength(0);
  });
});

describe("a restart forgets the memory, not the cards", () => {
  test("three starts on one database open one card and write one line", () => {
    const h = setup(); h.card("m");
    const start = () => createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    // Past the 10 s dedupe of a comment: only the database search keeps the second start from opening again.
    const outcomes = [start(), start(), start()].map((c) => { NOW += 15_000; return c.run(sample([stuck("m", "memory")]), T, { boardId: "inv", perDay: 1 })[0]!.outcome; });
    expect(outcomes).toEqual(["investigated", "skipped", "skipped"]);
    expect(h.opened()).toHaveLength(1);
    expect(h.lines("m").filter((l) => l.includes("Indagine aperta"))).toHaveLength(1);
    expect(h.lines("m").some((l) => l.includes("Tetto"))).toBe(false);
  });
  test("the cap line is written once a day across restarts", () => {
    const h = setup(); h.card("1"); h.card("2");
    const start = () => createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    const s = sample([stuck("1", "memory"), stuck("2", "memory")]);
    for (const c of [start(), start(), start()]) { NOW += 15_000; c.run(s, T, { boardId: "inv", perDay: 1 }); }
    expect(h.lines("2").filter((l) => l.includes("Tetto"))).toHaveLength(1);
    h.db.run("UPDATE tasks SET status = 'done' WHERE claude_task_id LIKE 'topics-check:%'");
    NOW += DAY;
    start().run(s, T, { boardId: "inv", perDay: 1 });
    expect(h.lines("2").filter((l) => l.includes("Tetto"))).toHaveLength(2);
  });
  test("a bounce cured by one instance is not convicted by the next one on the same database", () => {
    const h = setup(); h.card("b", "m1");
    const moves = bounces("b");
    const start = () => createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    expect(start().run(sample([], moves), T, ON_BOARD)[0]!.outcome).toBe("cured");
    NOW += 5 * 60_000;
    expect(start().run(sample([], moves), T, ON_BOARD)).toEqual([]);
    expect(h.opened()).toHaveLength(0);
    expect(h.lines("b").some((l) => l.includes("Indagine aperta"))).toBe(false);
  });
  test("a problem that lasts is one card across restarts on two days, while that card is open", () => {
    const h = setup(); h.card("m");
    const start = () => createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    const s = () => sample([stuck("m", "memory")]);
    expect(start().run(s(), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    NOW += DAY;
    expect(start().run(s(), T, ON_BOARD)[0]!.outcome).toBe("skipped");
    NOW += DAY;
    expect(start().run(s(), T, ON_BOARD)[0]!.outcome).toBe("skipped");
    expect(h.opened()).toHaveLength(1);
  });
});

describe("the daily cap counts today's cards on the chosen board", () => {
  const insertCard = (h: ReturnType<typeof setup>, id: string, board: string, at: number, key: string) =>
    h.db.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, claude_task_id) VALUES (?, ?, 't', 'backlog', ?, 'x', ?)").run(id, board, new Date(at).toISOString(), key);
  test("three cards of yesterday leave today's cap free", () => {
    const h = setup(); h.card("m");
    for (const i of [1, 2, 3]) insertCard(h, `y${i}`, "inv", NOW - DAY, `topics-check:old:${i}`);
    expect(h.cures.run(sample([stuck("m", "memory")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
  });
  test("three cards of today on another board leave this board's cap free", () => {
    const h = setup(); h.card("m");
    for (const i of [1, 2, 3]) insertCard(h, `o${i}`, "other", NOW, `topics-check:d:${i}`);
    expect(h.cures.run(sample([stuck("m", "memory")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
  });
  test("the suite does not depend on the day it runs", () => {
    const h = setup(); h.card("m");
    NOW += 400 * DAY;
    expect(h.cures.run(sample([stuck("m", "memory")]), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.cures.run(sample([stuck("m", "memory")]), T, ON_BOARD)[0]!.outcome).toBe("skipped");
  });
});

describe("the state kept between rounds", () => {
  test("a problem that went away for a round and came back is cured again", () => {
    const h = setup(); h.card("a", "m1");
    const s = sample([stuck("a", "offline")]);
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("cured");
    h.cures.run(sample(), T, ON_BOARD);
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("cured");
    expect(h.reassigned).toEqual(["a", "a"]);
  });
  test("the board off: cured, then off, then cured again", () => {
    const h = setup(); h.card("a", "m1");
    const s = sample([stuck("a", "offline")]);
    expect(h.cures.run(s, T, OFF)[0]!.outcome).toBe("cured");
    expect(h.cures.run(s, T, OFF)[0]!.outcome).toBe("off");
    expect(h.cures.run(s, T, OFF)[0]!.outcome).toBe("cured");
  });
  test("a board chosen after an off round is used, not skipped", () => {
    const h = setup(); h.card("m");
    const s = sample([stuck("m", "memory")]);
    expect(h.cures.run(s, T, OFF)[0]!.outcome).toBe("off");
    expect(h.cures.run(s, T, ON_BOARD)[0]!.outcome).toBe("investigated");
  });
  test("investigated, gone for a round, back the next day with the card still open: no second card", () => {
    const h = setup(); h.card("m");
    const s = () => sample([stuck("m", "memory")]);
    expect(h.cures.run(s(), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    h.cures.run(sample(), T, ON_BOARD);
    NOW += DAY;
    expect(h.cures.run(s(), T, ON_BOARD)[0]!.outcome).toBe("skipped");
    expect(h.opened()).toHaveLength(1);
  });
  test("the investigation card was closed and the problem lasts: it is asked again the next day", () => {
    const h = setup(); h.card("m");
    const s = () => sample([stuck("m", "memory")]);
    h.cures.run(s(), T, ON_BOARD);
    h.db.run("UPDATE tasks SET status = 'done' WHERE claude_task_id LIKE 'topics-check:%'");
    expect(h.cures.run(s(), T, ON_BOARD)[0]!.outcome).toBe("skipped");
    NOW += DAY;
    expect(h.cures.run(s(), T, ON_BOARD)[0]!.outcome).toBe("investigated");
    expect(h.opened()).toHaveLength(2);
  });
});

describe("what the view says", () => {
  test("the cures' report is kept on the sample and shown with its keys", async () => {
    const h = setup();
    const round = createTopicsCheck({
      db: h.db, now: () => NOW,
      settings: () => ({ ...parseSettings(null), checks: [], investigation: ON_BOARD }),
      cure: () => [{ key: "offline:a", outcome: "cured" }, { key: "memory:m", outcome: "investigated" }, { key: "memory:n", outcome: "capped" }, { key: "x", outcome: "skipped" }],
    });
    await round.tick();
    expect(round.current().cures).toEqual({ cured: ["offline:a"], investigated: ["memory:m"], capped: ["memory:n"] });
  });
  test("the cap stays in the view on the round after it was reached, with the real cures", async () => {
    const h = setup(); h.card("1"); h.card("2");
    const cures = createCures({ db: h.db, svc: h.svc, now: () => NOW, emit: () => {}, reassign: () => false });
    const s = sample([stuck("1", "memory"), stuck("2", "memory")]);
    const round = createTopicsCheck({
      db: h.db, now: () => NOW,
      settings: () => ({ ...parseSettings(null), checks: [], investigation: { boardId: "inv", perDay: 1 } }),
      cure: (_sample, settings) => cures.run(s, settings.thresholds, settings.investigation),
    });
    await round.tick();
    NOW += 5 * 60_000;
    await round.tick();
    expect(round.current().cures.capped).toEqual(["memory:2"]);
  });
  test("summarizeCures leaves out what did nothing", () => {
    expect(summarizeCures([{ key: "a", outcome: "off" }, { key: "b", outcome: "skipped" }])).toEqual({ cured: [], investigated: [], capped: [] });
    expect(summarizeCures()).toEqual({ cured: [], investigated: [], capped: [] });
  });
});

describe("the daily reading's card", () => {
  test("it opens in backlog under the investigation prefix, goes to the views, and counts in the day's cap", () => {
    const h = setup();
    const r = h.cures.openDaily(ON_BOARD, "Topics check: x", "body");
    expect(r.outcome).toBe("opened");
    const row = h.db.query("SELECT status, claude_task_id AS cid FROM tasks WHERE id = ?").get(r.cardId!) as { status: string; cid: string };
    expect(row.status).toBe("backlog");
    expect(row.cid).toStartWith("topics-check:");
    expect(h.emitted).toContain(r.cardId!);
    // Two more investigations fill the cap of 3; the daily card is the first of them.
    h.card("a"); h.card("b"); h.card("c");
    h.cures.run(sample([stuck("a", "attempts"), stuck("b", "spend"), stuck("c", "no-project")]), T, ON_BOARD);
    expect(h.opened().length).toBe(3);
  });

  test("a full cap or no board opens nothing", () => {
    const h = setup();
    expect(h.cures.openDaily(OFF, "t", "b")).toEqual({ outcome: "off", cardId: null });
    h.cures.openDaily({ boardId: "inv", perDay: 1 }, "t", "b");
    expect(h.cures.openDaily({ boardId: "inv", perDay: 1 }, "t2", "b")).toEqual({ outcome: "capped", cardId: null });
  });
});
