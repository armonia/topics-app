/**
 * The daily self-check: one model call a day, only new error signatures in its
 * input, a red verdict opens a card, an unreachable model never touches the
 * 5-minute round. Error rows come from the real writers (`logStreamError`,
 * `logStreamHardTimeout`), not from rows the test invents.
 *
 * @covers CHECK-04
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { logActivity, logStreamError, logStreamHardTimeout } from "../db/activity-log";
import { createTopicsCheck, parseSettings, type Runner, type Sample } from "./topics-check";
import type { AIProvider, CompletionOptions } from "../providers/types";
import {
  dayKey, errorSignature, makeAsk, modelFor, parseDailySettings, parseVerdict, readLatestVerdict, runDaily,
  type DailyDeps, type DailyVerdict,
} from "./topics-check-daily";

/** The verdict stored for `day`, read straight from the table (the service itself reads only the newest). */
const readVerdict = (db: Database, day: string): DailyVerdict | null => {
  const r = db.query("SELECT verdict_json FROM topics_check_daily WHERE day = ?").get(day) as { verdict_json: string } | null;
  return r ? (JSON.parse(r.verdict_json) as DailyVerdict) : null;
};

const H = 3_600_000;
const DAY = 24 * H;
const NOW = new Date(2026, 10, 22, 9, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let tmpRoot: string;
let d: Database;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "topics-check-daily-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  initDatabase(tmpRoot);
  d = getDatabase();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* teardown: already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* teardown: already gone */ }
});

beforeEach(() => {
  for (const t of ["activity_log", "topics_check_daily", "topics_check_samples", "scheduled_job_runs", "scheduled_jobs"]) d.run(`DELETE FROM ${t}`);
});

/** Writes through the real writer, then moves the row it just wrote to `ago` before NOW. */
function logAt(ago: number, write: () => void) {
  write();
  d.run("UPDATE activity_log SET timestamp = ? WHERE rowid = (SELECT MAX(rowid) FROM activity_log)", [iso(NOW - ago)]);
}
const streamError = (ago: number, errorMessage: string) => logAt(ago, () => logStreamError({ sessionKey: "s", topicId: "t", errorMessage }));

type Opened = { outcome: "opened" | "capped" | "off"; cardId: string | null };
function harness(answer: string | Error = "GREEN: all regular", extra: Partial<DailyDeps> & { checks?: { name: string; command: string; tier: "5min" | "daily" }[]; opened?: Opened } = {}) {
  const prompts: string[] = [];
  const models: string[] = [];
  const cards: { boardId: string | null; perDay: number; title: string }[] = [];
  const deps: DailyDeps = {
    now: () => NOW,
    ask: async (prompt, model) => { prompts.push(prompt); models.push(model); if (answer instanceof Error) throw answer; return answer; },
    openCard: (inv, title) => { cards.push({ boardId: inv.boardId, perDay: inv.perDay, title }); return extra.opened ?? { outcome: "opened", cardId: "card-1" }; },
    settings: () => ({
      daily: { hour: 7, model: "" }, language: null,
      checkRaw: { ...parseSettings(null), checks: extra.checks ?? [], investigation: { boardId: "board-1", perDay: 3 } },
    }),
    ...extra,
  };
  return { deps, prompts, models, cards };
}

describe("when the round runs", () => {
  test("one model call a day even when the round is called twice", async () => {
    const h = harness();
    await runDaily(d, h.deps);
    expect(await runDaily(d, h.deps)).toBeNull();
    expect(h.prompts.length).toBe(1);
    expect(readVerdict(d, dayKey(NOW))?.line).toBe("all regular");
  });

  test("it runs at exactly the settings hour, not before, and again the next day", async () => {
    const h = harness();
    expect(await runDaily(d, { ...h.deps, now: () => new Date(2026, 10, 22, 6, 59).getTime() })).toBeNull();
    expect(h.prompts.length).toBe(0);
    expect(await runDaily(d, { ...h.deps, now: () => new Date(2026, 10, 22, 7, 0, 0).getTime() })).not.toBeNull();
    await runDaily(d, { ...h.deps, now: () => NOW + DAY });
    expect(h.prompts.length).toBe(2);
  });

  test("a reading lost to a restart is taken over once, and a live one is left alone", async () => {
    const h = harness();
    const row = (at: number, reason: string) => d.query("INSERT INTO topics_check_daily (day, verdict_json) VALUES (?, ?)")
      .run(dayKey(NOW), JSON.stringify({ day: dayKey(NOW), at, color: "unread", reason, line: "", cardId: null, cardNote: null }));
    row(NOW - 60_000, "reading");
    expect(await runDaily(d, h.deps)).toBeNull();
    expect(h.prompts.length).toBe(0);
    d.run("DELETE FROM topics_check_daily");
    row(NOW - 30 * 60_000, "reading");
    const v = await runDaily(d, h.deps);
    expect(v?.color).toBe("green");
    expect(h.prompts.length).toBe(1);
    expect(readVerdict(d, dayKey(NOW))?.reason).toBeNull();
  });

  test("a failure while building the input is a stated unread row, never a reading left in flight", async () => {
    const h = harness("GREEN: ok", { checks: [{ name: "p", command: "x", tier: "daily" }], run: async () => { throw new Error("spawn exploded"); } });
    const v = await runDaily(d, h.deps);
    expect(v).toMatchObject({ color: "unread", reason: "unreachable", line: "spawn exploded" });
    expect(readVerdict(d, dayKey(NOW))?.reason).toBe("unreachable");
  });
});

describe("what the reading carries", () => {
  test("only signatures never seen in the 7 days before enter it, built from the real error writers", async () => {
    streamError(3 * DAY, "HTTP 429 too many requests");
    streamError(2 * H, "ENOSPC: no space left on device");
    streamError(1 * H, "HTTP 429 too many requests");
    logAt(2 * H, () => logStreamHardTimeout({ sessionKey: "s", topicId: "t" }));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("ENOSPC");
    expect(h.prompts[0]).toContain("stream hard timeout");
    expect(h.prompts[0]).not.toContain("HTTP #");
    expect(h.prompts[0]).not.toContain("429");
  });

  test("an error 14 hours old is still today's: the day is the last 24 hours, not less", async () => {
    streamError(14 * H, "EMFILE: too many open files");
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("EMFILE");
  });

  test("the baseline is the 7 days before the last 24 hours: errors 6.5 and 7.5 days old are seen, one 8.5 days old is not", async () => {
    streamError(6.5 * DAY, "seen within the week");
    streamError(7.5 * DAY, "seen at the far edge");
    streamError(2 * H, "seen at the far edge");
    streamError(8.5 * DAY, "seen only before the week");
    streamError(2 * H, "seen within the week");
    streamError(2 * H, "seen only before the week");
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).not.toContain("seen within the week");
    expect(h.prompts[0]).not.toContain("seen at the far edge");
    expect(h.prompts[0]).toContain("seen only before the week");
  });

  test("only error rows count: a warning with a new text stays out", async () => {
    logAt(2 * H, () => logActivity({ category: "stream", level: "warn", title: "stream soft timeout", detail: "just a warning" }));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).not.toContain("just a warning");
  });

  test("paths, ports and durations do not make a new signature; a different status does", () => {
    const sig = (m: string) => errorSignature("stream", "stream provider error", m);
    expect(sig("ENOENT /srv/a/run-1/out.log after 31 s")).toBe(sig("ENOENT /srv/b/run-9/out.log after 7 s"));
    expect(sig("connect ECONNREFUSED 127.0.0.1:4310")).toBe(sig("connect ECONNREFUSED 127.0.0.1:5822"));
    expect(sig("HTTP 429")).not.toBe(sig("HTTP 500"));
    expect(sig("HTTP 429")).not.toBe(sig("ENOSPC"));
  });

  test("a log shorter than the baseline says so in the prompt; a full one does not", async () => {
    streamError(2 * DAY, "an old row");
    streamError(2 * H, "something");
    const short = harness();
    await runDaily(d, short.deps);
    expect(short.prompts[0]).toContain("holds only 1 full day(s)");
    d.run("DELETE FROM topics_check_daily");
    streamError(9 * DAY, "the oldest row");
    const full = harness();
    await runDaily(d, full.deps);
    expect(full.prompts[0]).not.toContain("holds only");
  });

  test("the three voices come over 24 hours: a seat lost 20 hours ago still shows", async () => {
    const machines = (slots: number) => [{ id: "n1", name: "n1", online: true, slots, cards: 0, heartbeatAt: NOW }];
    // 14 samples of a queue with a node that promised seats and gave none, from 20 to 14 hours ago (inside 24 h, outside the 12 h default).
    const rows: Sample[] = [{ at: NOW - 21 * H, todo: 0, machines: machines(2), stuck: [], moves: [] }];
    for (let i = 0; i < 14; i++) rows.push({ at: NOW - 20 * H + i * 5 * 60_000, todo: 2, machines: machines(0), stuck: [], moves: [] });
    rows.push({ at: NOW - 5 * 60_000, todo: 0, machines: machines(2), stuck: [], moves: [] });
    for (const s of rows) d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(s.at, JSON.stringify(s));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("## Voices over 24 hours");
    expect(h.prompts[0]).toMatch(/seats: red/);
  });

  test("a seat lost 30 hours ago is outside the 24 hours of the voices", async () => {
    const machines = (slots: number) => [{ id: "n1", name: "n1", online: true, slots, cards: 0, heartbeatAt: NOW }];
    const rows: Sample[] = [];
    for (let i = 0; i < 14; i++) rows.push({ at: NOW - 30 * H + i * 5 * 60_000, todo: 2, machines: machines(0), stuck: [], moves: [] });
    rows.push({ at: NOW - 21 * H, todo: 0, machines: machines(2), stuck: [], moves: [] });
    rows.push({ at: NOW - 5 * 60_000, todo: 0, machines: machines(2), stuck: [], moves: [] });
    for (const s of rows) d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(s.at, JSON.stringify(s));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).not.toMatch(/seats: red/);
  });

  test("jobs without a proof are listed with their last outcome; covered, disabled and deleted ones are not", async () => {
    const job = (id: string, name: string, enabled = 1, deletedAt: string | null = null) => d.query("INSERT INTO scheduled_jobs (id, name, schedule_json, action_json, enabled, deleted_at, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?, ?, ?)").run(id, name, enabled, deletedAt, iso(NOW), iso(NOW));
    job("j1", "nightly-backup");
    job("j2", "covered-job");
    job("j3", "switched-off-job", 0);
    job("j4", "removed-job", 1, iso(NOW));
    d.query("INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, reason, created_at) VALUES ('r1', 'j1', 'k', ?, 'error', 'disk full', ?)").run(iso(NOW), iso(NOW));
    const h = harness("GREEN: ok", { checks: [{ name: "covered-job", command: "x", tier: "5min" }] });
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("nightly-backup: error (disk full)");
    for (const gone of ["covered-job", "switched-off-job", "removed-job"]) expect(h.prompts[0]).not.toContain(gone);
  });

  test("stuck cards enter with the cause the 5-minute round wrote", async () => {
    const sample: Sample = { at: NOW - H, todo: 1, machines: [], moves: [], stuck: [{ id: "card-x", status: "todo", hours: 3, cause: "person" }] };
    d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(sample.at, JSON.stringify(sample));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("card-x: 3 h,");
  });

  test("a long list is cut at 20, the commonest first, and says how many were left out", async () => {
    for (let i = 0; i < 25; i++) for (let n = 0; n <= i; n++) streamError(2 * H + (i + 1) * 1000, `distinct failure number ${String.fromCharCode(97 + i)}`);
    const h = harness();
    await runDaily(d, h.deps);
    const lines = h.prompts[0]!.split("\n").filter((l) => /^\d+x /.test(l));
    expect(lines.length).toBe(20);
    expect(lines[0]).toStartWith("25x ");
    expect(h.prompts[0]).toContain("...and 5 more");
  });

  test("the daily-tier proofs run here and enter the proofs voice; the 5-minute ones do not", async () => {
    const ran: string[] = [];
    const run: Runner = (async (cmd: string[]) => { ran.push(cmd[cmd.length - 1]!); return { code: 3, timedOut: false, missing: false }; }) as never;
    const h = harness("GREEN: ok", { run, checks: [{ name: "nightly-proof", command: "run-nightly", tier: "daily" }, { name: "round-proof", command: "run-round", tier: "5min" }] });
    await runDaily(d, h.deps);
    expect(ran).toEqual(["run-nightly"]);
    expect(h.prompts[0]).toContain("proofs: red");
    expect(h.prompts[0]).toContain("nightly-proof");
  });

  test("the round asks with the model of the settings", async () => {
    const h = harness("GREEN: ok", { settings: () => ({ daily: { hour: 7, model: "cheap-model-x" }, language: null, checkRaw: parseSettings(null) }) });
    await runDaily(d, h.deps);
    expect(h.models).toEqual(["cheap-model-x"]);
  });

  test("the sentence is asked in the app's output language", async () => {
    const h = harness("GREEN: ok", { settings: () => ({ daily: { hour: 7, model: "" }, language: "it", checkRaw: parseSettings(null) }) });
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain('language with code "it"');
  });
});

describe("what a verdict does", () => {
  test("a red verdict opens one card on the investigation board; a green one opens none", async () => {
    const red = harness("RED: jobs fail every night");
    const v = await runDaily(d, red.deps);
    expect(red.cards).toEqual([{ boardId: "board-1", perDay: 3, title: "Topics check: jobs fail every night" }]);
    expect(v?.cardId).toBe("card-1");
    d.run("DELETE FROM topics_check_daily");
    const green = harness("GREEN: ok");
    await runDaily(d, green.deps);
    expect(green.cards.length).toBe(0);
  });

  test("a card that cannot be opened is said, and the verdict is still stored", async () => {
    const h = harness("RED: boom", { openCard: () => { throw new Error("board gone"); } });
    const v = await runDaily(d, h.deps);
    expect(v).toMatchObject({ color: "red", line: "boom", cardId: null, cardNote: "failed" });
    expect(readVerdict(d, dayKey(NOW))?.cardNote).toBe("failed");
  });

  test("a cap that is full is said, with no card", async () => {
    const v = await runDaily(d, harness("RED: boom", { opened: { outcome: "capped", cardId: null } }).deps);
    expect(v).toMatchObject({ color: "red", cardId: null, cardNote: "capped" });
  });

  test("red with no investigation board opens no card and raises no error", async () => {
    const v = await runDaily(d, harness("RED: something", { opened: { outcome: "off", cardId: null } }).deps);
    expect(v).toMatchObject({ color: "red", cardId: null, cardNote: null });
  });

  test("an unreachable model: the row says why, and the 5-minute round is untouched", async () => {
    const h = harness(new Error("no model connected"));
    const v = await runDaily(d, h.deps);
    expect(v).toMatchObject({ color: "unread", reason: "unreachable", line: "no model connected" });
    // Only a red verdict opens a card: an unread one is the model's problem, not Topics'.
    expect(h.cards.length).toBe(0);
    const round = createTopicsCheck({ db: d, now: () => NOW, settings: () => parseSettings(null) });
    expect((await round.tick()).length).toBe(3);
    expect(readLatestVerdict(d)?.reason).toBe("unreachable");
  });

  test("an answer that is not a verdict is not read as one", async () => {
    const v = await runDaily(d, harness("Everything looks fine to me").deps);
    expect(v).toMatchObject({ color: "unread", reason: "unreadable" });
  });
});

describe("the verdict line and the settings", () => {
  test("parseVerdict reads GREEN or RED at the start of the line only", () => {
    expect(parseVerdict("RED - boom")).toEqual({ color: "red", line: "boom" });
    expect(parseVerdict("Looks fine, no red flags")).toBeNull();
    expect(parseVerdict("I would say green: ok")).toBeNull();
  });

  test("the model setting is empty by default and the hour is range-checked", () => {
    expect(parseDailySettings(null)).toEqual({ hour: 7, model: "" });
    expect(parseDailySettings(JSON.stringify({ dailyHour: 24, dailyModel: " m " }))).toEqual({ hour: 7, model: "m" });
  });
});

describe("the model asked", () => {
  const provider = (name: string, calls: CompletionOptions[], connected = true) => ({
    name, connected,
    complete: async (_m: unknown, o: CompletionOptions) => { calls.push(o); return { content: "GREEN: ok" }; },
  }) as unknown as AIProvider;

  test("the cheap tier is named only for the provider that has one; the others get no model at all", async () => {
    for (const [name, expected] of [["claude-code", "claude-haiku-4-5"], ["codex", undefined], ["muse", undefined], ["openai", undefined], ["claude-cloud", undefined]] as const) {
      const calls: CompletionOptions[] = [];
      await makeAsk(() => provider(name, calls))("prompt", "");
      expect(calls[0]!.model).toBe(expected);
    }
  });

  test("a model in the settings goes to whichever provider answers", async () => {
    const calls: CompletionOptions[] = [];
    await makeAsk(() => provider("codex", calls))("prompt", "my-model");
    expect(calls[0]!.model).toBe("my-model");
    expect(modelFor("claude-code", "my-model")).toBe("my-model");
  });

  test("no connected provider is an error the round turns into a stated line", async () => {
    await expect(makeAsk(() => provider("claude-code", [], false))("p", "")).rejects.toThrow("no model connected");
  });
});

describe("the route", () => {
  const get = async (now: number) => {
    const { createTopicsCheckRouter } = await import("../routes/topics-check");
    const router = createTopicsCheckRouter({ db: d, json: (b: unknown) => Response.json(b) } as never, { now: () => now });
    const res = await router(new Request("http://x/api/topics-check"), new URL("http://x/api/topics-check"), "/api/topics-check", "GET");
    return await res!.json() as { voices: unknown[]; daily: (DailyVerdict & { old: boolean }) | null };
  };

  test("GET /api/topics-check carries the daily verdict, marked old when it is not today's", async () => {
    await runDaily(d, harness("RED: boom").deps);
    const today = await get(NOW);
    expect(today.voices.length).toBe(3);
    expect(today.daily).toMatchObject({ color: "red", line: "boom", old: false });
    expect((await get(NOW + 2 * DAY)).daily?.old).toBe(true);
  });

  test("an unreadable row leaves the voices answering", async () => {
    d.query("INSERT INTO topics_check_daily (day, verdict_json) VALUES ('2026-11-22', 'not json')").run();
    const body = await get(NOW);
    expect(body.voices.length).toBe(3);
    expect(body.daily).toBeNull();
  });
});
