/**
 * `GET /api/usage/sessions` and `GET /api/usage/projects` — the whole HTTP
 * surface of the per-session / per-project consumption panel.
 *
 * @covers USAGE-05
 *
 * What earns a test here is the SHAPE OF THE ANSWER and the two statements the
 * payload makes that a client cannot re-derive:
 *
 *  - a session the registry never saw, or evicted, is ABSENT from `sessions`.
 *    A zero row would read "measured: it cost nothing", and the client has no
 *    way to tell the two apart afterwards.
 *  - `cost.partial` says the dollars are a floor. Board work has no price at
 *    all, so a payload that just shows a smaller number is silently wrong
 *    exactly on the machines that work the most.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { projectIdForPath } from "../../shared/board";
import { recordTurnUsage, resetNativeUsage } from "../../server/providers/native-usage-registry";

const ROOT = testTmpDir("usage-routes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/usage").createUsageRouter>;

async function call(router: Router, path: string) {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

async function bench(): Promise<{ router: Router; db: import("bun:sqlite").Database }> {
  const { createUsageRouter } = await import("../../server/routes/usage");
  const ctx = await createTestAppContext();
  return { router: createUsageRouter(ctx), db: ctx.db };
}

describe("GET /api/usage/sessions", () => {
  test("lists every session the native registry holds, in one call", async () => {
    resetNativeUsage();
    recordTurnUsage("topic:aaaaaaaa", { input: 100, output: 20, cacheRead: 900, cacheWrite: 40, cacheWrite1h: 10 });
    recordTurnUsage("topic:bbbbbbbb", { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });

    const { router } = await bench();
    const body = await (await call(router, "/api/usage/sessions")).json() as any;
    const keys = body.sessions.map((s: any) => s.sessionKey).sort();
    expect(keys).toEqual(["topic:aaaaaaaa", "topic:bbbbbbbb"]);

    const a = body.sessions.find((s: any) => s.sessionKey === "topic:aaaaaaaa");
    expect(a.inputTokens).toBe(100);
    expect(a.cacheReadTokens).toBe(900);
    // input + output + cacheWrite, the historical board-facing counter.
    expect(a.billableTokens).toBe(160);
  });

  test("a session that was never measured is ABSENT, not zero", async () => {
    resetNativeUsage();
    const { router } = await bench();
    const body = await (await call(router, "/api/usage/sessions")).json() as any;
    expect(body.sessions).toEqual([]);
    // And the payload says which of the two an empty slot means, so a client
    // does not have to guess.
    expect(body.absentMeansUnmeasured).toBe(true);
  });

  test("an evicted session drops out rather than reappearing as zeros", async () => {
    // The registry is capped at 200 with eviction of the oldest. A card whose
    // session fell off the end must show "unknown", never "free".
    resetNativeUsage();
    for (let i = 0; i < 205; i++) {
      recordTurnUsage(`s${i}`, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
    }
    const { router } = await bench();
    const body = await (await call(router, "/api/usage/sessions")).json() as any;
    const keys = new Set(body.sessions.map((s: any) => s.sessionKey));
    expect(keys.size).toBe(200);
    expect(keys.has("s0")).toBe(false);
    expect(keys.has("s204")).toBe(true);
  });
});

describe("GET /api/usage/projects", () => {
  const ALPHA = "/Users/x/Projects/alpha";

  test("answers on an empty database with an empty list, not an error", async () => {
    const { router } = await bench();
    const res = await call(router, "/api/usage/projects");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.projects).toEqual([]);
    expect(body.totals.totalTokens).toBe(0);
    expect(body.cost.currency).toBe("usd");
  });

  test("a chat and a board card on the same folder land on one row, and the money says it is partial", async () => {
    const { router, db } = await bench();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO topics (id, name, slug, session_key, color, icon, project_path, created_at, updated_at)
                VALUES ('t1', 'A', 'a', 'topic:t1aaaaaa', '#fff', 'x', ?, ?, ?)`).run(ALPHA, now, now);
    db.prepare(`INSERT INTO messages (id, session_key, role, content, timestamp, usage_prompt_tokens, usage_completion_tokens, cache_read_tokens, cost_cents)
                VALUES ('m1', 'topic:t1aaaaaa', 'assistant', '', ?, 1000, 500, 0, 250)`).run(now);
    db.prepare(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, completed_at, agent_tokens, agent_cache_read_tokens)
                VALUES ('k1', ?, 'x', 'done', ?, ?, ?, 9000, 0)`)
      .run(projectIdForPath(ALPHA), now, now, now);

    const body = await (await call(router, "/api/usage/projects")).json() as any;
    expect(body.projects).toHaveLength(1);
    const row = body.projects[0];
    expect(row.projectId).toBe(projectIdForPath(ALPHA));
    expect(row.projectPath).toBe(ALPHA);
    expect(row.chatTokens).toBe(1500);
    expect(row.taskTokens).toBe(9000);
    expect(row.totalTokens).toBe(10500);

    // The dollars cover the chat and nothing else, and the payload declares it
    // as a FIELD - a client showing `costUsd` alone would present a floor as a
    // total.
    expect(body.totals.costUsd).toBe(2.5);
    expect(body.cost.partial).toBe(true);
    expect(body.cost.excluded.taskTokens).toBe(9000);
    expect(Array.isArray(body.cost.excluded.models)).toBe(true);
  });

  test("carries the range back and a cache stamp the client can age", async () => {
    const { router } = await bench();
    const body = await (await call(router, "/api/usage/projects?range=7d")).json() as any;
    expect(body.range).toBe("7d");
    expect(typeof body.cachedAt).toBe("string");
    expect(Number.isFinite(Date.parse(body.cachedAt))).toBe(true);
  });

  test("an unknown range falls back to the whole history instead of failing", async () => {
    // Same asymmetry the dashboard chose: a bad range is a soft default, not a
    // 400, because a chart cannot render an error.
    const { router } = await bench();
    const res = await call(router, "/api/usage/projects?range=nonsense");
    expect(res.status).toBe(200);
    expect((await res.json() as any).range).toBe("nonsense");
  });
});
