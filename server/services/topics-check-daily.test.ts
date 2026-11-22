/**
 * The daily self-check: one model call a day, only new error signatures in its
 * input, a red verdict opens a card, an unreachable model never touches the
 * 5-minute round.
 *
 * @covers CHECK-04
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createTopicsCheck, parseSettings, type Sample } from "./topics-check";
import { dayKey, errorSignature, parseDailySettings, parseVerdict, readLatestVerdict, readVerdict, runDaily, type DailyDeps } from "./topics-check-daily";

const H = 3_600_000;
const DAY = 24 * H;
const NOW = new Date(2026, 10, 22, 9, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const SCHEMA = (() => {
  const d = new Database(":memory:");
  for (const m of EMBEDDED_MIGRATIONS) d.run(m.sql);
  return d.serialize();
})();
const db = () => Database.deserialize(SCHEMA);

function logError(d: Database, ago: number, category: string, title: string) {
  d.query("INSERT INTO activity_log (id, timestamp, category, level, title) VALUES (?, ?, ?, 'error', ?)").run(crypto.randomUUID(), iso(NOW - ago), category, title);
}

function harness(answer: string | Error = "GREEN: tutto regolare", extra: Partial<DailyDeps> & { board?: string; checks?: string[] } = {}) {
  const prompts: string[] = [];
  const cards: { board: string; title: string }[] = [];
  const deps: DailyDeps = {
    now: () => NOW,
    ask: async (prompt) => { prompts.push(prompt); if (answer instanceof Error) throw answer; return answer; },
    openCard: (board, title) => { cards.push({ board, title }); return "card-1"; },
    settings: () => ({
      daily: { hour: 7, model: "cheap-model", board: extra.board ?? "board-1" },
      checkNames: extra.checks ?? [],
      checkRaw: parseSettings(null),
    }),
    ...extra,
  };
  return { deps, prompts, cards };
}

describe("daily round", () => {
  test("one model call a day even when the round is called twice", async () => {
    const d = db();
    const h = harness();
    await runDaily(d, h.deps);
    expect(await runDaily(d, h.deps)).toBeNull();
    expect(h.prompts.length).toBe(1);
    expect(readVerdict(d, dayKey(NOW))?.line).toBe("tutto regolare");
  });

  test("before the settings hour nothing runs; the next day runs again", async () => {
    const d = db();
    const h = harness();
    expect(await runDaily(d, { ...h.deps, now: () => new Date(2026, 10, 22, 6, 59).getTime() })).toBeNull();
    expect(h.prompts.length).toBe(0);
    await runDaily(d, h.deps);
    await runDaily(d, { ...h.deps, now: () => NOW + DAY });
    expect(h.prompts.length).toBe(2);
  });

  test("only signatures never seen in the 7 days before enter the reading", async () => {
    const d = db();
    logError(d, 2 * DAY, "stream", "old failure on 3 chats");
    logError(d, 2 * H, "stream", "old failure on 9 chats");
    logError(d, 3 * H, "spawn", "brand new failure");
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("brand new failure");
    expect(h.prompts[0]).not.toContain("old failure");
  });

  test("a signature older than 7 days does not count as seen", async () => {
    const d = db();
    logError(d, 8.5 * DAY, "stream", "resurfaced failure");
    logError(d, 2 * H, "stream", "resurfaced failure");
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("resurfaced failure");
  });

  test("ids and numbers do not make a new signature", () => {
    expect(errorSignature("c", "run 4f3c9a1e-1111-2222-3333-444455556666 failed after 31 s"))
      .toBe(errorSignature("c", "run 0a0a0a0a-9999-8888-7777-666655554444 failed after 7 s"));
  });

  test("jobs without a proof are listed with their last outcome; a covered job is not", async () => {
    const d = db();
    const job = (id: string, name: string) => d.query("INSERT INTO scheduled_jobs (id, name, schedule_json, action_json, created_at, updated_at) VALUES (?, ?, '{}', '{}', ?, ?)").run(id, name, iso(NOW), iso(NOW));
    job("j1", "nightly-backup");
    job("j2", "covered-job");
    d.query("INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, reason, created_at) VALUES ('r1', 'j1', 'k', ?, 'error', 'disk full', ?)").run(iso(NOW), iso(NOW));
    const h = harness("GREEN: ok", { checks: ["covered-job"] });
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("nightly-backup: error (disk full)");
    expect(h.prompts[0]).not.toContain("covered-job");
  });

  test("stuck cards enter with the cause the 5-minute round wrote", async () => {
    const d = db();
    const sample: Sample = { at: NOW - H, todo: 1, machines: [], moves: [], stuck: [{ id: "card-x", status: "todo", hours: 3, cause: "person" }] };
    d.query("INSERT INTO topics_check_samples (at, sample_json) VALUES (?, ?)").run(sample.at, JSON.stringify(sample));
    const h = harness();
    await runDaily(d, h.deps);
    expect(h.prompts[0]).toContain("card-x: 3 h, in attesa di una persona");
  });

  test("a red verdict opens one card; a green one writes nothing beyond the line", async () => {
    const red = harness("RED: lavori falliti ogni notte");
    const d1 = db();
    const v = await runDaily(d1, red.deps);
    expect(red.cards).toEqual([{ board: "board-1", title: "Verifica di Topics: lavori falliti ogni notte" }]);
    expect(v?.cardId).toBe("card-1");

    const green = harness("GREEN: ok");
    await runDaily(db(), green.deps);
    expect(green.cards.length).toBe(0);
  });

  test("red with no investigation board chosen opens no card and raises no error", async () => {
    const h = harness("RED: qualcosa", { board: "" });
    const v = await runDaily(db(), h.deps);
    expect(v?.color).toBe("red");
    expect(h.cards.length).toBe(0);
  });

  test("an unreachable model: the line says the reading was not done, and the 5-minute round is untouched", async () => {
    const d = db();
    const h = harness(new Error("nessun modello connesso"));
    const v = await runDaily(d, h.deps);
    expect(v?.color).toBe("unread");
    expect(v?.line).toBe("lettura non fatta: nessun modello connesso");
    expect(h.cards.length).toBe(0);
    const round = createTopicsCheck({ db: d, now: () => NOW, settings: () => parseSettings(null) });
    expect((await round.tick()).length).toBe(3);
    expect(readLatestVerdict(d)?.color).toBe("unread");
  });

  test("an answer that is not a verdict is not read as one", async () => {
    const v = await runDaily(db(), harness("Everything looks fine to me").deps);
    expect(v?.line).toBe("lettura non fatta: risposta non leggibile");
  });

  test("the model setting defaults to the cheap tier and the hour is range-checked", () => {
    expect(parseDailySettings(null)).toEqual({ hour: 7, model: "claude-haiku-4-5", board: "" });
    expect(parseDailySettings(JSON.stringify({ dailyHour: 24, dailyModel: "m", investigationBoard: "b" }))).toEqual({ hour: 7, model: "m", board: "b" });
    expect(parseVerdict("RED - boom")).toEqual({ color: "red", line: "boom" });
  });
});
