/**
 * Checkpoints and turn-checkpoints fail closed for the registry-backed coordinator.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { describe, expect, test } from "bun:test";
import { createCheckpointsRouter } from "./checkpoints";

const coordinatorId = "global-coordinator";

const ctx = {
  db: {
    query: (_sql: string) => ({
      get: (_scope: string, topicId: string) => topicId === coordinatorId
        ? {
            scope: "global",
            topic_id: coordinatorId,
            created_at: "2026-09-04T00:00:00.000Z",
            updated_at: "2026-09-04T00:00:00.000Z",
          }
        : null,
    }),
  },
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  matchRoute: () => null,
} as any;

const router = createCheckpointsRouter(ctx);

describe("global coordinator checkpoint gate", () => {
  test("rejects manual and automatic checkpoint namespaces before any project read", async () => {
    for (const [method, path] of [
      ["POST", `/api/topics/${coordinatorId}/checkpoints`],
      ["GET", `/api/topics/${coordinatorId}/turn-checkpoints`],
      ["POST", `/api/topics/${coordinatorId}/turn-checkpoints/restore`],
    ] as const) {
      const req = new Request(`http://topics.test${path}`, { method });
      const response = await router(req, new URL(req.url), path, method);
      expect(response!.status).toBe(403);
      expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
  });
});
