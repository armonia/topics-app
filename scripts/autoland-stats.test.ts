/**
 * The automatic-land probe counts landed-alone, landed-by-hand, failures and
 * rework on a board of known shape, and says "none yet" rather than "0%".
 *
 * @covers LAND-05
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AUTO_NOTE, autoLandStats, render } from "./autoland-stats";

const NOW = "2026-11-19T00:00:00.000Z";

function board(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, completed_at TEXT, reopened_at TEXT)`);
  db.run(`CREATE TABLE task_comments (task_id TEXT, author TEXT, kind TEXT, content TEXT, created_at TEXT)`);
  return db;
}
function card(db: Database, id: string, o: { auto?: boolean; merged?: string; red?: boolean; reopened?: string; completed?: string; project?: string } = {}) {
  db.run("INSERT INTO tasks VALUES (?, ?, 'done', ?, ?)", [id, o.project ?? "p", o.completed ?? "2026-11-18T10:00:00.000Z", o.reopened ?? null]);
  if (o.merged) db.run("INSERT INTO task_comments VALUES (?, 'system', 'service', ?, '2026-11-18T09:00:00.000Z')", [id, `Mergiato su main (commit ${o.merged}).`]);
  if (o.auto) db.run("INSERT INTO task_comments VALUES (?, 'system', 'service', ?, '2026-11-18T08:59:00.000Z')", [id, `${AUTO_NOTE}: la barra della board è verde`]);
  if (o.red) db.run("INSERT INTO task_comments VALUES (?, 'system', 'status', 'done→todo · la CI su main è rossa dopo il land', '2026-11-18T09:30:00.000Z')", [id]);
}

describe("autoLandStats", () => {
  test("splits alone from by hand, and counts red, revert and reopen only after an automatic land", () => {
    const db = board();
    card(db, "a1", { auto: true, merged: "aaaaaaa1" });
    card(db, "a2", { auto: true, merged: "bbbbbbb2", red: true });
    card(db, "a3", { auto: true, merged: "ccccccc3", reopened: "2026-11-18T12:00:00.000Z" });
    card(db, "a4", { auto: true, merged: "ddddddd4" });
    card(db, "h1", { merged: "eeeeeee5", red: true });
    card(db, "h2", { merged: "fffffff6" });
    card(db, "n1");
    card(db, "old", { auto: true, merged: "9999999", completed: "2026-11-01T00:00:00.000Z" });
    card(db, "other", { auto: true, merged: "8888888", project: "q" });
    const s = autoLandStats(db, { days: 7, projectId: "p", now: NOW, revertsOf: (c) => c.filter((x) => x === "ddddddd4") });
    expect(s).toEqual({ days: 7, closed: 7, landedAlone: 4, landedByPerson: 2, failedAfterAuto: 2, reworkedAfterAuto: 1, revertedAuto: ["ddddddd4"] });
    expect(render(s)).toContain("change failure 50%");
  });

  test("with no automatic land there is no rate to print", () => {
    const db = board();
    card(db, "h1", { merged: "eeeeeee5" });
    const s = autoLandStats(db, { days: 7, now: NOW });
    expect(s.landedAlone).toBe(0);
    expect(render(s)).toContain("nessun land automatico ancora");
  });
});
