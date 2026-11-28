/**
 * A job an agent creates is born in pause (rule R26): always with a delivery,
 * and with `ask` (the default) always. Not a security fence, a speed bump.
 *
 * @covers SCHED-08
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createJobsService } from "../jobs-service";
import { buildEngine, fakeRunner, migratedDb } from "../command-test-support";

let db: Database;
let told: string[];
let mode: "ask" | "auto";
let jobs: ReturnType<typeof createJobsService>;

beforeEach(() => {
  db = migratedDb();
  told = [];
  mode = "ask";
  const clock = { now: new Date("2026-01-01T08:50:00.000Z") };
  const built = buildEngine(db, fakeRunner().runner, clock);
  jobs = createJobsService(db, { engine: built.engine, now: () => clock.now, projectPath: () => null, agentJobMode: () => mode, onPausedByAgent: (job) => told.push(job.id) });
});

const base = { name: "Report", schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" }, action: { kind: "command", argv: ["echo", "hi"], cwd: "/work/dir" } };

describe("agent-made jobs", () => {
  test("with ask, every job an agent creates is born paused and the person is told", () => {
    const job = jobs.create({ ...base, createdBy: "agent:s1" });
    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeNull();
    expect(told).toEqual([job.id]);
  });

  test("with auto, a job without delivery runs, and one with delivery is still born paused", () => {
    mode = "auto";
    expect(jobs.create({ ...base, createdBy: "agent:s1" }).enabled).toBe(true);
    expect(jobs.create({ ...base, createdBy: "agent:s1", deliver: { to: "owner" } }).enabled).toBe(false);
    expect(told).toHaveLength(1);
  });

  test("a job a person creates is not touched", () => {
    expect(jobs.create({ ...base, deliver: { to: "owner" } }).enabled).toBe(true);
    expect(told).toHaveLength(0);
  });
});
