/**
 * The self-check round: the cases of 21/11 each give their voice red with its
 * number, every threshold has its mutation, the proofs are configuration, and
 * 24 hours of rounds call no model.
 *
 * @covers CHECK-01
 * @covers CHECK-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb, PID } from "./tasks-test-db";
import {
  createTopicsCheck, DEFAULT_THRESHOLDS, parseSettings, readSamples, roundState, runProofs, sampleTopics, voices,
  SAMPLE_INTERVAL_MS, type Sample, type TopicsCheckSettings,
} from "./topics-check";

const MIG = join(import.meta.dir, "../db/migrations");
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const noSettings = parseSettings(null);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, missing: false };

function db(): Database {
  const d = freshDb();
  // The harness keeps a three-column stand-in for machines; the real table comes from the migrations.
  d.run("PRAGMA foreign_keys = OFF");
  d.run("DROP TABLE machines");
  d.run("PRAGMA foreign_keys = ON");
  for (const f of ["020-machines.sql", "20261109090000-machine-slots.sql", "20261122100000-topics-check.sql", "20261122110000-task-comments-created-at-index.sql"]) {
    // The settings column is already in the harness's app_settings; only the table is new here.
    d.run(readFileSync(join(MIG, f), "utf8").replace(/INSERT OR IGNORE INTO schema_migrations[^;]*;/, "").replace(/ALTER TABLE app_settings[^;]*;/, ""));
  }
  d.run(`INSERT INTO board_settings (project_id, auto_dispatch) VALUES ('${PID}', 1)`);
  return d;
}
function machine(d: Database, id: string, status: "online" | "offline", slots: number | null, heartbeat = "x") {
  d.run(`INSERT OR REPLACE INTO machines (id, name, hostname, arch, platform, daemon_version, status, slots, last_heartbeat_at, last_seen_at, created_at, updated_at)
    VALUES ('${id}', '${id}', '${id}', 'x', 'x', '1', '${status}', ${slots}, '${heartbeat}', 'x', 'x', 'x')`);
}
function card(d: Database, id: string, status: string, ageMs: number, extra: { humanAsk?: string; machineId?: string; dispatchState?: string; nodeRunOpen?: boolean } = {}) {
  d.query("INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, human_ask, machine_id, dispatch_state, node_run_open) VALUES (?, ?, 'c', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, PID, status, iso(NOW - ageMs), iso(NOW - ageMs), extra.humanAsk ?? null, extra.machineId ?? null, extra.dispatchState ?? null, extra.nodeRunOpen ? 1 : 0);
}
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
  test("threshold mutation: a todo card waiting 59 min is green, 1 h is red", () => {
    const a = db(); card(a, "t", "todo", H - 60_000);
    const b = db(); card(b, "t", "todo", H);
    expect(cards([sampleTopics(a, NOW)]).red).toBe(false);
    expect(cards([sampleTopics(b, NOW)]).red).toBe(true);
  });
  test("window mutation: 4 moves of a card inside 59 min are red, spread over 60 min green", () => {
    const red = db(); card(red, "b", "done", H); moved(red, "b", 4, 59 * 60_000, "n1");
    const green = db(); card(green, "b", "done", H); moved(green, "b", 4, 60 * 60_000, "n1");
    expect(cards([sampleTopics(red, NOW)]).red).toBe(true);
    expect(cards([sampleTopics(green, NOW)]).red).toBe(false);
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
  test("a todo card on a board that does not dispatch is not stuck", () => {
    const d = db();
    d.run("UPDATE board_settings SET auto_dispatch = 0");
    card(d, "t", "todo", 5 * H);
    expect(cards([sampleTopics(d, NOW)]).red).toBe(false);
  });
  test("the settings move a threshold, and garbage falls back to the defaults", () => {
    const d = db(); card(d, "p", "in_progress", 3 * H);
    const s = parseSettings(JSON.stringify({ thresholds: { progressStuckHours: 5 } }));
    expect(cards([sampleTopics(d, NOW, s.thresholds)], s).red).toBe(false);
    expect(parseSettings("not json").thresholds).toEqual(DEFAULT_THRESHOLDS);
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
  test("288 rounds (24 h) call no model, keep one sample each, and take under 50 ms each", async () => {
    const d = db();
    card(d, "p", "in_progress", 3 * H);
    let modelCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { modelCalls++; return new Response("{}"); }) as unknown as typeof fetch;
    try {
      let t = NOW;
      const round = createTopicsCheck({ db: d, now: () => t, run: async () => OK });
      const started = performance.now();
      for (let i = 0; i < 288; i++) { await round.tick(); t += SAMPLE_INTERVAL_MS; }
      expect((performance.now() - started) / 288).toBeLessThan(50);
    } finally { globalThis.fetch = realFetch; }
    expect(modelCalls).toBe(0);
    expect(readSamples(d)).toHaveLength(288);
  });
  test("real volumes: the moves read searches an index, a round stays under 50 ms, and the view reads only its window", async () => {
    const d = db();
    d.run("BEGIN");
    for (let i = 0; i < 200; i++) card(d, `v${i}`, i % 2 ? "todo" : "in_progress", (i % 20) * H);
    const insertComment = d.query("INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?, ?, 'system', ?, ?)");
    for (let i = 0; i < 66_393; i++) insertComment.run(`k${i}`, `v${i % 200}`, i % 50 === 0 ? "Spostata su n1: posto libero." : "nota", iso(NOW - (i % 90_000) * 60_000));
    const insertSample = d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)");
    const body = JSON.stringify(sample(0, { todo: 3 }));
    for (let i = 0; i < 2016; i++) insertSample.run(NOW - i * SAMPLE_INTERVAL_MS, body);
    d.run("COMMIT");
    const plan = (d.query("EXPLAIN QUERY PLAN SELECT task_id, content, created_at FROM task_comments WHERE content LIKE 'Spostata %' AND created_at >= ? ORDER BY created_at DESC LIMIT 200").all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_task_comments_created_at");
    expect(plan).not.toMatch(/SCAN task_comments/);
    const round = createTopicsCheck({ db: d, now: () => NOW + SAMPLE_INTERVAL_MS, run: async () => OK });
    await round.tick();
    const started = performance.now();
    const view = await round.tick().then(() => round.current());
    const ms = performance.now() - started;
    console.log(`round + view at real volumes: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(50);
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

describe("round state", () => {
  test("no sample is waiting, a sample older than two intervals is stale, a fresh one is live", () => {
    expect(roundState([], NOW)).toEqual({ state: "waiting", ageMin: null });
    expect(roundState([sample(NOW - 10 * 60_000)], NOW)).toEqual({ state: "live", ageMin: 10 });
    expect(roundState([sample(NOW - 10 * 60_000 - 1)], NOW).state).toBe("stale");
    expect(roundState([sample(NOW - 17 * 60_000)], NOW)).toEqual({ state: "stale", ageMin: 17 });
  });
});
