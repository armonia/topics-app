/**
 * The model fallback cache (`20261121111141-readable-view-cache.sql`): the
 * model is called once per structural SHAPE, never once per result.
 * @covers READABLE-VIEW-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { readableViewFallback } from "./readable-view-fallback";

const MIGRATION_SQL = fs.readFileSync(
  path.join(import.meta.dir, "../db/migrations/20261121111141-readable-view-cache.sql"),
  "utf-8",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION_SQL);
  return db;
}

describe("readableViewFallback — cache by structural signature", () => {
  test("the same shape, seen twice with different values, calls the model once", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => {
      calls++;
      return JSON.stringify({ kind: "counter", label: "Durata", path: "seconds" });
    };
    const a = await readableViewFallback({ db, complete }, "mcp__gateway__timer", { seconds: 12 });
    const b = await readableViewFallback({ db, complete }, "mcp__gateway__timer", { seconds: 900 });
    expect(calls).toBe(1);
    expect(a).toEqual({ kind: "counter", label: "Durata", value: "12" });
    expect(b).toEqual({ kind: "counter", label: "Durata", value: "900" });
  });

  test("a mutated, invented path discards the spec instead of showing a wrong view", async () => {
    const db = freshDb();
    const complete = async () => JSON.stringify({ kind: "counter", label: "Budget", path: "budgetCents" });
    const got = await readableViewFallback({ db, complete }, "mcp__gateway__weird", { seconds: 12 });
    expect(got).toBeNull();
  });

  test("a model answer that is not valid JSON is cached as a miss, not retried every render", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => { calls++; return "not json at all"; };
    await readableViewFallback({ db, complete }, "mcp__gateway__odd", { a: 1 });
    await readableViewFallback({ db, complete }, "mcp__gateway__odd", { a: 2 });
    expect(calls).toBe(1);
  });

  test("a different shape (different keys) is a different signature: a fresh model call", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => { calls++; return JSON.stringify({ kind: "counter", label: "N", path: "n" }); };
    await readableViewFallback({ db, complete }, "mcp__gateway__x", { n: 1 });
    await readableViewFallback({ db, complete }, "mcp__gateway__x", { n: 1, extra: true });
    expect(calls).toBe(2);
  });
});
