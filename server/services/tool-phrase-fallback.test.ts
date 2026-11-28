/**
 * The phrase fallback for an unknown MCP tool name: one model call per name,
 * cached, and the migration that holds it runs on a synthetic DB.
 * @covers READABLE-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { toolPhraseFallback } from "./tool-phrase-fallback";
import { readReadableViewSettings, writeReadableViewSettings } from "./readable-view-settings";

const MIGRATION_SQL = fs.readFileSync(path.join(import.meta.dir, "../db/migrations/20261128120000-readable-view-settings-phrases.sql"), "utf-8");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION_SQL);
  return db;
}

describe("migration 20261128120000 on a synthetic DB", () => {
  test("creates the tables with the fallback on, and a second run changes nothing", () => {
    const db = freshDb();
    writeReadableViewSettings(db, { model: "m1" });
    db.exec(MIGRATION_SQL);
    expect(readReadableViewSettings(db)).toEqual({ fallbackEnabled: true, model: "m1" });
    expect(db.prepare("SELECT count(*) AS n FROM tool_phrase_cache").get()).toEqual({ n: 0 });
  });
});

describe("toolPhraseFallback", () => {
  const answer = JSON.stringify({ text: "Legge un ordine", category: "read" });

  test("two calls for the same new tool call the model once", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => { calls++; return answer; };
    const a = await toolPhraseFallback({ db, complete }, "mcp__shop__fetch_order", ["id"]);
    const b = await toolPhraseFallback({ db, complete }, "mcp__shop__fetch_order", ["id", "x"]);
    expect(a).toEqual({ text: "Legge un ordine", category: "read" });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });

  test("the prompt carries argument keys, never values", async () => {
    const prompts: string[] = [];
    await toolPhraseFallback({ db: freshDb(), complete: async (p) => { prompts.push(p); return answer; } }, "mcp__a__b", ["order_id"]);
    expect(prompts[0]).toContain("order_id");
  });

  test("a provider error is not cached; an unusable answer is", async () => {
    const db = freshDb();
    let calls = 0;
    const flaky = async () => { calls++; if (calls === 1) throw new Error("down"); return "nope"; };
    expect(await toolPhraseFallback({ db, complete: flaky }, "mcp__a__b", [])).toBeNull();
    expect(await toolPhraseFallback({ db, complete: flaky }, "mcp__a__b", [])).toBeNull();
    expect(await toolPhraseFallback({ db, complete: flaky }, "mcp__a__b", [])).toBeNull();
    expect(calls).toBe(2);
  });

  test("a category outside the closed list is rejected", async () => {
    const complete = async () => JSON.stringify({ text: "Fa una cosa", category: "teleport" });
    expect(await toolPhraseFallback({ db: freshDb(), complete }, "mcp__a__c", [])).toBeNull();
  });
});
