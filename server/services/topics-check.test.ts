/**
 * The self-check round: the cases of 21/11 each give their voice red with its
 * number, every threshold has its mutation, the proofs are configuration, and
 * 24 hours of rounds call no model.
 *
 * @covers CHECK-01
 * @covers CHECK-02
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createTasksShared } from "./tasks/shared";
import { setDispatchBlock } from "./dispatch-block-signal";
import { PLAN_SPENT_NOTE } from "./task-dispatcher-support";
import {
  createTopicsCheck, DEFAULT_THRESHOLDS, MOVES_SQL, PARKED_EVENTS_SQL, QUEUE_MOVED_SQL, READ_SAMPLES_SQL, THREADS_SQL, parseSettings, readSamples, roundState, runProofs, sampleTopics, voices,
  SAMPLE_INTERVAL_MS, type Sample, type TopicsCheckSettings,
} from "./topics-check";

const PID = "p1";
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const noSettings = parseSettings(null);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, missing: false };

/** The schema the shipped app builds: the whole migration chain, run once and copied for each test. */
const SCHEMA = (() => {
  const d = new Database(":memory:");
  for (const m of EMBEDDED_MIGRATIONS) d.run(m.sql);
  return d.serialize();
})();
function db(): Database {
  const d = Database.deserialize(SCHEMA);
  d.run("PRAGMA foreign_keys = ON");
  d.run("UPDATE app_settings SET auto_dispatch = 1");
  d.run(`INSERT INTO board_settings (project_id) VALUES ('${PID}')`);
  return d;
}
function machine(d: Database, id: string, status: "online" | "offline", slots: number | null, heartbeat = "x") {
  d.run(`INSERT OR REPLACE INTO machines (id, name, hostname, arch, platform, daemon_version, status, slots, last_heartbeat_at, last_seen_at, created_at, updated_at)
    VALUES ('${id}', '${id}', '${id}', 'x', 'x', '1', '${status}', ${slots}, '${heartbeat}', 'x', 'x', 'x')`);
}
/** Overwrites columns of a card the helper above made. */
function set(d: Database, id: string, cols: Record<string, string | number | null>) {
  for (const [k, v] of Object.entries(cols)) d.query(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, id);
}
function card(d: Database, id: string, status: string, ageMs: number, extra: { humanAsk?: string; machineId?: string; dispatchState?: string; nodeRunOpen?: boolean; dispatchError?: string; deferredUntil?: string; attempts?: number; blockedBy?: string } = {}) {
  d.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, human_ask, machine_id, dispatch_state, node_run_open, dispatch_error, dispatch_deferred_until, dispatch_attempts, blocked_by_task_id) VALUES (?, ?, 'c', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, PID, status, iso(NOW - ageMs), iso(NOW - ageMs), extra.humanAsk ?? null, extra.machineId ?? null, extra.dispatchState ?? null, extra.nodeRunOpen ? 1 : 0,
      extra.dispatchError ?? null, extra.deferredUntil ?? null, extra.attempts ?? 0, extra.blockedBy ?? null);
}
/** A todo card the dispatcher gave up on: stuck for a reason of its own, not a queue that is moving. */
const GIVEN_UP = { attempts: 2 };
/** `n` "moved to" notes on a card, spread over `spanMs` ending now. */
function moved(d: Database, taskId: string, n: number, spanMs: number, to: string) {
  for (let i = 0; i < n; i++) {
    d.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?, ?, 'system', ?, ?)")
      .run(`${taskId}-${i}-${to}`, taskId, `Spostata su ${to}: c'era un posto libero lì.`, iso(NOW - spanMs + (spanMs * i) / Math.max(1, n - 1)));
  }
}
const sample = (at: number, p: Partial<Sample> = {}): Sample => ({ at, todo: 0, machines: [], stuck: [], moves: [], ...p });
const cards = (s: Sample[], st: TopicsCheckSettings = noSettings) => voices(s, st)[0]!;
const seats = (s: Sample[], st: TopicsCheckSettings = noSettings) => voices(s, st)[1]!;
const proofs = (s: Sample[], st: TopicsCheckSettings = noSettings) => voices(s, st)[2]!;

describe("seats voice", () => {
  /** Twelve hours of samples, 5 minutes apart; the node promised 4 seats and gave 0 for the last `lostSamples` of them. */
  const twelveHours = (lostSamples: number): Sample[] =>
    Array.from({ length: 144 }, (_, i) => sample(NOW - (143 - i) * SAMPLE_INTERVAL_MS, {
      todo: 3, machines: [{ id: "n1", name: "n1", online: true, slots: i < 144 - lostSamples ? 4 : 0, cards: 0, heartbeatAt: 0 }],
    }));

  test("a node that went from 4 seats to 0 for 9 hours of 12 is red with «9 h»", () => {
    const v = seats(twelveHours(108));
    expect(v.red).toBe(true);
    expect(v.detail).toBe("9 h su 12 h");
    expect(v.cause).toContain("ne dà 0");
  });
  test("threshold mutation: 0.9 h lost is green, 1 h is red", () => {
    expect(seats(twelveHours(11)).red).toBe(false);
    expect(seats(twelveHours(12)).red).toBe(true);
  });
  test("window mutation: the 12 h window keeps its edge and drops what is older", () => {
    // 12 lost samples at the oldest end of a 12 h series: all inside the window, red with exactly 1 h.
    const edge = twelveHours(0).map((s, i) => (i < 12 ? { ...s, machines: [{ ...s.machines[0]!, slots: 0 }] } : s));
    expect(seats(edge).detail).toBe("1 h su 12 h");
    // One of them one interval older, at exactly 12 h: outside, so only 11 count and it is green.
    const older = [sample(NOW - 144 * SAMPLE_INTERVAL_MS, { todo: 3, machines: [{ id: "n1", name: "n1", online: true, slots: 0, cards: 0, heartbeatAt: 0 }] }), ...edge.slice(1, 12).map((s) => ({ ...s })), ...edge.slice(12)];
    expect(seats(older).red).toBe(false);
  });
  test("no queue, no lost hours", () => {
    expect(seats(twelveHours(108).map((s) => ({ ...s, todo: 0 }))).red).toBe(false);
  });
  test("an off node that cards are pinned to is red with its own cause", () => {
    const s = Array.from({ length: 24 }, (_, i) => sample(NOW - i * SAMPLE_INTERVAL_MS, { todo: 1, machines: [{ id: "n1", name: "n1", online: false, slots: 4, cards: 2, heartbeatAt: 0 }] }));
    expect(seats(s).cause).toContain("spento");
  });
});

describe("cards voice", () => {
  test("27 moves toward an off machine in 24 h: red, «27 rimbalzi»", () => {
    const d = db();
    machine(d, "pc", "offline", 4);
    for (let i = 0; i < 27; i++) { card(d, `c${i}`, "done", H); moved(d, `c${i}`, 1, 1000, "pc"); }
    const v = cards([sampleTopics(d, NOW)]);
    expect(v.red).toBe(true);
    expect(v.detail).toContain("27 rimbalzi");
    expect(v.cause).toContain("spenta");
  });
  test("a card waiting for a person for 2 days with no turn: red, named cause", () => {
    const d = db();
    card(d, "w", "in_progress", 48 * H, { humanAsk: "which one?" });
    const v = cards([sampleTopics(d, NOW)]);
    expect(v.red).toBe(true);
    expect(v.cause).toBe("in attesa di una persona");
    expect(v.hoursLost).toBeCloseTo(48, 0);
  });
  test("11 runs of one card in 35 minutes: red, bounces", () => {
    const d = db();
    card(d, "b", "in_progress", 10 * 60_000);
    moved(d, "b", 11, 35 * 60_000, "n1");
    const v = cards([sampleTopics(d, NOW)]);
    expect(v.red).toBe(true);
    expect(v.detail).toContain("rimbalzi");
  });
  test("threshold mutation: 3 moves of a card in an hour is green, 4 is red", () => {
    const green = db(); card(green, "b", "done", H); moved(green, "b", 3, 30 * 60_000, "n1");
    const red = db(); card(red, "b", "done", H); moved(red, "b", 4, 30 * 60_000, "n1");
    expect(cards([sampleTopics(green, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(red, NOW)]).red).toBe(true);
  });
  test("threshold mutation: a card in progress idle 1 h 59 is green, 2 h is red", () => {
    const a = db(); card(a, "p", "in_progress", 2 * H - 60_000);
    const b = db(); card(b, "p", "in_progress", 2 * H);
    expect(cards([sampleTopics(a, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(b, NOW)]).red).toBe(true);
  });
  test("a card in progress idle 2.5 h is red", () => {
    const d = db(); card(d, "p", "in_progress", 2.5 * H);
    expect(cards([sampleTopics(d, NOW)]).red).toBe(true);
  });
  test("threshold mutation: a todo card waiting 59 min is green, 1 h is red", () => {
    const a = db(); card(a, "t", "todo", H - 60_000, GIVEN_UP);
    const b = db(); card(b, "t", "todo", H, GIVEN_UP);
    expect(cards([sampleTopics(a, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(b, NOW)]).red).toBe(true);
  });
  test("window mutation: 4 moves of a card inside 59 min are red, spread over 60 min green", () => {
    const red = db(); card(red, "b", "done", H); moved(red, "b", 4, 59 * 60_000, "n1");
    const green = db(); card(green, "b", "done", H); moved(green, "b", 4, 60 * 60_000, "n1");
    expect(cards([sampleTopics(red, NOW)]).red).toBe(true);
    expect(cards([sampleTopics(green, NOW)]).red).toBe(false);
  });
  test("4 moves of a card in 59.5 minutes are red", () => {
    const d = db(); card(d, "b", "done", H); moved(d, "b", 4, 59.5 * 60_000, "n1");
    expect(cards([sampleTopics(d, NOW)]).red).toBe(true);
  });
  /** `n` cards, one move each, to the machine `to`. */
  const spread = (d: Database, n: number, to: string) => {
    for (let i = 0; i < n; i++) { card(d, `${to}${i}`, "done", H); moved(d, `${to}${i}`, 1, 1000, to); }
  };
  test("threshold mutation: 9 moves toward an off machine are green, 10 red", () => {
    const a = db(); machine(a, "pc", "offline", 4); spread(a, 9, "pc");
    const b = db(); machine(b, "pc", "offline", 4); spread(b, 10, "pc");
    expect(cards([sampleTopics(a, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(b, NOW)]).detail).toBe("10 rimbalzi: 2.5 h perse");
  });
  test("10 healthy overflows in a day, to machines that answer, are green", () => {
    const d = db(); machine(d, "mac2", "online", 4, iso(NOW)); spread(d, 10, "mac2");
    expect(cards([sampleTopics(d, NOW)]).red).toBe(false);
  });
  test("moves toward a machine that had not beaten since before them are silent", () => {
    const d = db(); machine(d, "pc", "offline", 4, iso(NOW - 3 * H)); spread(d, 1, "pc");
    expect(sampleTopics(d, NOW).moves[0]?.silent).toBe(true);
    const e = db(); machine(e, "pc", "offline", 4, iso(NOW + 1000)); spread(e, 1, "pc");
    expect(sampleTopics(e, NOW).moves[0]?.silent).toBe(false);
  });
  test("a card with a turn in flight is not stuck, however quiet", () => {
    const a = db(); card(a, "w", "in_progress", 3 * H, { dispatchState: "working" });
    const b = db(); card(b, "r", "in_progress", 3 * H, { nodeRunOpen: true });
    const c = db(); card(c, "q", "in_progress", 3 * H);
    expect(cards([sampleTopics(a, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(b, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(c, NOW)]).red).toBe(true);
  });
  test("a todo card is not stuck when the machine switch is off or its board is paused", () => {
    const off = db();
    off.run("UPDATE app_settings SET auto_dispatch = 0");
    card(off, "t", "todo", 5 * H, GIVEN_UP);
    const paused = db();
    paused.run("UPDATE board_settings SET dispatch_paused = 1");
    card(paused, "t", "todo", 5 * H, GIVEN_UP);
    const live = db();
    card(live, "t", "todo", 5 * H, GIVEN_UP);
    expect(cards([sampleTopics(off, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(paused, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(live, NOW)]).red).toBe(true);
  });
  test("a card held by the memory floor reads dispatch_error and names the memory cause", () => {
    const d = db();
    card(d, "m1", "todo", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    card(d, "m2", "in_progress", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    const s = sampleTopics(d, NOW);
    expect(s.stuck.map((c) => c.cause)).toEqual(["memory", "memory"]);
    expect(cards([s]).cause).toBe("il pavimento di memoria tiene ferma la coda");
  });
  test("chosen waits and a moving queue are not hours lost", () => {
    const d = db();
    // A card started ten minutes ago: the queue is moving.
    card(d, "dep", "in_progress", 0, { dispatchState: "working" });
    set(d, "dep", { in_progress_at: iso(NOW - 10 * 60_000) });
    card(d, "later", "todo", 5 * H, { dispatchState: "waiting", deferredUntil: iso(NOW + H) });
    card(d, "blocked", "todo", 5 * H, { blockedBy: "dep" });
    card(d, "queued", "todo", 5 * H);
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
    card(d, "gave-up", "todo", 5 * H, GIVEN_UP);
    expect(sampleTopics(d, NOW).stuck.map((c) => c.id)).toEqual(["gave-up"]);
  });
  test("a slot wait is lost hours when no card started inside the window (point 2)", () => {
    const stale = db(); card(stale, "q", "todo", 5 * H);
    expect(sampleTopics(stale, NOW).stuck.map((c) => c.id)).toEqual(["q"]);
    // The window edge: a start exactly queueMovedHours ago still counts as moving, one ms older does not.
    const edge = db(); card(edge, "q", "todo", 5 * H); card(edge, "s", "in_progress", 0, { dispatchState: "working" });
    set(edge, "s", { in_progress_at: iso(NOW - H) });
    expect(sampleTopics(edge, NOW).stuck).toEqual([]);
    set(edge, "s", { in_progress_at: iso(NOW - H - 1) });
    expect(sampleTopics(edge, NOW).stuck.map((c) => c.id)).toEqual(["q"]);
  });
  test("noSeats: the local row alone never says it, an off remote or a remote with 0 seats does (point 2)", () => {
    const at = (d: Database) => sampleTopics(d, NOW, DEFAULT_THRESHOLDS, "me").stuck[0]!.cause;
    const local = db(); machine(local, "me", "online", null); card(local, "q", "todo", 5 * H);
    expect(at(local)).toBe("unknown");
    const off = db(); machine(off, "me", "online", null); machine(off, "pc", "offline", 4); card(off, "q", "todo", 5 * H);
    expect(at(off)).toBe("seats");
    const zero = db(); machine(zero, "me", "online", null); machine(zero, "pc", "online", 0); card(zero, "q", "todo", 5 * H);
    expect(at(zero)).toBe("seats");
    const some = db(); machine(some, "me", "online", null); machine(some, "pc", "online", 4); card(some, "q", "todo", 5 * H);
    expect(at(some)).toBe("unknown");
  });
  test("a todo card with an open run left by buryRun is still seen, and pinned to an off node it is offline (point 3)", () => {
    const d = db(); machine(d, "pc", "offline", 4);
    card(d, "b", "todo", 3 * H, { machineId: "pc", nodeRunOpen: true });
    expect(sampleTopics(d, NOW).stuck.map((c) => c.cause)).toEqual(["offline"]);
  });
  test("a long healthy turn on a node is not hung; a silent node or a failing poll is (point 4)", () => {
    const beat = (minAgo: number) => {
      const d = db(); machine(d, "pc", "online", 4, iso(NOW - minAgo * 60_000));
      card(d, "h", "in_progress", 3 * H, { machineId: "pc", nodeRunOpen: true, dispatchState: "working" });
      return d;
    };
    expect(sampleTopics(beat(1), NOW).stuck).toEqual([]);
    expect(sampleTopics(beat(14.9), NOW).stuck).toEqual([]);
    expect(sampleTopics(beat(15), NOW).stuck.map((c) => c.cause)).toEqual(["hung-node"]);
    const poll = db(); machine(poll, "pc", "online", 4, iso(NOW));
    card(poll, "h", "in_progress", 3 * H, { machineId: "pc", nodeRunOpen: true, dispatchError: "node_unreachable" });
    expect(sampleTopics(poll, NOW).stuck.map((c) => c.cause)).toEqual(["hung-node"]);
  });
  test("subcards of a parent at work are not lost; those of an idle parent are (point 5)", () => {
    const d = db();
    card(d, "p", "in_progress", 0, { dispatchState: "working" });
    card(d, "kid", "todo", 5 * H);
    set(d, "kid", { parent_task_id: "p" });
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
    set(d, "p", { dispatch_state: null, status: "review" });
    expect(sampleTopics(d, NOW).stuck.map((c) => c.id)).toEqual(["kid"]);
  });
  test("an old waiting-memory loses to a blocker and to a plan; it counts only queued with no blocker (point 7)", () => {
    const d = db();
    card(d, "dep", "in_progress", 0, { dispatchState: "working" });
    set(d, "dep", { in_progress_at: iso(NOW - 60_000) });
    card(d, "blk", "todo", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory", blockedBy: "dep" });
    card(d, "plan", "todo", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    set(d, "plan", { scheduled_by: "cron", scheduled_at: iso(NOW + H) });
    card(d, "idle", "todo", 3 * H, { dispatchState: "waiting", dispatchError: "waiting-memory" });
    card(d, "held", "todo", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    expect(sampleTopics(d, NOW).stuck.filter((c) => c.cause === "memory").map((c) => c.id)).toEqual(["held"]);
  });
  test("an in-progress card with a waiting chip is a left-over chip, not a wait (point 8)", () => {
    const d = db(); card(d, "w", "in_progress", 5 * H, { dispatchState: "waiting" });
    expect(sampleTopics(d, NOW).stuck.map((c) => c.id)).toEqual(["w"]);
  });
  test("a planned run past its time with no run is lost; a future one is not (point 9)", () => {
    const d = db();
    card(d, "late", "todo", 9 * H); set(d, "late", { scheduled_by: "cron", scheduled_at: iso(NOW - 3 * H) });
    card(d, "soon", "todo", 9 * H); set(d, "soon", { scheduled_by: "cron", scheduled_at: iso(NOW + H) });
    const s = sampleTopics(d, NOW);
    expect(s.stuck.map((c) => c.id)).toEqual(["late"]);
    expect(s.stuck[0]!.hours).toBeCloseTo(3, 1);
  });
  test("a chain held by a card parked in backlog is lost, down the whole chain (point 10)", () => {
    const d = db();
    card(d, "root", "backlog", 9 * H, { dispatchError: "boom" });
    card(d, "mid", "todo", 5 * H, { blockedBy: "root" });
    card(d, "leaf", "todo", 5 * H, { blockedBy: "mid" });
    expect(sampleTopics(d, NOW).stuck.map((c) => [c.id, c.cause])).toEqual([["mid", "chain-parked"], ["leaf", "chain-parked"]]);
    const live = db();
    card(live, "root", "in_progress", 0, { dispatchState: "working" });
    set(live, "root", { in_progress_at: iso(NOW - 60_000) });
    card(live, "kid", "todo", 5 * H, { blockedBy: "root" });
    expect(sampleTopics(live, NOW).stuck).toEqual([]);
  });
  test("age counts from entering todo or the end of a deferral, not from the last write (point 11)", () => {
    const d = db(); card(d, "t", "todo", 5 * H, GIVEN_UP);
    set(d, "t", { updated_at: iso(NOW - 60_000) });
    expect(sampleTopics(d, NOW).stuck[0]!.hours).toBeCloseTo(5, 1);
    set(d, "t", { dispatch_deferred_until: iso(NOW - 2 * H) });
    expect(sampleTopics(d, NOW).stuck[0]!.hours).toBeCloseTo(2, 1);
    // A dispatcher note does not reset the age of a card in progress either.
    const p = db(); card(p, "p", "in_progress", 4 * H);
    p.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES ('n', 'p', 'system', 'note', ?)").run(iso(NOW - 60_000));
    expect(sampleTopics(p, NOW).stuck[0]!.hours).toBeCloseTo(4, 1);
  });
  test("a scheduled card with no time yet does not crash the round, and is not lost (point 12, null reason)", () => {
    const d = db(); card(d, "s", "todo", 5 * H); set(d, "s", { scheduled_by: "cron" });
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
  });
  test("a todo card waiting on a person is counted even when its queue wait is chosen (point 12)", () => {
    const d = db(); card(d, "later", "todo", 5 * H, { humanAsk: "which?", dispatchState: "waiting", deferredUntil: iso(NOW - 2 * H) });
    expect(sampleTopics(d, NOW).stuck.map((c) => c.cause)).toEqual(["person"]);
  });
  test("a plain queue behind a fleet with no seats is still lost time", () => {
    const d = db(); machine(d, "pc", "offline", 0); card(d, "q", "todo", 5 * H);
    expect(sampleTopics(d, NOW).stuck.map((c) => c.cause)).toEqual(["seats"]);
  });
  test("a node that is up but took the run and went quiet is a hung node", () => {
    const d = db(); machine(d, "pc", "online", 4);
    card(d, "h1", "in_progress", 3 * H, { machineId: "pc", nodeRunOpen: true, dispatchState: "working" });
    card(d, "h2", "todo", 3 * H, { machineId: "pc", dispatchError: "node_unreachable" });
    const s = sampleTopics(d, NOW);
    expect(s.stuck.map((c) => c.cause)).toEqual(["hung-node", "hung-node"]);
    expect(cards([s]).cause).toContain("appeso");
    // A recent run on the same node is just working.
    const e = db(); machine(e, "pc", "online", 4);
    card(e, "w", "in_progress", H, { machineId: "pc", nodeRunOpen: true });
    expect(sampleTopics(e, NOW).stuck).toEqual([]);
  });
  test("the settings move a threshold, and garbage falls back to the defaults", () => {
    const d = db(); card(d, "p", "in_progress", 3 * H);
    const s = parseSettings(JSON.stringify({ thresholds: { progressStuckHours: 5 } }));
    expect(cards([sampleTopics(d, NOW, s.thresholds)], s).red).toBe(false);
    expect(parseSettings("not json").thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("the board's states, as the dispatcher writes them (second review, points A-H)", () => {
  /** A status event in the thread, as the service writes it on every move. */
  const statusEvent = (d: Database, taskId: string, content: string, at: number) =>
    d.query("INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, 'system', ?, ?, 'status')").run(`${taskId}-${at}`, taskId, content, iso(at));
  const note = (d: Database, taskId: string, author: string, content: string, at: number) =>
    d.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)").run(`${taskId}-${author}-${at}`, taskId, author, content, iso(at));
  const causes = (d: Database) => sampleTopics(d, NOW).stuck.map((c) => [c.id, c.cause]);
  /** A card that started a minute ago: the queue is moving. */
  const moving = (d: Database) => { card(d, "run", "in_progress", 0, { dispatchState: "working" }); set(d, "run", { in_progress_at: iso(NOW - 60_000) }); };

  test("A: the test schema is the shipped one, so the board reads a real reason and never «unknown»", () => {
    const d = db(); card(d, "q", "todo", 5 * H);
    const shared = createTasksShared(d, {});
    const rows = d.query("SELECT * FROM tasks").all() as any[];
    const batch = shared.buildBatch(rows, { reasonsOnly: true });
    expect(batch.queueReadable).toBe(true);
    expect(shared.queueReasonOf(rows[0], batch)?.kind).toBe("slot");
  });
  test("B: whether the queue moved is read through an index, not a scan of every task", () => {
    const plan = (db().query(`EXPLAIN QUERY PLAN ${QUEUE_MOVED_SQL}`).all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/SEARCH tasks USING (COVERING )?INDEX idx_tasks_in_progress_at/);
    expect(plan).not.toMatch(/SCAN tasks/);
  });
  test("C: the chain stops at the card parked in backlog, even when that card's own blocker has closed", () => {
    const d = db();
    card(d, "gone", "done", 20 * H);
    card(d, "parked", "backlog", 9 * H, { blockedBy: "gone" });
    card(d, "mid", "todo", 5 * H, { blockedBy: "parked" });
    card(d, "leaf", "todo", 5 * H, { blockedBy: "mid" });
    expect(causes(d)).toEqual([["mid", "chain-parked"], ["leaf", "chain-parked"]]);
  });
  test("D: a todo card is as old as its last entry into todo, not its creation", () => {
    const d = db(); card(d, "t", "todo", 99 * H, GIVEN_UP);
    statusEvent(d, "t", "todo→in_progress", NOW - 50 * H);
    statusEvent(d, "t", "in_progress→todo · the agent stopped", NOW - 11 * H);
    expect(sampleTopics(d, NOW).stuck[0]!.hours).toBeCloseTo(11, 1);
    // A move toward another column is not an entry into todo.
    statusEvent(d, "t", "todo→backlog", NOW - 2 * H);
    expect(sampleTopics(d, NOW).stuck[0]!.hours).toBeCloseTo(11, 1);
  });
  test("D/E: a node that went off defers its card 5 minutes at a time; the age is the whole series and the cause is offline", () => {
    const d = db(); machine(d, "pc", "offline", 4, iso(NOW - 3 * H));
    card(d, "t", "todo", 9 * H, { machineId: "pc", dispatchState: "waiting", dispatchError: "node_unreachable", deferredUntil: iso(NOW + 5 * 60_000) });
    set(d, "t", { wait_since: iso(NOW - 3 * H), wait_source: "machine" });
    const s = sampleTopics(d, NOW);
    expect(s.stuck.map((c) => c.cause)).toEqual(["offline"]);
    expect(s.stuck[0]!.hours).toBeCloseTo(3, 1);
  });
  test("E: an open run on a node that went off is offline, counted from the node's last beat", () => {
    const d = db(); machine(d, "pc", "offline", 4, iso(NOW - 4 * H));
    card(d, "r", "in_progress", 9 * H, { machineId: "pc", nodeRunOpen: true, dispatchState: "working" });
    const s = sampleTopics(d, NOW);
    expect(s.stuck.map((c) => c.cause)).toEqual(["offline"]);
    expect(s.stuck[0]!.hours).toBeCloseTo(4, 1);
  });
  test("F: a spent plan is lost hours with its cause, even while other cards start", () => {
    const d = db(); moving(d);
    card(d, "p", "todo", 5 * H, { dispatchState: "queued", dispatchError: `Claude: piano esaurito. ${PLAN_SPENT_NOTE}` }); // allow-italian: the sentence the plan hold writes
    card(d, "q", "todo", 5 * H, { dispatchState: "queued" });
    expect(causes(d)).toEqual([["p", "plan"]]);
    expect(cards([sampleTopics(d, NOW)]).cause).toContain("piano");
  });
  test("G: in progress with no reason is a subtask whose parent works, or a card a person took", () => {
    const d = db(); moving(d);
    card(d, "kid", "in_progress", 5 * H); set(d, "kid", { parent_task_id: "run" });
    card(d, "mine", "in_progress", 5 * H); set(d, "mine", { assigned_to: "someone" });
    expect(causes(d)).toEqual([["mine", "person"]]);
    set(d, "run", { status: "review", dispatch_state: null });
    expect(causes(d)).toEqual([["kid", "parent-idle"], ["mine", "person"]]);
  });
  test("H: the cause comes from the reason's kind", () => {
    const d = db();
    card(d, "tries", "todo", 5 * H, GIVEN_UP);
    card(d, "dad", "review", 5 * H);
    card(d, "kid", "todo", 5 * H); set(d, "kid", { parent_task_id: "dad" });
    card(d, "lost", "todo", 5 * H); set(d, "lost", { project_id: "_none" });
    expect(causes(d)).toEqual([["tries", "attempts"], ["kid", "parent-review"], ["lost", "no-project"]]);
  });
  test("H: a machine block names spend or disk, and the load is a wait", () => {
    const at = (block: Parameters<typeof setDispatchBlock>[0]) => {
      const d = db(); card(d, "q", "todo", 5 * H, { dispatchState: "queued" });
      setDispatchBlock(block);
      try { return causes(d).map(([, c]) => c); } finally { setDispatchBlock(null); }
    };
    expect(at({ kind: "spend", reason: "24 h cap" })).toEqual(["spend"]);
    expect(at({ kind: "resources", reason: "disk under the floor" })).toEqual(["resources"]);
    expect(at({ kind: "pressure", reason: "load" })).toEqual([]);
  });
  test("H: the «stay here» pin counts only until its deadline", () => {
    const d = db(); card(d, "q", "todo", 5 * H); set(d, "q", { stay_local: 1, stay_local_until: iso(NOW + H) });
    expect(causes(d)).toEqual([["q", "stay-local"]]);
    set(d, "q", { stay_local_until: iso(NOW - 1) });
    expect(causes(d)).toEqual([["q", "unknown"]]);
  });
  test("a note that names the board's owner or a coordinator is not life on the card; a real one is", () => {
    const d = db(); card(d, "p", "in_progress", 4 * H);
    note(d, "p", "user", "Padrone: ripresa dal giro delle 9", NOW - 60_000); // allow-italian: the note those roles write
    note(d, "p", "user", "**Coordinatore** · rimessa in coda", NOW - 61_000); // allow-italian: the note those roles write
    expect(sampleTopics(d, NOW).stuck[0]!.hours).toBeCloseTo(4, 1);
    note(d, "p", "user", "the tests are green now", NOW - 30 * 60_000);
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
  });
  test("a wait the agent declared, dated in the future, is a wait; past its date it is lost", () => {
    const d = db(); card(d, "w", "in_progress", 5 * H, { dispatchState: "waiting", deferredUntil: iso(NOW + H) });
    set(d, "w", { wait_reason: "the CI run" });
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
    set(d, "w", { dispatch_deferred_until: iso(NOW - 60_000) });
    expect(causes(d)).toEqual([["w", "unknown"]]);
  });
  test("work elsewhere on a node that is off is not a wait", () => {
    const d = db(); machine(d, "pc", "online", 4, iso(NOW));
    d.run("UPDATE machines SET base_url = 'https://node.invalid'");
    card(d, "e", "in_progress", 5 * H, { machineId: "pc" });
    expect(sampleTopics(d, NOW).stuck).toEqual([]);
    d.run("UPDATE machines SET status = 'offline'");
    expect(causes(d)).toEqual([["e", "offline"]]);
  });
});

describe("the third review: hours of a parked chain, heavy holds, and what is not a person or a plan", () => {
  const statusEvent = (d: Database, taskId: string, content: string, at: number) =>
    d.query("INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, 'system', ?, ?, 'status')").run(`${taskId}-${at}`, taskId, content, iso(at));
  const stuckOf = (d: Database) => sampleTopics(d, NOW).stuck.map((c) => [c.id, c.cause, Math.round(c.hours * 10) / 10]);

  test("1: a parked chain loses hours from when its root went into backlog, not from each card's entry into todo", () => {
    const d = db();
    card(d, "root", "todo", 30 * H);
    statusEvent(d, "root", "todo→backlog · parked", NOW - 3 * H);
    card(d, "mid", "todo", 20 * H, { blockedBy: "root" });
    card(d, "leaf", "todo", 20 * H, { blockedBy: "mid" });
    set(d, "root", { status: "backlog" });
    expect(stuckOf(d)).toEqual([["mid", "chain-parked", 3], ["leaf", "chain-parked", 3]]);
    // A card that joined the chain after the root was parked counts from its own entry.
    card(d, "late", "todo", 2 * H, { blockedBy: "root" });
    expect(stuckOf(d)).toContainEqual(["late", "chain-parked", 2]);
  });
  test("1: a root parked twice (backlog, todo, backlog again) counts from the last parking", () => {
    const d = db();
    card(d, "root", "todo", 30 * H);
    statusEvent(d, "root", "todo→backlog · parked", NOW - 20 * H);
    statusEvent(d, "root", "backlog→todo", NOW - 10 * H);
    statusEvent(d, "root", "todo→backlog · parked again", NOW - 3 * H);
    set(d, "root", { status: "backlog" });
    card(d, "kid", "todo", 25 * H, { blockedBy: "root" });
    expect(stuckOf(d)).toEqual([["kid", "chain-parked", 3]]);
  });
  test("1: a root born in backlog was parked at its birth", () => {
    const d = db();
    card(d, "root", "backlog", 4 * H);
    card(d, "kid", "todo", 20 * H, { blockedBy: "root" });
    expect(stuckOf(d)).toEqual([["kid", "chain-parked", 4]]);
  });
  test("1: a card whose DIRECT blocker is already done is never \"chain-parked\": a cure that cleared it would have nothing to do", () => {
    const d = db();
    card(d, "root", "done", 30 * H);
    card(d, "kid", "todo", 20 * H, { blockedBy: "root" });
    // `deriveQueueReason` already reads the direct blocker as resolved (shared/board.ts), so `kid`
    // is never reported "blocked", and `chainRoot` therefore never gets a chance to call it
    // "chain-parked" either: whatever else leaves it stuck, it is not this cause.
    expect(stuckOf(d).find((c) => c[0] === "kid")?.[1]).not.toBe("chain-parked");
  });
  test("2: a heavy card held behind the memory floor is memory, like the same wait with no weight", () => {
    const d = db();
    card(d, "heavy", "todo", 11 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    set(d, "heavy", { dispatch_weight: "heavy" });
    card(d, "light", "todo", 8 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
    const shared = createTasksShared(d, {});
    const rows = d.query("SELECT * FROM tasks WHERE id = 'heavy'").all() as any[];
    expect(shared.queueReasonOf(rows[0], shared.buildBatch(rows, { reasonsOnly: true }))?.kind).toBe("heavy_hold");
    expect(stuckOf(d)).toEqual([["heavy", "memory", 11], ["light", "memory", 8]]);
  });
  test("2: a heavy card held for load alone waits on purpose", () => {
    const d = db();
    card(d, "heavy", "todo", 11 * H, { dispatchState: "queued" });
    set(d, "heavy", { dispatch_weight: "heavy" });
    expect(stuckOf(d)).toEqual([]);
  });
  test("3: the round answers on a schema without the (task, author, kind) index", () => {
    const d = db();
    d.run("DROP INDEX idx_task_comments_task_author_kind");
    card(d, "q", "todo", 5 * H, GIVEN_UP);
    expect(stuckOf(d)).toEqual([["q", "attempts", 5]]);
  });
  test("minor: an assignee that names the agent is not a person", () => {
    const d = db();
    card(d, "a", "in_progress", 5 * H); set(d, "a", { assigned_to: "agente" });
    card(d, "p", "in_progress", 5 * H); set(d, "p", { assigned_to: "reviewer" });
    expect(stuckOf(d)).toEqual([["a", "unknown", 5], ["p", "person", 5]]);
  });
  test("minor: the five-hour window and a deferral are not a spent plan", () => {
    const d = db();
    card(d, "w", "todo", 5 * H, { dispatchState: "queued", dispatchError: "Claude: finestra di 5 ore al 92%. Nuovi task in attesa del reset delle 14:00." }); // allow-italian: the sentence the window hold writes
    card(d, "r", "todo", 5 * H, { dispatchState: "queued", dispatchError: "restart deferral" });
    card(d, "p", "todo", 5 * H, { dispatchState: "queued", dispatchError: `Claude: limite. ${PLAN_SPENT_NOTE}` });
    expect(stuckOf(d)).toEqual([["p", "plan", 5]]);
  });
  test("minor: with no in_progress_at, a card in progress is as old as its last entry into in_progress", () => {
    const d = db();
    card(d, "c", "in_progress", 50 * H);
    statusEvent(d, "c", "todo→in_progress", NOW - 3 * H);
    expect(stuckOf(d)).toEqual([["c", "unknown", 3]]);
  });
  test("minor: in progress, an idle card is counted, a working one only with an open run (both halves of the age gate)", () => {
    const d = db();
    machine(d, "n", "online", 4, iso(NOW - H));
    card(d, "idle", "in_progress", 5 * H);
    card(d, "busy", "in_progress", 5 * H, { dispatchState: "working" });
    card(d, "run", "in_progress", 5 * H, { dispatchState: "working", machineId: "n", nodeRunOpen: true });
    expect(stuckOf(d)).toEqual([["idle", "unknown", 5], ["run", "hung-node", 5]]);
  });
  test("minor: in progress with no reason, no parent and nobody on it is unknown (the last branch of G)", () => {
    // A start that never became a turn: the board reads no queue reason on it.
    const d = db(); card(d, "c", "in_progress", 5 * H, { dispatchState: "starting" });
    const shared = createTasksShared(d, {});
    const rows = d.query("SELECT * FROM tasks").all() as any[];
    expect(shared.queueReasonOf(rows[0], shared.buildBatch(rows, { reasonsOnly: true }))).toBeNull();
    expect(stuckOf(d)).toEqual([["c", "unknown", 5]]);
  });
  test("minor: a todo subtask of an idle parent is named by the reason's kind, parent_idle", () => {
    const d = db();
    card(d, "dad", "backlog", 5 * H);
    card(d, "kid", "todo", 5 * H); set(d, "kid", { parent_task_id: "dad" });
    const shared = createTasksShared(d, {});
    const rows = d.query("SELECT * FROM tasks WHERE id = 'kid'").all() as any[];
    expect(shared.queueReasonOf(rows[0], shared.buildBatch(rows, { reasonsOnly: true }))?.kind).toBe("parent_idle");
    expect(stuckOf(d)).toEqual([["kid", "parent-idle", 5]]);
  });
});

describe("proofs voice", () => {
  const one = (name: string, command = "x") => parseSettings(JSON.stringify({ checks: [{ name, command, tier: "5min" }] }));
  test("no declared proof: green and says so", () => {
    const v = proofs([sample(NOW)]);
    expect(v.red).toBe(false);
    expect(v.detail).toBe("nessuna prova dichiarata");
  });
  test("a command that exits 1 and one that outlives the cap are red", async () => {
    const run = async (argv: string[]) => (argv.at(-1) === "slow"
      ? { ...OK, code: null, timedOut: true }
      : { ...OK, code: 1 });
    const failing = await runProofs(one("a", "fail").checks, 5, run);
    const slow = await runProofs(one("b", "slow").checks, 5, run);
    expect(failing[0]).toMatchObject({ ok: false, reason: "esce con 1" });
    expect(slow[0]).toMatchObject({ ok: false, reason: "oltre 5 s" });
    expect(proofs([sample(NOW, { checks: failing })], one("a")).red).toBe(true);
    expect(proofs([sample(NOW, { checks: slow })], one("b")).red).toBe(true);
  });
  test("an exit 0 is green, and a daily proof does not run in the 5-minute round", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return OK; };
    const res = await runProofs([{ name: "ok", command: "a", tier: "5min" }, { name: "late", command: "b", tier: "daily" }], 5, run);
    expect(res).toEqual([{ name: "ok", ok: true, reason: null }]);
    expect(calls).toHaveLength(1);
  });
});

describe("the round", () => {
  test("288 rounds (24 h) call no model and keep one sample each", async () => {
    const d = db();
    card(d, "p", "in_progress", 3 * H);
    let modelCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { modelCalls++; return new Response("{}"); }) as unknown as typeof fetch;
    try {
      let t = NOW;
      const round = createTopicsCheck({ db: d, now: () => t, run: async () => OK });
      for (let i = 0; i < 288; i++) { await round.tick(); t += SAMPLE_INTERVAL_MS; }
    } finally { globalThis.fetch = realFetch; }
    expect(modelCalls).toBe(0);
    expect(readSamples(d)).toHaveLength(288);
  });
  // No wall clock here: on a shared CI a time cap measures the load, not the code. Speed is proved by what
  // does not depend on the load: the plans use an index, and the reasons are read only for the old cards.
  test("real volumes: every read searches an index, reasons are read only past a threshold, and the view reads only its window", async () => {
    const d = db();
    d.run("BEGIN");
    for (let i = 0; i < 200; i++) card(d, `v${i}`, i % 2 ? "todo" : "in_progress", (i % 20) * H);
    const insertComment = d.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?, ?, 'system', ?, ?)");
    for (let i = 0; i < 66_393; i++) insertComment.run(`k${i}`, `v${i % 200}`, i % 50 === 0 ? "Spostata su n1: posto libero." : "nota", iso(NOW - (i % 90_000) * 60_000));
    const insertSample = d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)");
    const body = JSON.stringify(sample(0, { todo: 3 }));
    for (let i = 0; i < 2016; i++) insertSample.run(NOW - i * SAMPLE_INTERVAL_MS, body);
    d.run("COMMIT");
    const plan = (d.query(`EXPLAIN QUERY PLAN ${MOVES_SQL}`).all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_task_comments_created_at");
    expect(plan).not.toMatch(/SCAN task_comments/);
    const threads = (d.query(`EXPLAIN QUERY PLAN ${THREADS_SQL}`).all("[]") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(threads).toMatch(/SEARCH task_comments USING (COVERING )?INDEX idx_task_comments_task/);
    const parked = (d.query(`EXPLAIN QUERY PLAN ${PARKED_EVENTS_SQL}`).all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(parked).toMatch(/SEARCH task_comments USING (COVERING )?INDEX/);
    const samplesPlan = (d.query(`EXPLAIN QUERY PLAN ${READ_SAMPLES_SQL}`).all(0) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(samplesPlan).not.toMatch(/SCAN topics_check_samples/);
    const probe = { reasons: 0 };
    const now = NOW + SAMPLE_INTERVAL_MS;
    sampleTopics(d, now, DEFAULT_THRESHOLDS, undefined, probe);
    // Cards v0..v199 are aged (i % 20) h: in progress they cross 2 h, in todo 1 h. The odd ones (todo) aged 1..19 h
    // are all past their threshold; the even ones (in progress) are past it from 2 h. A note by `system` is no life.
    const old = Array.from({ length: 200 }, (_, i) => i).filter((i) => (i % 20) >= (i % 2 ? 1 : 2)).length;
    expect(probe.reasons).toBeLessThanOrEqual(old);
    expect(probe.reasons).toBeGreaterThan(0);
    const round = createTopicsCheck({ db: d, now: () => now, run: async () => OK });
    const view = await round.tick().then(() => round.current());
    expect(view.state).toBe("live");
    expect(readSamples(d, NOW - 12 * H).length).toBeLessThan(150);
  });
  test("the proofs run under the configured cap, 30 s by default", async () => {
    const caps: number[] = [];
    const run = async (_argv: string[], ms?: number) => { caps.push(ms ?? 0); return OK; };
    const settings = () => parseSettings(JSON.stringify({ checks: [{ name: "a", command: "x" }] }));
    await createTopicsCheck({ db: db(), now: () => NOW, settings, run }).tick();
    expect(caps).toEqual([30_000]);
  });
  test("a round that is still running is joined, not doubled", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const run = async () => { calls++; await gate; return OK; };
    const settings = () => parseSettings(JSON.stringify({ checks: [{ name: "a", command: "x" }] }));
    const round = createTopicsCheck({ db: db(), now: () => NOW, settings, run });
    const first = round.tick();
    const second = round.tick();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await round.tick();
    expect(calls).toBe(2);
  });
  test("samples older than 7 days are dropped", async () => {
    const d = db();
    d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, '{}')").run(NOW - 8 * 24 * H);
    await createTopicsCheck({ db: d, now: () => NOW }).tick();
    expect((d.query("SELECT COUNT(*) AS n FROM topics_check_samples").get() as { n: number }).n).toBe(1);
  });
});

describe("the route", () => {
  /** The same answer whatever the wall clock says: the round reads only the clock it is given. */
  const routeAt = async (wallClock: string) => {
    setSystemTime(new Date(wallClock));
    try {
      const d = db();
      card(d, "m", "todo", 3 * H, { dispatchState: "queued", dispatchError: "waiting-memory" });
      const round = createTopicsCheck({ db: d, now: () => NOW, settings: () => noSettings });
      await round.tick();
      const { createTopicsCheckRouter } = await import("../routes/topics-check");
      const router = createTopicsCheckRouter({ db: d, json: (b: unknown) => Response.json(b) } as never, { now: () => NOW });
      const res = await router(new Request("http://x/api/topics-check"), new URL("http://x/api/topics-check"), "/api/topics-check", "GET");
      expect(await router(new Request("http://x/other"), new URL("http://x/other"), "/other", "GET")).toBeNull();
      return await res!.json() as ReturnType<typeof round.current>;
    } finally { setSystemTime(); }
  };
  test("GET /api/topics-check answers the three voices with the detail the view opens, today and on 24/11", async () => {
    for (const wall of ["2026-11-22T12:00:00.000Z", "2026-11-24T12:00:00.000Z"]) {
      const body = await routeAt(wall);
      expect(body.voices.map((v) => v.id)).toEqual(["cards", "seats", "proofs"]);
      expect(body.voices[0]!.red).toBe(true);
      expect(body.voices[0]!.cause).toBe("il pavimento di memoria tiene ferma la coda");
    }
  });
});

describe("round state", () => {
  test("no sample is waiting, a sample older than two intervals is stale, a fresh one is live", () => {
    expect(roundState([], NOW)).toEqual({ state: "waiting", ageMin: null });
    expect(roundState([sample(NOW - 10 * 60_000)], NOW)).toEqual({ state: "live", ageMin: 10 });
    expect(roundState([sample(NOW - 10 * 60_000 - 1)], NOW).state).toBe("stale");
    expect(roundState([sample(NOW - 17 * 60_000)], NOW)).toEqual({ state: "stale", ageMin: 17 });
  });
});
