/**
 * The eight defects of the review of track 3/8, one test each. Every test is red
 * without its correction.
 *
 * @covers SCHED-05, SCHED-06, SCHED-07, SCHED-08
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobsService, JobsError } from "../jobs-service";
import { buildEngine, fakeRunner, migratedDb } from "../command-test-support";
import { createSpawnAdapter, type AdapterCall, type AdapterResult } from "./adapter";
import { createOwnerAlert } from "./owner-alert";
import { createDeliveryRegistry } from "./registry";
import { createRunDelivery, textToSend } from "./run-delivery";
import { createSender } from "./send";
import { parseDeliverySettings, OWNER_ALERT_ENV, type DeliverySettings } from "./settings";

const DELIVERY_SQL = readFileSync(join(import.meta.dir, "../../db/migrations/20261126100000-scheduled-delivery.sql"), "utf8").replace(/ALTER TABLE app_settings[^;]*;/g, "");
const ADAPTER = { argv: ["/bin/send", "--chat", "{chat}", "--key", "{key}"], env: {} };
const OWNER = { channel: "chan", chat: "owner-chat", thread: "" };
const settingsOf = (patch: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) => parseDeliverySettings(JSON.stringify({ adapter: ADAPTER, owner: OWNER, ...patch }), env);

let db: Database;
let clock: { now: Date };
let calls: AdapterCall[];
let answer: () => AdapterResult;
let settings: DeliverySettings;
let jobs: ReturnType<typeof createJobsService>;
let engine: ReturnType<typeof buildEngine>["engine"];
let delivery: ReturnType<typeof createRunDelivery>;
let registry: ReturnType<typeof createDeliveryRegistry>;
let alertCalls: number;

const newSender = () => createSender({ registry, settings: () => settings, env: {}, wait: async () => {}, runner: async (call) => { calls.push(call); return answer(); } });

beforeEach(() => {
  db = migratedDb();
  db.run(DELIVERY_SQL);
  clock = { now: new Date("2026-11-26T12:00:00Z") };
  calls = [];
  alertCalls = 0;
  answer = () => ({ exitCode: 0, stdout: "", stderr: "" });
  settings = settingsOf();
  engine = buildEngine(db, fakeRunner().runner, clock).engine;
  jobs = createJobsService(db, { engine, now: () => clock.now, projectPath: () => null, agentJobMode: () => "ask" });
  registry = createDeliveryRegistry(db, () => clock.now);
  const sender = newSender();
  const alert = createOwnerAlert({ db, sender, settings: () => settings, now: () => clock.now, notice: () => { alertCalls++; } });
  delivery = createRunDelivery({ db, sender, alert, settings: () => settings, now: () => clock.now });
});

const base = { name: "Report", schedule: { kind: "every", minutes: 10 }, action: { kind: "command", argv: ["echo", "hi"], cwd: "/work/dir" } };

let serial = 0;
function addRun(jobId: string, status: string, stdout: string | null = "out") {
  serial++;
  clock.now = new Date(clock.now.getTime() + 60_000);
  const at = clock.now.toISOString();
  db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at, finished_at, exit_code, stdout_tail)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(`rf-${serial}`, jobId, `k${serial}`, at, status, at, at, stdout);
  return `rf-${serial}`;
}

function addOwnerJob(id: string) {
  db.prepare(`INSERT INTO scheduled_jobs (id, name, schedule_json, action_json, deliver_json, deliver_since, policy_json, enabled, created_at, updated_at)
    VALUES (?, 'Job', '{"kind":"every","minutes":10}', '{"kind":"command"}', '{"to":"owner"}', ?, '{}', 1, ?, ?)`)
    .run(id, "2026-11-26T11:00:00Z", clock.now.toISOString(), clock.now.toISOString());
}

describe("1. the pause of an agent job cannot be walked around (R26)", () => {
  test("run-now is refused until a person turns the job on, and a run never reaches the delivery", async () => {
    const job = jobs.create({ ...base, createdBy: "agent:s1", deliver: { to: "owner" } });
    expect(job.enabled).toBe(false);
    let refused: unknown = null;
    try { jobs.runNow(job.id); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(JobsError);
    expect((refused as JobsError).status).toBe(409);
    expect(engine.runNow(job.id)).toBeNull();
    addRun(job.id, "ok");
    await delivery.sweep();
    expect(calls).toHaveLength(0);
    jobs.update(job.id, { enabled: true });
    expect(jobs.runNow(job.id).jobId).toBe(job.id);
  });
});

describe("1b. a pending run of a one-time job waiting for the owner is closed at launch", () => {
  test("cancelled, never started", () => {
    const job = jobs.create({ ...base, schedule: { kind: "at", at: "2026-11-27T09:00:00.000Z" }, createdBy: "agent:s1" });
    const at = clock.now.toISOString();
    db.prepare("INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at) VALUES ('pend', ?, 'manual:x', ?, 'pending', ?)").run(job.id, at, at);
    engine.tick();
    expect((db.query("SELECT status FROM scheduled_job_runs WHERE id = 'pend'").get() as { status: string }).status).toBe("cancelled");
  });
});

describe("2. a timeout or a signal is never repeated (R23)", () => {
  async function sendOnce(result: AdapterResult) {
    answer = () => result;
    return newSender()({ key: "k-timeout", kind: "run", text: "hi", values: { ...OWNER, title: "t", jobId: "j", runId: "r" } });
  }
  test("a timed out call ends as unknown after ONE call", async () => {
    expect(await sendOnce({ exitCode: 143, stdout: "", stderr: "", timedOut: true })).toBe("unknown");
    expect(calls).toHaveLength(1);
    expect(registry.get("k-timeout")?.detail).toContain("time limit");
  });
  test("an adapter ended by a signal ends as unknown after ONE call", async () => {
    expect(await sendOnce({ exitCode: 137, stdout: "", stderr: "", signalCode: "SIGKILL" })).toBe("unknown");
    expect(calls).toHaveLength(1);
  });
  test("a plain non-zero exit is still tried three times", async () => {
    expect(await sendOnce({ exitCode: 2, stdout: "", stderr: "no" })).toBe("delivery_failed");
    expect(calls).toHaveLength(3);
  });
  test("a real adapter that outlives its limit is killed and reported as timed out", async () => {
    const run = createSpawnAdapter({ timeoutMs: 400, pipeGraceMs: 200 });
    const started = Date.now();
    const result = await run({ argv: [process.execPath, "-e", "setTimeout(() => {}, 20000)"], env: { ...process.env } as Record<string, string>, stdin: "" });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("3. a grandchild holding stdout cannot stop the deliveries", () => {
  test.skipIf(!Bun.which("sh"))("the call returns, timed out, even though a pipe stays open", async () => {
    const argv = ["sh", "-c", "sleep 6 & echo sent"];
    const run = createSpawnAdapter({ timeoutMs: 10_000, pipeGraceMs: 400 });
    const started = Date.now();
    const result = await run({ argv, env: { ...process.env } as Record<string, string>, stdin: "" });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("sent");
  });
});

describe("5. the fallback variable is the delivery to the owner", () => {
  const env = { [OWNER_ALERT_ENV]: JSON.stringify(["/bin/notify", "--key", "{key}", "--title", "{title}"]) };
  test("with no setting at all the owner exists and a `to: owner` job is delivered", async () => {
    settings = parseDeliverySettings(null, env);
    expect(settings.owner).not.toBeNull();
    addOwnerJob("j");
    const id = addRun("j", "ok");
    await delivery.sweep();
    expect(calls).toHaveLength(1);
    expect(registry.get(id)?.state).toBe("delivered");
  });
  test("an explicit destination the command cannot receive is refused, and the detail says why", async () => {
    settings = parseDeliverySettings(null, env);
    const state = await newSender()({ key: "explicit", kind: "run", text: "hi", values: { channel: "c", chat: "room", thread: "", title: "t", jobId: "j", runId: "r" } });
    expect(state).toBe("not_delivered");
    expect(calls).toHaveLength(0);
    expect(registry.get("explicit")?.detail).toContain("placeholder");
  });
});

describe("6. a past one-time instant", () => {
  const past = "2026-11-25T08:00:00.000Z";
  test("an agent cannot create a paused job that could never run", () => {
    expect(() => jobs.create({ ...base, schedule: { kind: "at", at: past }, createdBy: "agent:s1" })).toThrow(JobsError);
  });
  test("turning on a one-time job whose instant is gone answers 400", () => {
    const job = jobs.create({ ...base, schedule: { kind: "at", at: past }, enabled: false });
    let refused: unknown = null;
    try { jobs.update(job.id, { enabled: true }); } catch (error) { refused = error; }
    expect((refused as JobsError).status).toBe(400);
  });
});

describe("7. a wrong quiet-hours zone", () => {
  test("is refused when the settings are read, and the sweep still delivers", async () => {
    settings = settingsOf({ quietHours: { from: "22:00", to: "08:00", tz: "Mars/Olympus" } });
    expect(settings.quietHours).toBeNull();
    addOwnerJob("j");
    for (let i = 0; i < 3; i++) addRun("j", "error", i === 2 ? "still delivered" : null);
    await delivery.sweep();
    expect(calls.some((call) => call.stdin === "still delivered")).toBe(true);
  });
  test("an alert that throws does not hold back the outcomes", async () => {
    const broken = createRunDelivery({ db, sender: newSender(), alert: (() => { throw new Error("boom"); }) as never, settings: () => settings, now: () => clock.now });
    addOwnerJob("j");
    for (let i = 0; i < 3; i++) addRun("j", "error", i === 2 ? "after the alert" : null);
    await broken.sweep();
    expect(calls.map((call) => call.stdin)).toContain("after the alert");
  });
});

describe("8. adding a delivery does not send the history", () => {
  test("only runs finished after the delivery block was added go out", async () => {
    const job = jobs.create({ ...base });
    const old = addRun(job.id, "ok", "old news");
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    jobs.update(job.id, { deliver: { to: "owner" } });
    await delivery.sweep();
    expect(calls).toHaveLength(0);
    expect(registry.get(old)).toBeNull();
    const fresh = addRun(job.id, "ok", "new news");
    await delivery.sweep();
    expect(calls.map((call) => call.stdin)).toEqual(["new news"]);
    expect(registry.get(fresh)?.state).toBe("delivered");
  });
});

describe("minor findings", () => {
  test("NO_REPLY as the last line says nothing", () => {
    expect(textToSend({ status: "ok", stdout_tail: "thinking about it\nNO_REPLY", exit_code: 0 }, "J", true)).toBeNull();
    expect(textToSend({ status: "ok", stdout_tail: "NO_REPLY is a word here", exit_code: 0 }, "J", true)).toBe("NO_REPLY is a word here");
  });
  test("a job that is already paused raises no failure alert", async () => {
    const job = jobs.create({ ...base, deliver: { to: "owner" }, enabled: false });
    for (let i = 0; i < 3; i++) addRun(job.id, "error", null);
    await delivery.sweep();
    expect(alertCalls).toBe(0);
    jobs.update(job.id, { enabled: true });
    await delivery.sweep();
    expect(alertCalls).toBe(1);
  });
});
