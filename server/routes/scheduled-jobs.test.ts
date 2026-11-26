/**
 * `/api/scheduled-jobs`: create, change, delete, run now, postpone, history,
 * the pause of the starts, and the two rules a failure of the old engine
 * taught: a recurring job never changes kind and is never archived by itself.
 *
 * @covers SCHED-04
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createScheduledJobsRouter } from "./scheduled-jobs";
import { createJobsService } from "../schedule/jobs-service";
import { buildEngine, fakeRunner, migratedDb, runsOf } from "../schedule/command-test-support";
import { isGuestAllowedPath } from "../lib/grants";
import type { AppContext } from "../types";

let db: Database;
let clock = { now: new Date("2026-01-01T08:50:00.000Z") };
let fake: ReturnType<typeof fakeRunner>;
let built: ReturnType<typeof buildEngine>;
let router: ReturnType<typeof createScheduledJobsRouter>;

beforeEach(() => {
  db = migratedDb();
  clock = { now: new Date("2026-01-01T08:50:00.000Z") };
  fake = fakeRunner();
  built = buildEngine(db, fake.runner, clock);
  const jobs = createJobsService(db, { engine: built.engine, now: () => clock.now, projectPath: (id) => id === "proj" ? "/work/project" : null });
  const ctx = { json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }) } as unknown as AppContext;
  router = createScheduledJobsRouter(ctx, jobs, {
    pauseStarts: () => built.engine.pauseStarts(), resumeStarts: () => built.engine.resumeStarts(),
    isPaused: () => built.engine.isPaused(), inFlight: () => built.engine.inFlight(),
  });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const res = await router(req, url, url.pathname, method);
  if (!res) return { status: 404, data: null };
  return { status: res.status, data: await res.json() };
}

const COMMAND = { kind: "command", argv: ["echo", "hi"], cwd: "/work/dir" };
const DAILY = { kind: "cron", expr: "0 9 * * *", tz: "UTC" };
const create = (extra: Record<string, unknown> = {}) => call("POST", "/api/scheduled-jobs", { name: "Daily", schedule: DAILY, action: COMMAND, ...extra });

describe("create", () => {
  test("writes the time limit and the zone on the job, and computes the next run", async () => {
    const { status, data } = await create();
    expect(status).toBe(201);
    expect(data.action.timeoutSec).toBe(3600);
    expect(data.schedule).toEqual(DAILY);
    expect(data.nextRunAt).toBe("2026-01-01T09:00:00.000Z");
    expect(data.enabled).toBe(true);
  });

  test("takes an id and an initial state when they are given", async () => {
    const { status, data } = await create({ id: "imported:1", enabled: false });
    expect(status).toBe(201);
    expect(data).toMatchObject({ id: "imported:1", enabled: false, nextRunAt: null });
    expect((await create({ id: "imported:1" })).status).toBe(409);
    expect((await create({ id: "bad id!" })).status).toBe(400);
  });

  test("refuses what cannot run", async () => {
    expect((await create({ action: { kind: "command", argv: [] } })).status).toBe(400);
    expect((await create({ action: { ...COMMAND, timeoutSec: 0 } })).status).toBe(400);
    expect((await create({ action: { kind: "command", argv: ["true"] } })).status).toBe(400); // no directory, no project
    expect((await create({ projectId: "nope" })).status).toBe(400);
    expect((await create({ schedule: { kind: "at", at: "2025-01-01T00:00:00.000Z" } })).status).toBe(400);
    expect((await create({ schedule: { kind: "cron", expr: "61 * * * *", tz: "UTC" } })).status).toBe(400);
    expect((await create({ name: "  " })).status).toBe(400);
  });

  test("a job with a project and no cwd is accepted", async () => {
    expect((await create({ projectId: "proj", action: { kind: "command", argv: ["true"] } })).status).toBe(201);
  });
});

describe("list, change, delete", () => {
  test("lists the jobs with the state of the starts", async () => {
    await create();
    const { data } = await call("GET", "/api/scheduled-jobs");
    expect(data.jobs).toHaveLength(1);
    expect(data).toMatchObject({ startsPaused: false, inFlight: 0 });
  });

  test("a change keeps the kind of the job and of its action", async () => {
    const { data: job } = await create();
    const renamed = await call("PATCH", `/api/scheduled-jobs/${job.id}`, { name: "Renamed", schedule: { kind: "cron", expr: "30 9 * * *", tz: "UTC" } });
    expect(renamed.data).toMatchObject({ name: "Renamed", nextRunAt: "2026-01-01T09:30:00.000Z" });
    expect((await call("PATCH", `/api/scheduled-jobs/${job.id}`, { schedule: { kind: "at", at: "2026-02-01T00:00:00.000Z" } })).status).toBe(400);
    expect((await call("PATCH", `/api/scheduled-jobs/${job.id}`, { action: { kind: "agent" } })).status).toBe(400);
    expect((await call("GET", `/api/scheduled-jobs/${job.id}`)).data.schedule.kind).toBe("cron");
  });

  test("deleting stops the run in flight (cancelled), keeps the history, and the job leaves the list", async () => {
    const { data: job } = await create({ schedule: { kind: "every", minutes: 10 } });
    clock.now = new Date("2026-01-01T09:00:00.000Z");
    built.engine.tick();
    expect(runsOf(db, job.id)[0].status).toBe("running");
    expect((await call("DELETE", `/api/scheduled-jobs/${job.id}`)).status).toBe(200);
    expect(fake.log).toEqual(["stop:proc-1"]);
    expect(runsOf(db, job.id)[0].status).toBe("cancelled");
    expect((await call("GET", "/api/scheduled-jobs")).data.jobs).toEqual([]);
    expect((await call("GET", `/api/scheduled-jobs/${job.id}`)).status).toBe(404);
    expect((await call("GET", `/api/scheduled-jobs/${job.id}/runs`)).data.runs).toHaveLength(1);
  });
});

describe("run now and history", () => {
  test("run now starts the command at once and does not move the next occurrence", async () => {
    const { data: job } = await create();
    const run = await call("POST", `/api/scheduled-jobs/${job.id}/run`);
    expect(run.status).toBe(202);
    expect(run.data.status).toBe("running");
    expect(run.data.occurrenceKey.startsWith("manual:")).toBe(true);
    expect((await call("GET", `/api/scheduled-jobs/${job.id}`)).data.nextRunAt).toBe("2026-01-01T09:00:00.000Z");
    fake.processes.get("proc-1")!.stdout = "the output";
    built.action.ended({ processId: "proc-1", runId: run.data.id, exitCode: 0, stopped: false, timedOut: false });
    const { data } = await call("GET", `/api/scheduled-jobs/${job.id}/runs`);
    expect(data.runs[0]).toMatchObject({ status: "ok", exitCode: 0, stdout: "the output" });
  });
});

describe("a recurring job stays what it is", () => {
  test("a postponed occurrence leaves the job recurring, with the same times", async () => {
    const { data: job } = await create();
    const postponed = await call("POST", `/api/scheduled-jobs/${job.id}/postpone`, { minutes: 30 });
    expect(postponed.status).toBe(200);
    expect(postponed.data).toMatchObject({ enabled: true, nextRunAt: "2026-01-01T09:30:00.000Z", schedule: DAILY });
    clock.now = new Date("2026-01-01T09:31:00.000Z");
    built.engine.tick();
    expect(runsOf(db, job.id).map(run => run.status)).toEqual(["running"]);
    const after = (await call("GET", `/api/scheduled-jobs/${job.id}`)).data;
    expect(after).toMatchObject({ enabled: true, schedule: DAILY, nextRunAt: "2026-01-02T09:00:00.000Z" });
    const row = db.query("SELECT deleted_at FROM scheduled_jobs WHERE id = ?").get(job.id) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  test("an occurrence cannot be moved earlier, into the past, or past the one after it", async () => {
    const { data: job } = await create();
    expect((await call("POST", `/api/scheduled-jobs/${job.id}/postpone`, { until: "2026-01-01T08:55:00.000Z" })).status).toBe(400);
    expect((await call("POST", `/api/scheduled-jobs/${job.id}/postpone`, { minutes: 60 * 25 })).status).toBe(400);
    expect((await call("POST", `/api/scheduled-jobs/${job.id}/postpone`, {})).status).toBe(400);
  });

  test("a one-time job postponed stays one-time at the new time", async () => {
    const { data: job } = await create({ schedule: { kind: "at", at: "2026-01-01T10:00:00.000Z" } });
    const { data } = await call("POST", `/api/scheduled-jobs/${job.id}/postpone`, { minutes: 15 });
    expect(data.schedule).toEqual({ kind: "at", at: "2026-01-01T10:15:00.000Z" });
    expect(data.nextRunAt).toBe("2026-01-01T10:15:00.000Z");
  });

  test("nothing in the API archives a job but an explicit delete: after a failed run the job is still enabled and recurring", async () => {
    const { data: job } = await create({ schedule: { kind: "every", minutes: 10 } });
    clock.now = new Date("2026-01-01T09:00:00.000Z");
    built.engine.tick();
    built.action.ended({ processId: "proc-1", runId: runsOf(db, job.id)[0].id, exitCode: 1, stopped: false, timedOut: false });
    const after = (await call("GET", `/api/scheduled-jobs/${job.id}`)).data;
    expect(after).toMatchObject({ enabled: true, schedule: { kind: "every", minutes: 10 } });
    expect(after.nextRunAt).not.toBeNull();
  });
});

describe("pause and resume of the starts (R28)", () => {
  test("while paused no run starts; after the resume the due job goes", async () => {
    await create({ schedule: { kind: "every", minutes: 10 } });
    expect((await call("POST", "/api/scheduled-jobs/starts/pause")).data.startsPaused).toBe(true);
    clock.now = new Date("2026-01-01T09:00:00.000Z");
    built.engine.tick();
    expect(fake.started).toHaveLength(0);
    expect((await call("POST", "/api/scheduled-jobs/starts/resume")).data.startsPaused).toBe(false);
    built.engine.tick();
    expect(fake.started).toHaveLength(1);
    expect((await call("GET", "/api/scheduled-jobs")).data.inFlight).toBe(1);
  });
});

describe("guests", () => {
  test("the path is not on the guest allowlist: the gate answers 403 before any router", () => {
    expect(isGuestAllowedPath("/api/scheduled-jobs")).toBe(false);
    expect(isGuestAllowedPath("/api/scheduled-jobs/abc/run")).toBe(false);
  });
});
