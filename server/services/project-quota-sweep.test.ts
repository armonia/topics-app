/**
 * The periodic opener: fires the alert hook once per pause, skips a failed read.
 * @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ProjectQuotaRow } from "../../shared/usage-shapes";
import { readProjectQuotaRow } from "./project-pause";
import { resetPausePointsForTests, runProjectQuotaPauseSweep } from "./project-quota-sweep";
import { PROJECT_QUOTA_SCHEMA } from "../../tests/helpers/project-quota-schema";

const MIGRATION = PROJECT_QUOTA_SCHEMA;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION);
  db.run("INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES ('p', 10, 'x')");
  return db;
}

function quotaOf(rows: Array<{ projectId: string | null; points24h: number | null; projectPath?: string | null }>) {
  return () => ({ quotaHistory: true, projects: rows.map((r) => ({ projectPath: r.projectPath ?? null, points7d: null, weighted24h: 0, weighted7d: 0, limit: null, surfaces: {} as ProjectQuotaRow["surfaces"], topChats: [], ...r })) });
}

describe("runProjectQuotaPauseSweep", () => {
  test("opens a pause once and fires the alert hook exactly once", () => {
    const db = makeDb();
    let fired = 0;
    runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: "p", points24h: 10.4, projectPath: "/p" }]), onPauseOpened: () => { fired++; } });
    expect(readProjectQuotaRow(db, "p")?.pausedAt).toBeTruthy();
    expect(fired).toBe(1);
    // Already open: a second sweep over the same project does not fire again.
    runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: "p", points24h: 10.4, projectPath: "/p" }]), onPauseOpened: () => { fired++; } });
    expect(fired).toBe(1);
  });

  test("a project under its limit never opens a pause", () => {
    const db = makeDb();
    runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: "p", points24h: 3, projectPath: "/p" }]) });
    expect(readProjectQuotaRow(db, "p")?.pausedAt ?? null).toBeNull();
  });

  test("the outside-projects bucket (projectId null) is never paused", () => {
    const db = makeDb();
    runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: null, points24h: 999 }]) });
    expect(readProjectQuotaRow(db, "p")?.pausedAt ?? null).toBeNull();
  });

  test("a quota read that throws skips the round instead of crashing it", () => {
    const db = makeDb();
    expect(() => runProjectQuotaPauseSweep(db, { computeQuota: () => { throw new Error("boom"); }, log: () => {} })).not.toThrow();
  });

  test("logs, per paused project, the points burned after the pause opened", () => {
    resetPausePointsForTests();
    const db = makeDb();
    const lines: string[] = [];
    const sweep = (points: number) => runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: "p", points24h: points, projectPath: "/p" }]), log: (m) => lines.push(m) });
    sweep(10.5); // opens
    sweep(12.0); // turns already running burn 1.5 more
    expect(lines.at(-1)).toContain("1.50 points burned since the pause opened");
    sweep(2); // window back under the limit: closes, no more lines
    const n = lines.length;
    sweep(2);
    expect(lines).toHaveLength(n);
  });
});
