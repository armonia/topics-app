/** @covers MP-TASK-03 */
import { expect, test } from "bun:test";
import type { ProvidersSnapshot } from "../../shared/types";
import { createNodesRouter } from "./nodes";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

const snapshot = {
  defaultProvider: "claude-code",
  providers: [
    { name: "claude-code", status: "ready", models: ["claude-sonnet-5-5", "claude-sonnet-4-6"], requirements: [] },
    { name: "topics", status: "ready", models: ["claude-sonnet-5-5", "claude-sonnet-4-6"], requirements: [] },
  ],
} as unknown as ProvidersSnapshot;

function router() {
  return createTasksRouter(makeCtx(freshDb(), []), undefined, { taskModelSnapshot: () => snapshot });
}

test("card creation rejects old and unlisted Claude models with an Italian error", async () => {
  const r = router();

  for (const model of ["claude-sonnet-4-6", "claude-sonnet-9-9"]) {
    const response = await call(r, "POST", "/api/boards/p-model/tasks", { text: "Task", model });
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.code).toBe("invalid_task_model");
    expect(body.error).toMatch(/modello.*catalogo.*generazione/i);
  }

  const accepted = await call(r, "POST", "/api/boards/p-model/tasks", {
    text: "Task current", model: "claude-sonnet-5-5",
  });
  expect(accepted?.status).toBe(201);
});

test("mirrored card creation rejects stale and unlisted models", async () => {
  const db = freshDb();
  const broadcasts: unknown[] = [];
  const ctx = {
    ...makeCtx(db, broadcasts),
    projectStore: { list: () => [{ id: "p-model", path: "/repo" }], get: () => null },
  } as any;
  const router = createNodesRouter(ctx, {
    deleteBoardTask: async () => new Response(null, { status: 204 }),
    runGit: async () => ({ code: 0, stdout: "https://github.com/example/repo.git", stderr: "" }),
    taskModelSnapshot: () => snapshot,
  });

  for (const model of ["claude-sonnet-4-6", "claude-sonnet-9-9"]) {
    const url = new URL("http://topics.test/api/nodes/runs");
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ originTaskId: "origin-card", originUrl: "https://github.com/example/repo.git", text: "Mirror", model }),
      }),
      url,
      url.pathname,
      "POST",
    );
    expect(response?.status).toBe(400);
    expect((await response!.json()).error).toMatch(/modello.*catalogo.*generazione/i);
  }
});
