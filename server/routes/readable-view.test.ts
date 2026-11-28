/**
 * POST /api/readable-view: input validation, one model call per shape, a NDJSON
 * body, and the model/switch read from the server settings.
 * @covers READABLE-VIEW-04
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../types";
import { createReadableViewRouter } from "./readable-view";

const SQL = ["20261121111141-readable-view-cache.sql", "20261128120000-readable-view-settings-phrases.sql"]
  .map((f) => fs.readFileSync(path.join(import.meta.dir, "../db/migrations", f), "utf-8"))
  .join("\n");

/** The views a NDJSON body carries, in order, and whether it ended with done. */
async function readStream(res: Response): Promise<{ views: any[]; done: boolean }> {
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { views: lines.filter((l) => l.view).map((l) => l.view), done: lines.some((l) => l.done) };
}

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
  return { post, calls: () => calls, db, router };
}

describe("readable-view route", () => {
  test("rejects a body without toolName/value", async () => {
    const { post } = setup();
    expect((await post({ value: {} })).status).toBe(400);
    expect((await post({ toolName: "t" })).status).toBe(400);
  });
  test("two results of the same shape call the model once, and values come from the result", async () => {
    const { post, calls } = setup();
    const a = await readStream(await post({ toolName: "srv__t", value: { seconds: 5 } }));
    const b = await readStream(await post({ toolName: "srv__t", value: { seconds: 9 } }));
    expect(a.views.at(-1)).toEqual({ kind: "counter", label: "Seconds", value: { text: "5" } });
    expect(b.views.at(-1).value).toEqual({ text: "9" });
    expect(a.done && b.done).toBe(true);
    expect(calls()).toBe(1);
  });
  test("a long table arrives as growing views, the last one whole", async () => {
    const db = new Database(":memory:");
    db.exec(SQL);
    const ctx = { db, json: Response.json } as unknown as AppContext;
    const router = createReadableViewRouter(ctx, () => async () => JSON.stringify({ kind: "table", rowsPath: "rows", columns: [{ label: "N", path: "n" }] }));
    const value = { rows: Array.from({ length: 25 }, (_, i) => ({ n: i })) };
    const res = (await router(new Request("http://x/api/readable-view", { method: "POST", body: JSON.stringify({ toolName: "t", value }) }), new URL("http://x/api/readable-view"), "/api/readable-view", "POST")) as Response;
    const { views, done } = await readStream(res);
    expect(views.map((v) => v.rows.length)).toEqual([10, 20, 25]);
    expect(done).toBe(true);
  });
  test("the model comes from the server settings, never from the request", async () => {
    const { post, calls, db } = setup();
    db.prepare("UPDATE readable_view_settings SET fallback_enabled = 0").run();
    const off = await readStream(await post({ toolName: "srv__t", value: { seconds: 5 }, model: "other-model" }));
    expect(off).toEqual({ views: [], done: true });
    expect(calls()).toBe(0);
  });
  test("settings round trip and reject a bad model id", async () => {
    const { router } = setup();
    const put = (b: unknown) => router(new Request("http://x/s", { method: "PUT", body: JSON.stringify(b) }), new URL("http://x/api/readable-view/settings"), "/api/readable-view/settings", "PUT") as Promise<Response>;
    expect((await put({ model: "bad model!" })).status).toBe(400);
    expect(await (await put({ fallbackEnabled: false, model: "claude-haiku-5-5" })).json()).toEqual({ fallbackEnabled: false, model: "claude-haiku-5-5" });
  });
  test("ignores other paths", async () => {
    const ctx = { db: new Database(":memory:"), json: Response.json } as unknown as AppContext;
    const r = createReadableViewRouter(ctx);
    expect(await r(new Request("http://x/api/other"), new URL("http://x/api/other"), "/api/other", "GET")).toBeNull();
  });
});
