/**
 * A request that repeats an OPEN card is absorbed by that card: 200 with
 * `deduped: true`, a service comment carrying the repeated text, no new card.
 * A merely similar title keeps the 409, a finished card is history.
 * @covers BOARD-DEDUPE-01
 */
import { describe, expect, test, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../services/tasks";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

describe("a repeated request lands on the open card instead of making a twin", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;
  beforeEach(() => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
  });

  const create = async (body: Record<string, unknown>) => {
    const res = (await call(router, "POST", "/api/sessions/s1/tasks", body))!;
    return { status: res.status, body: await res.json() };
  };
  const commentsOf = async (id: string) =>
    ((await (await call(router, "GET", `/api/sessions/s1/tasks/${id}`))!.json()).comments as Array<{ content: string; kind: string }>);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

  test("same normalized title: 200 deduped, one card, the new description on its thread", async () => {
    const first = await create({ text: "Fix the login redirect loop" });
    expect(first.status).toBe(201);

    const again = await create({ text: "  fix the LOGIN redirect loop ", description: "seen again on staging, same loop" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduped: true, id: first.body.id });
    expect(count()).toBe(1);

    const notes = (await commentsOf(first.body.id)).filter((c) => c.kind === "service");
    expect(notes.some((c) => c.content.includes("seen again on staging, same loop"))).toBe(true);
  });

  test("the same idempotency key on an open card is the same request", async () => {
    const first = await create({ text: "Alpha job", idempotency_key: "req-1" });
    const again = await create({ text: "A completely different title", idempotency_key: "req-1" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduped: true, id: first.body.id });
    expect(count()).toBe(1);
  });

  test("retrying the very same call does not stack identical notes", async () => {
    const first = await create({ text: "Beta job" });
    await create({ text: "Beta job", description: "same words" });
    await create({ text: "Beta job", description: "same words" });
    const notes = (await commentsOf(first.body.id)).filter((c) => c.content.includes("same words"));
    expect(notes).toHaveLength(1);
  });

  test("a merely similar title keeps the 409", async () => {
    await create({ text: "store: UserMemoryStore.update() + test" });
    const similar = await create({ text: "store: UserMemoryStore.update() + unit test" });
    expect(similar.status).toBe(409);
    expect(similar.body.code).toBe("duplicate");
    expect(count()).toBe(1);
  });

  test("a done card is not absorbed: it gets no note and keeps the old 409 answer", async () => {
    const first = await create({ text: "Gamma job", description: "x" });
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.body.id);
    const again = await create({ text: "Gamma job", description: "late repeat" });
    expect(again.status).toBe(409);
    expect(again.body.deduped).toBeUndefined();
    expect((await commentsOf(first.body.id)).some((c) => c.content.includes("late repeat"))).toBe(false);
    expect(count()).toBe(1);
  });

  test("an archived card is history too", async () => {
    const first = await create({ text: "Delta job" });
    db.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(first.body.id);
    expect((await create({ text: "Delta job" })).status).toBe(201);
  });

  test("allow_duplicate still opens a second card", async () => {
    await create({ text: "Epsilon job" });
    const forced = await create({ text: "Epsilon job", allow_duplicate: true });
    expect(forced.status).toBe(201);
    expect(count()).toBe(2);
  });

  test("the same title on another board is not a twin", async () => {
    await create({ text: "Zeta job" });
    const other = (await call(router, "POST", "/api/sessions/s2/tasks", { text: "Zeta job" }))!;
    expect(other.status).toBe(201);
  });
});

describe("the coordinator surface shares the same gate", () => {
  const GLOBAL_TOPIC_ID = "global-orchestrator-topic";
  const GLOBAL_SESSION_KEY = "topic:global-orchestrator";
  test("an identical title on an explicit board is absorbed there", async () => {
    const db = freshDb();
    const now = "2026-09-04T10:00:00.000Z";
    db.run(`INSERT INTO topics (id, session_key, project_path, worktree_id, parent_id, provider)
            VALUES (?, ?, NULL, NULL, NULL, 'codex')`, [GLOBAL_TOPIC_ID, GLOBAL_SESSION_KEY]);
    db.run(`INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
            VALUES ('global', ?, ?, ?)`, [GLOBAL_TOPIC_ID, now, now]);
    const router = createTasksRouter(makeCtx(db, [], {
      [GLOBAL_SESSION_KEY]: { projectPath: "/proj/one", name: "coordinator", topicId: GLOBAL_TOPIC_ID },
    }), undefined, { listProjectDirs: () => ["/proj/one", "/proj/two"] });
    const url = `/api/orchestrator-sessions/${encodeURIComponent(GLOBAL_SESSION_KEY)}/tasks`;
    const board = projectIdForPath("/proj/two");
    const first = await (await call(router, "POST", url, { board_id: board, text: "Rotate the staging keys" }))!.json();
    const again = (await call(router, "POST", url, { board_id: board, text: "rotate the staging keys", description: "asked again" }))!;
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ deduped: true, id: first.id });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
  });
});
