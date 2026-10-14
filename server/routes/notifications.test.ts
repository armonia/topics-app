/**
 * The log's public door, `POST /api/notifications`: a row written there is
 * written outside any subject's transition, so no `attention:updated` carries
 * it. It reaches every open window on `attention:history`, and the inbox's
 * «History» tab grows live, as it did before `notification:new` went
 * (notifications-redesign, tasks.md 6.2). A duplicate, refused by the log's
 * dedup, sends nothing.
 * @covers ATTN-09
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { configureAttentionStore, resetAttentionStore } from "../attention/store";
import { createNotificationsRouter } from "./notifications";
import type { AppContext } from "../types";

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "notif-route-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ isTopicArchived: () => false });
});
afterAll(() => { resetAttentionStore(); __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

const frames: Array<Record<string, any>> = [];
beforeEach(() => {
  resetAttentionStore();
  frames.length = 0;
  configureAttentionStore({ broadcast: (f) => { frames.push(f as Record<string, any>); } });
  getDatabase().run("DELETE FROM notification_log");
});

// The two helpers the router reads off the app context.
const ctx = {
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  readJSON: (req: Request) => req.json(),
} as unknown as AppContext;

async function post(body: Record<string, unknown>): Promise<{ recorded: boolean; row: { id: string } | null }> {
  const router = createNotificationsRouter(ctx);
  const req = new Request("http://localhost/api/notifications", { method: "POST", body: JSON.stringify(body) });
  const res = await router(req, new URL(req.url), "/api/notifications", "POST");
  expect(res?.status).toBe(200);
  return (await res!.json()) as { recorded: boolean; row: { id: string } | null };
}

describe("POST /api/notifications", () => {
  it("a new row reaches the windows live, on attention:history, and a duplicate sends nothing", async () => {
    const body = { kind: "task-review", title: "Consegna", targetKind: "task", targetId: "t-1", dedupeKey: "task-review:t-1:e2e" };
    const first = await post(body);
    expect(first.recorded).toBe(true);
    expect((await post({ ...body, source: "push" })).recorded).toBe(false);
    const live = frames.filter((f) => f.type === "attention:history");
    expect(live.map((f) => [f.row.id, f.row.kind, f.row.groupKey])).toEqual([[first.row!.id, "task-review", "task:t-1"]]);
  });
});
