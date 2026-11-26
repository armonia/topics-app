/**
 * POST /api/readable-view: input validation and one model call per shape.
 * @covers READABLE-VIEW-04
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types";
import { createReadableViewRouter } from "./readable-view";

const SQL = fs.readFileSync(path.join(import.meta.dir, "../db/migrations/20261121111141-readable-view-cache.sql"), "utf-8");

function setup() {
  const db = new Database(":memory:");
  db.exec(SQL);
  let calls = 0;
  const ctx = { db, json: (b: unknown, status = 200) => Response.json(b, { status }) } as unknown as AppContext;
  const router = createReadableViewRouter(ctx, () => async () => {
    calls++;
    return JSON.stringify({ kind: "counter", label: "Seconds", path: "seconds" });
  });
  const post = (body: unknown) =>
    router(new Request("http://x/api/readable-view", { method: "POST", body: JSON.stringify(body) }), new URL("http://x/api/readable-view"), "/api/readable-view", "POST") as Promise<Response>;
  return { post, calls: () => calls };
}

describe("readable-view route", () => {
  test("rejects a body without toolName/value", async () => {
    const { post } = setup();
    expect((await post({ value: {} })).status).toBe(400);
    expect((await post({ toolName: "t" })).status).toBe(400);
  });
  test("two results of the same shape call the model once, and values come from the result", async () => {
    const { post, calls } = setup();
    const a = await (await post({ toolName: "srv__t", value: { seconds: 5 } })).json();
    const b = await (await post({ toolName: "srv__t", value: { seconds: 9 } })).json();
    expect(a.view).toEqual({ kind: "counter", label: "Seconds", value: { text: "5" } });
    expect(b.view.value).toEqual({ text: "9" });
    expect(calls()).toBe(1);
  });
  test("ignores other paths", async () => {
    
    const ctx = { db: new Database(":memory:"), json: Response.json } as unknown as AppContext;
    const r = createReadableViewRouter(ctx);
    expect(await r(new Request("http://x/api/other"), new URL("http://x/api/other"), "/api/other", "GET")).toBeNull();
  });
});
