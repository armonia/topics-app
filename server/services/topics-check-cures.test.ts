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
import { createCures, problemsOf } from "./topics-check-cures";
import { DEFAULT_THRESHOLDS, parseSettings, type Sample, type StuckCard } from "./topics-check";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const T = DEFAULT_THRESHOLDS;
const SCHEMA = (() => {
  const d = new Database(":memory:");
  for (const m of EMBEDDED_MIGRATIONS) d.run(m.sql);
  return d.serialize();
})();

function setup(opts: { reassign?: boolean } = {}) {
  const db = Database.deserialize(SCHEMA);
  db.run("PRAGMA foreign_keys = OFF");
  const svc = createTaskService(db);
  const card = (id: string, machineId: string | null = null, status = "todo", runOpen = 0) => {
    db.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, machine_id, node_run_open) VALUES (?, 'work', 'c', ?, 'x', 'x', ?, ?)").run(id, status, machineId, runOpen);
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
const bounces = (id: string) => Array.from({ length: 4 }, (_, i) => ({ id, at: NOW - i * 60_000, to: "n1", silent: false }));

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
    h.cures.run(sample([], bounces("b")), T, ON_BOARD);
    expect(h.opened()[0]!.text).toContain("rimbalza");
  });
  test("a capped problem is asked again the next day, and says so only once a day", () => {
    let day = NOW;
    const h = setup(); h.card("1"); h.card("2");
    const db = h.db;
    const cures = createCures({ db, svc: h.svc, now: () => day, emit: () => {}, reassign: () => false });
    const s = sample([stuck("1", "memory"), stuck("2", "memory")]);
    const one = { boardId: "inv", perDay: 1 };
    expect(cures.run(s, T, one).map((o) => o.outcome)).toEqual(["investigated", "capped"]);
    expect(cures.run(s, T, one).map((o) => o.outcome)).toEqual(["skipped", "skipped"]);
    expect(h.lines("2")).toHaveLength(1);
    day += 24 * 3_600_000;
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

describe("the settings", () => {
  test("the investigation board is off by default, the cap is 3", () => {
    expect(parseSettings(null).investigation).toEqual({ boardId: null, perDay: 3 });
  });
  test("a chosen board and cap are read; nonsense falls back", () => {
    expect(parseSettings(JSON.stringify({ investigation: { boardId: "inv", perDay: 5 } })).investigation).toEqual({ boardId: "inv", perDay: 5 });
    expect(parseSettings(JSON.stringify({ investigation: { boardId: 7, perDay: -1 } })).investigation).toEqual({ boardId: null, perDay: 3 });
  });
});
