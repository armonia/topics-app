/**
 * The model fallback cache (`20261121111141-readable-view-cache.sql`): the
 * model is called once per structural SHAPE, never once per result.
 * @covers READABLE-VIEW-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import type { AIProvider } from "../providers";
import { completeWith, readableViewFallback } from "./readable-view-fallback";

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
    expect(a).toEqual({ kind: "counter", label: "Durata", value: { text: "12" } });
    expect(b).toEqual({ kind: "counter", label: "Durata", value: { text: "900" } });
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

  test("completeWith wires a real AIProvider's complete() with the readable-view purpose and model", async () => {
    let seenPrompt = "";
    let seenOptions: { model?: string; purpose?: string } = {};
    const provider = {
      complete: async (messages: Array<{ content: string }>, options: { model?: string; purpose?: string }) => {
        seenPrompt = messages[0]?.content ?? "";
        seenOptions = options;
        return { content: '{"kind":"counter","label":"N","path":"n"}' };
      },
    } as unknown as AIProvider;
    const db = freshDb();
    const got = await readableViewFallback({ db, complete: completeWith(provider, "claude-haiku-5-5") }, "mcp__x__y", { n: 3 });
    expect(got).toEqual({ kind: "counter", label: "N", value: { text: "3" } });
    expect(seenPrompt).toContain("n: number");
    expect(seenOptions).toEqual({ model: "claude-haiku-5-5", purpose: "readable-view" });
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

describe("readableViewFallback: provider errors and nested shapes", () => {
  const nested = { data: { items: [{ name: "a", n: 1 }, { name: "b", n: 2 }] }, total: 2 };

  test("a complete() that throws once is not cached: the second call answers", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => {
      calls++;
      if (calls === 1) throw new Error("provider down");
      return JSON.stringify({ kind: "counter", label: "Total", path: "total" });
    };
    expect(await readableViewFallback({ db, complete }, "srv__t", nested)).toBeNull();
    expect(await readableViewFallback({ db, complete }, "srv__t", nested)).toEqual({ kind: "counter", label: "Total", value: { text: "2" } });
    expect(calls).toBe(2);
  });

  test("an invalid answer IS cached as no view", async () => {
    const db = freshDb();
    let calls = 0;
    const complete = async () => { calls++; return "not json"; };
    await readableViewFallback({ db, complete }, "srv__t", nested);
    await readableViewFallback({ db, complete }, "srv__t", nested);
    expect(calls).toBe(1);
  });

  test("a nested shape with a model answer faithful to the prompt gives a view", async () => {
    const db = freshDb();
    const prompts: string[] = [];
    const complete = async (p: string) => {
      prompts.push(p);
      return JSON.stringify({ kind: "table", rowsPath: "data.items[]", columns: [{ label: "Name", path: "data.items[].name" }, { label: "N", path: "n" }] });
    };
    const view = await readableViewFallback({ db, complete }, "srv__t", nested);
    expect(prompts[0]).toContain("data.items[].name");
    expect(prompts[0]).toContain("RELATIVI");
    expect(view).toEqual({ kind: "table", columns: ["Name", "N"], rows: [[{ text: "a" }, { text: "1" }], [{ text: "b" }, { text: "2" }]] });
  });
});
