import path from "node:path";
/**
 * MASTER-01 — Master Topic creation via API.
 *
 * Spec: openspec/changes/add-master-topic-mode/specs/master-topic/spec.md
 * Migration: server/db/migrations/026-master-topic-mode.sql
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";

const TEST_DATA = "/tmp/topics-master-test-data";

beforeAll(() => {
  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA;
});

describe("MASTER-01 · POST /api/topics/master", () => {

  test("creates a Master Topic with agent_team_role='lead' and returns the id", async () => {
    const { createAppContext } = await import("../../server/utils");
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = createAppContext(path.resolve(import.meta.dirname, "../.."));
    (ctx as any).broadcastToAll = () => {};
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/topics/master");
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: "/tmp/demo-master-project-A" }),
    });
    const resp = await router(req, url, "/api/topics/master", "POST");
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(201);
    const body = (await resp!.json()) as { id: string; resumed: boolean };
    expect(body.id).toBeDefined();
    expect(body.resumed).toBe(false);

    // Verify DB has agent_team_role='lead'
    const row = ctx.db.query(
      "SELECT id, agent_team_role, project_path FROM topics WHERE id = ?"
    ).get(body.id) as { id: string; agent_team_role: string; project_path: string };
    expect(row.agent_team_role).toBe("lead");
    expect(row.project_path).toBe("/tmp/demo-master-project-A");
  });

  test("re-creating for the same projectPath resumes (no duplicate)", async () => {
    const { createAppContext } = await import("../../server/utils");
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = createAppContext(path.resolve(import.meta.dirname, "../.."));
    (ctx as any).broadcastToAll = () => {};
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/topics/master");
    const make = () =>
      router(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectPath: "/tmp/demo-master-project-B" }),
        }),
        url,
        "/api/topics/master",
        "POST",
      );

    const first = await make();
    expect(first!.status).toBe(201);
    const firstBody = (await first!.json()) as { id: string };

    const second = await make();
    expect(second!.status).toBe(200);
    const secondBody = (await second!.json()) as { id: string; resumed: boolean };
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.resumed).toBe(true);

    // Verify only one Master Topic exists for this path
    const rows = ctx.db.query(
      "SELECT id FROM topics WHERE project_path = ? AND agent_team_role = 'lead' AND archived = 0"
    ).all("/tmp/demo-master-project-B") as { id: string }[];
    expect(rows.length).toBe(1);
  });

  test("accepts global Master (no projectPath) — Variant A", async () => {
    const { createAppContext } = await import("../../server/utils");
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = createAppContext(path.resolve(import.meta.dirname, "../.."));
    (ctx as any).broadcastToAll = () => {};
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/topics/master");
    const first = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      url,
      "/api/topics/master",
      "POST",
    );
    expect(first!.status).toBe(201);
    const firstBody = (await first!.json()) as { id: string };

    // Verify it's saved as a lead with no project_path
    const row = ctx.db.query(
      "SELECT id, agent_team_role, project_path FROM topics WHERE id = ?"
    ).get(firstBody.id) as { id: string; agent_team_role: string; project_path: string | null };
    expect(row.agent_team_role).toBe("lead");
    expect(row.project_path == null || row.project_path === "").toBe(true);

    // Idempotency: a second call with no projectPath resumes the same global Master
    const second = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      url,
      "/api/topics/master",
      "POST",
    );
    expect(second!.status).toBe(200);
    const secondBody = (await second!.json()) as { id: string; resumed: boolean };
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.resumed).toBe(true);
  });
});
