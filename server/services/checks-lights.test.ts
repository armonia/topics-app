/**
 * THE «running» LIGHT, AND THE TWO CLOCKS THAT BELIEVED IT.
 *
 * `isChecksHold` and the periodic sweep lived in `server.ts`, which has no test
 * file, so the half of T4.3 that actually decides — the predicate the stall
 * judge and the StaleStream sweep read — was covered by nothing. Measured on
 * 2026-09-17: 89 boots found at least one light already lit, 1253 rearms of the
 * stall judge, and a StaleStream sweep answering `extend` to every mute turn of
 * those sessions.
 *
 * @covers KANBAN-89
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { checksHoldTaskId, isChecksHold, sweepStaleChecksLights } from "./checks-lights";
import { TASKS_DDL, TASKS_FK_STUBS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  return db;
}

/** A card in progress, bound to `topicId`, with its checks light as given. */
function card(db: Database, id: string, topicId: string | null, checksState: string | null, status = "in_progress") {
  if (topicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [topicId]);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, checks_state)
     VALUES (?, 'board', ?, ?, ?, ?, ?, ?)`,
    [id, id, status, now, now, topicId, checksState],
  );
  return id;
}

describe("isChecksHold", () => {
  const TOPIC = "3f2a1b0c-9d8e-4f5a-8b7c-6d5e4f3a2b1c";
  const KEY = `topic:${TOPIC.slice(0, 8)}`;

  test("a row that still says 'running' with no live run is NOT a hold", () => {
    const db = freshDb();
    card(db, "orfana", TOPIC, "running");
    // The gate's registry is the whole answer, and it does not know this run:
    // `measure()` ended without the terminal record, the key was dropped, and
    // nobody will ever write the verdict. Before T4.3 the row alone said yes,
    // and it said yes for as long as the process lived.
    expect(isChecksHold(db, () => false, KEY)).toBe(false);
  });

  test("a live or queued run IS a hold, whatever the row says", () => {
    const db = freshDb();
    card(db, "viva", TOPIC, null);
    // `isRunning` is true for a run that is going AND for one queued behind
    // another card's lane: both are minutes in which the agent waits on us.
    expect(isChecksHold(db, (id) => id === "viva", KEY)).toBe(true);
  });

  test("no registry yet means no hold, and the key resolves the card by topic prefix", () => {
    const db = freshDb();
    card(db, "viva", TOPIC, "running");
    expect(isChecksHold(db, null, KEY)).toBe(false);
    expect(checksHoldTaskId(db, KEY)).toBe("viva");
    // Past `in_progress` there is no delivery of ours left to wait for.
    db.run("UPDATE tasks SET status = 'review' WHERE id = 'viva'");
    expect(checksHoldTaskId(db, KEY)).toBeNull();
    expect(checksHoldTaskId(db, "topic:")).toBeNull();
  });
});

describe("sweepStaleChecksLights", () => {
  function spy(lit: string[], live: string[] | null) {
    const announced: string[] = []; const resumed: string[] = []; const said: string[] = [];
    const cleared: string[] = [];
    const out = sweepStaleChecksLights({
      clearStale: (isLive) => { const off = lit.filter((id) => !isLive(id)); cleared.push(...off); return off; },
      isRunning: live ? (id) => live.includes(id) : null,
      announce: (id) => announced.push(id),
      resume: (id) => resumed.push(id),
      warn: (line) => said.push(line),
    });
    return { out, announced, resumed, said, cleared };
  }

  test("the orphan is switched off, announced AND resumed; the live one is untouched", () => {
    const r = spy(["orfana", "viva"], ["viva"]);
    expect(r.out).toEqual(["orfana"]);
    expect(r.announced).toEqual(["orfana"]);
    // WITHOUT THIS THE TWO HALVES PULL APART: the light is honest and the card
    // is parked with no round, while the boot resume gives up after three.
    expect(r.resumed).toEqual(["orfana"]);
    expect(r.said.join("\n")).toContain("1 spie 'running' spente");
  });

  test("before the route exists nothing is touched: every light is the boot sweep's", () => {
    const r = spy(["orfana"], null);
    expect(r.out).toEqual([]);
    expect(r.cleared).toEqual([]);
    expect(r.resumed).toEqual([]);
    expect(r.said).toEqual([]);
  });

  test("nothing orphaned says nothing", () => {
    const r = spy(["viva"], ["viva"]);
    expect(r.out).toEqual([]);
    expect(r.said).toEqual([]);
  });

  test("a resume that throws still leaves the light off and the board told", () => {
    const announced: string[] = [];
    const out = sweepStaleChecksLights({
      clearStale: () => ["orfana"],
      isRunning: () => false,
      announce: (id) => announced.push(id),
      resume: () => { throw new Error("la rotta e' andata"); },
      warn: () => {},
    });
    expect(out).toEqual(["orfana"]);
    expect(announced).toEqual(["orfana"]);
  });
});
