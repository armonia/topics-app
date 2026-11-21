/**
 * The periodic opener: fires the alert hook once per pause, skips a failed read.
 * @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ProjectQuotaRow } from "../../shared/usage-shapes";
import { readProjectQuotaRow } from "./project-pause";
import { runProjectQuotaPauseSweep } from "./project-quota-sweep";

const MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261119000000-project-quota.sql")).text();

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION);
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
    expect(readProjectQuotaRow(db, "p")).toBeNull();
  });

  test("the outside-projects bucket (projectId null) is never paused", () => {
    const db = makeDb();
    runProjectQuotaPauseSweep(db, { computeQuota: quotaOf([{ projectId: null, points24h: 999 }]) });
    expect(readProjectQuotaRow(db, "p")).toBeNull();
  });

  test("a quota read that throws skips the round instead of crashing it", () => {
    const db = makeDb();
    expect(() => runProjectQuotaPauseSweep(db, { computeQuota: () => { throw new Error("boom"); }, log: () => {} })).not.toThrow();
  });
});
