/**
 * Delivery of a job's outcome and the failure alert, against a fake adapter that
 * records the arguments, the stdin and the environment it was given.
 *
 * @covers SCHED-05, SCHED-06, SCHED-07
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutGatewayToken } from "../../lib/child-env";
import { freshDb } from "../../services/tasks-test-db";
import { adapterCall, expandArgv } from "./adapter";
import { createOwnerAlert } from "./owner-alert";
import { createDeliveryRegistry } from "./registry";
import { createRunDelivery } from "./run-delivery";
import { createSender } from "./send";
import { parseDeliverySettings, type DeliverySettings } from "./settings";
import type { AdapterCall, AdapterResult } from "./adapter";

const MIGRATIONS = join(import.meta.dir, "../../db/migrations");
const FILES = ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261121160000-scheduled-job-command-output.sql", "20261126100000-scheduled-delivery.sql", "20261126180000-scheduled-delivery-guards.sql"];
// The settings column is added by the real migration chain; here the table is not under test.
const MIGRATION_SQL = FILES.map((file) => readFileSync(join(MIGRATIONS, file), "utf8").replace(/ALTER TABLE app_settings[^;]*;/g, ""));

const DEFAULT_ADAPTER = { argv: ["/bin/send", "--chat", "{chat}", "--thread", "{thread}", "--key", "{key}"], env: { SEND_TITLE: "{title}" } };
const OWNER = { channel: "chan", chat: "owner-chat", thread: "" };

let db: Database;
let clock: { now: Date };
let calls: AdapterCall[];
let nextResult: () => AdapterResult;
let settings: DeliverySettings;
let notices: Array<{ subject: string; dedupeKey: string; title: string }>;

const settingsOf = (patch: Record<string, unknown> = {}) => parseDeliverySettings(JSON.stringify({ adapter: DEFAULT_ADAPTER, owner: OWNER, ...patch }), {});

function build() {
  const registry = createDeliveryRegistry(db, () => clock.now);
  const sender = createSender({
    registry, settings: () => settings, env: {}, wait: async () => {},
    runner: async (call) => { calls.push(call); return nextResult(); },
  });
  const alert = createOwnerAlert({ db, sender, settings: () => settings, now: () => clock.now, notice: (row) => notices.push(row) });
  const delivery = createRunDelivery({ db, sender, alert, settings: () => settings, now: () => clock.now });
  return { registry, sender, alert, delivery };
}

function addJob(id: string, deliver: unknown = { to: "owner" }) {
  db.prepare(`INSERT INTO scheduled_jobs (id, name, schedule_json, action_json, deliver_json, policy_json, enabled, created_at, updated_at)
    VALUES (?, ?, '{"kind":"every","minutes":10}', '{"kind":"command"}', ?, '{}', 1, ?, ?)`)
    .run(id, `Job ${id}`, deliver === null ? null : JSON.stringify(deliver), clock.now.toISOString(), clock.now.toISOString());
}

let runSerial = 0;
function addRun(jobId: string, status: string, patch: { stdout?: string | null; exitCode?: number | null; stderr?: string } = {}) {
  runSerial++;
  const id = `run-${runSerial}`;
  clock.now = new Date(clock.now.getTime() + 60_000);
  db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at, finished_at, exit_code, stdout_tail, stderr_tail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, jobId, `k${runSerial}`, clock.now.toISOString(), status, clock.now.toISOString(), clock.now.toISOString(), patch.exitCode ?? null, patch.stdout ?? null, patch.stderr ?? null);
  return id;
}

beforeEach(() => {
  db = freshDb();
  for (const sql of MIGRATION_SQL) db.run(sql);
  clock = { now: new Date("2026-11-26T12:00:00Z") };
  calls = [];
  notices = [];
  runSerial = 0;
  nextResult = () => ({ exitCode: 0, stdout: "", stderr: "" });
  settings = settingsOf();
});

describe("what goes out", () => {
  test("stdout goes once, with the key, on stdin, through the placeholders and the environment", async () => {
    const { delivery } = build();
    addJob("j1");
    const runId = addRun("j1", "ok", { stdout: "all good\n", stderr: "noise" });
    await delivery.sweep();
    await delivery.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].stdin).toBe("all good");
    expect(calls[0].argv).toEqual(["/bin/send", "--chat", "owner-chat", "--key", runId]);
    expect(calls[0].env).toMatchObject({ SEND_TITLE: "Job j1", TOPICS_DELIVERY_KEY: runId, TOPICS_JOB_ID: "j1", TOPICS_JOB_RUN_ID: runId });
    expect(calls[0].stdin).not.toContain("noise");
  });

  test("empty output and NO_REPLY send nothing; stderr alone never goes", async () => {
    const { delivery, registry } = build();
    addJob("j1");
    const empty = addRun("j1", "ok", { stdout: "  \n", stderr: "only noise" });
    const quiet = addRun("j1", "ok", { stdout: "NO_REPLY" });
    await delivery.sweep();
    expect(calls).toHaveLength(0);
    expect(registry.get(empty)?.state).toBe("empty");
    expect(registry.get(quiet)?.state).toBe("empty");
  });

  test("a non-zero exit is an error and its stdout still goes", async () => {
    const { delivery } = build();
    addJob("j1");
    addRun("j1", "error", { stdout: "partial report", exitCode: 3 });
    await delivery.sweep();
    expect(calls.map((call) => call.stdin)).toEqual(["partial report"]);
  });

  test("a failed command with no output says one line, only if the run before it went well", async () => {
    const { delivery } = build();
    addJob("j1");
    addRun("j1", "ok", { stdout: "fine" });
    addRun("j1", "error", { exitCode: 2 });
    addRun("j1", "error", { exitCode: 2 });
    await delivery.sweep();
    expect(calls.map((call) => call.stdin)).toEqual(["fine", "Job j1: the command failed (exit code 2)."]);
  });

  test("timeout and cancelled send nothing, and the destination owner comes from the setting", async () => {
    const { delivery } = build();
    addJob("j1");
    addRun("j1", "timeout", { stdout: "half" });
    addRun("j1", "cancelled", { stdout: "half" });
    await delivery.sweep();
    expect(calls).toHaveLength(0);
    settings = settingsOf({ owner: { channel: "other", chat: "other-chat", thread: "t9" } });
    const runId = addRun("j1", "ok", { stdout: "x" });
    await delivery.sweep();
    expect(calls[0].argv).toEqual(["/bin/send", "--chat", "other-chat", "--thread", "t9", "--key", runId]);
  });

  test("a job with no deliver block sends nothing", async () => {
    const { delivery } = build();
    addJob("j1", null);
    addRun("j1", "ok", { stdout: "x" });
    await delivery.sweep();
    expect(calls).toHaveLength(0);
  });

  test("no adapter: no process, and the run says it was not delivered", async () => {
    settings = parseDeliverySettings(JSON.stringify({ owner: OWNER }), {});
    const { delivery, registry } = build();
    addJob("j1");
    const runId = addRun("j1", "ok", { stdout: "x" });
    await delivery.sweep();
    expect(calls).toHaveLength(0);
    expect(registry.get(runId)?.state).toBe("not_delivered");
  });

  test("the fallback variable gives the adapter when the setting has none", () => {
    const parsed = parseDeliverySettings(null, { TOPICS_OWNER_ALERT_COMMAND: JSON.stringify(["/bin/alert", "--to", "{chat}"]) });
    expect(parsed.adapter?.argv).toEqual(["/bin/alert", "--to", "{chat}"]);
    expect(parseDeliverySettings(null, {}).adapter).toBeNull();
  });
});

describe("the adapter command", () => {
  const values = { channel: "c", chat: "", thread: "", title: "T", jobId: "j", runId: "r", key: "k" };
  test("an empty argument takes its option out with it", () => {
    // A value that merely starts with a dash (a negative chat id) is not an option to take out.
    expect(expandArgv(["/bin/send", "{chat}", "{thread}"], { ...values, chat: "-100", thread: "" })).toEqual(["/bin/send", "-100"]);
    // The executable is never filled: a title cannot choose what runs.
    expect(expandArgv(["{title}", "x"], { ...values, title: "/bin/evil" })).toEqual(["{title}", "x"]);
    expect(expandArgv(["/bin/send", "--chat", "{chat}", "--title", "{title}", "-t", "{thread}"], values)).toEqual(["/bin/send", "--title", "T"]);
  });
});

describe("the adapter environment", () => {
  test("the app's own secrets never reach the command", () => {
    const base = { PATH: "/usr/bin", GATEWAY_TOKEN: "t", TOPICS_SECRET_AGE_IDENTITY: "i" };
    const call = adapterCall({ argv: ["/bin/send"], env: {} }, { channel: "", chat: "", thread: "", title: "T", jobId: "j", runId: "r", key: "k" }, "hi", withoutGatewayToken(base));
    expect(call.env.PATH).toBe("/usr/bin");
    expect(call.env.GATEWAY_TOKEN).toBeUndefined();
    expect(call.env.TOPICS_SECRET_AGE_IDENTITY).toBeUndefined();
  });
  test("by default the process environment is stripped the same way", () => {
    process.env.GATEWAY_TOKEN = "leak";
    try {
      const call = adapterCall({ argv: ["/bin/send"], env: {} }, { channel: "", chat: "", thread: "", title: "T", jobId: "j", runId: "r", key: "k" }, "hi");
      expect(call.env.GATEWAY_TOKEN).toBeUndefined();
    } finally { delete process.env.GATEWAY_TOKEN; }
  });
});

describe("once only (R23)", () => {
  test("an adapter that exits non-zero is tried three times, then delivery_failed", async () => {
    const { delivery, registry } = build();
    addJob("j1");
    const runId = addRun("j1", "ok", { stdout: "x" });
    nextResult = () => ({ exitCode: 1, stdout: "", stderr: "boom" });
    await delivery.sweep();
    expect(calls).toHaveLength(3);
    expect(registry.get(runId)).toMatchObject({ state: "delivery_failed", attempts: 3 });
    await delivery.sweep();
    expect(calls).toHaveLength(3);
  });

  test("a restart between the send and its record: nothing is sent a second time", async () => {
    const first = build();
    addJob("j1");
    const runId = addRun("j1", "ok", { stdout: "x" });
    // The process dies after the adapter has the text and before the answer is recorded.
    const crashing = createSender({ registry: first.registry, settings: () => settings, env: {}, runner: async (call) => { calls.push(call); throw new Error("server stopped"); }, wait: async () => { throw new Error("stopped"); } });
    await expect(crashing({ key: runId, kind: "run", text: "x", values: { ...OWNER, title: "t", jobId: "j1", runId } })).rejects.toThrow("stopped");
    expect(first.registry.get(runId)?.state).toBe("delivering");
    // New process: the boot judges the row, then the sweep runs.
    const second = build();
    expect(second.registry.recoverAtBoot()).toBe(1);
    await second.delivery.sweep();
    expect(calls).toHaveLength(1);
    expect(second.registry.get(runId)?.state).toBe("unknown");
  });
});

describe("failure alert (R24)", () => {
  const fail = (job = "j1") => addRun(job, "error", { exitCode: 1 });

  test("three errors in a row raise one alert, with a subject of its own, and not two in one day", async () => {
    const { delivery } = build();
    addJob("j1", null);
    fail(); fail();
    await delivery.sweep();
    expect(notices).toHaveLength(0);
    fail();
    await delivery.sweep();
    fail();
    await delivery.sweep();
    expect(notices).toHaveLength(1);
    expect(notices[0].subject).toBe("job:j1");
    clock.now = new Date("2026-11-27T12:00:00Z");
    fail();
    await delivery.sweep();
    expect(notices).toHaveLength(2);
  });

  test("skipped, missed and interrupted in between do not touch the series", async () => {
    const { delivery } = build();
    addJob("j1", null);
    fail();
    addRun("j1", "skipped"); addRun("j1", "missed"); addRun("j1", "interrupted");
    fail();
    addRun("j1", "skipped");
    fail();
    expect(delivery.failureStreak("j1")).toBe(3);
    await delivery.sweep();
    expect(notices).toHaveLength(1);
  });

  test("fail, fail, skipped gives no alert: a skipped run is not an error", async () => {
    const { delivery } = build();
    addJob("j1", null);
    fail(); fail(); addRun("j1", "skipped");
    expect(delivery.failureStreak("j1")).toBe(2);
    await delivery.sweep();
    expect(notices).toHaveLength(0);
  });

  test("a run that went well resets the series", () => {
    const { delivery } = build();
    addJob("j1", null);
    fail(); fail(); addRun("j1", "ok"); fail();
    expect(delivery.failureStreak("j1")).toBe(1);
  });

  test("in quiet hours it waits for the morning", async () => {
    settings = settingsOf({ quietHours: { from: "22:00", to: "08:00", tz: "UTC" } });
    clock.now = new Date("2026-11-26T22:30:00Z");
    const { delivery } = build();
    addJob("j1", null);
    fail(); fail(); fail();
    await delivery.sweep();
    expect(notices).toHaveLength(0);
    clock.now = new Date("2026-11-27T08:30:00Z");
    await delivery.sweep();
    expect(notices).toHaveLength(1);
  });

  test("the alert also leaves the app through the adapter, once", async () => {
    const { delivery } = build();
    addJob("j1", null);
    fail(); fail(); fail();
    await delivery.sweep();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.sweep();
    expect(calls).toHaveLength(1);
    expect(calls[0].stdin).toContain("Job j1 has failed 3 times in a row");
  });
});
