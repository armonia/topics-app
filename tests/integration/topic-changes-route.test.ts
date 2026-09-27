/**
 * `GET /api/topics/:id/changes` against a REAL repository.
 *
 * The unit test pins the aggregator; what it cannot pin is the half that
 * matters to the person reading the panel: the line counts and the kinds come
 * from git, and they must describe THIS topic. So this file builds a throwaway
 * repo with a committed file, has a fake conversation write two new files and
 * edit the committed one, and then asks the route.
 *
 * The regression it guards is the one that makes the panel a lie: dirt that
 * belongs to somebody else. A file changed in the repo but never named by the
 * conversation must NOT appear, which is exactly what a plain `git status`
 * would have shown.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredMessage } from "../../server/types";
import type { TopicChanges } from "../../shared/topic-changes";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("topic-changes");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A repo with one committed file, and nothing else. */
function makeRepo(label: string): string {
  const dir = join(ROOT, label);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "base.ts"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  // The real path, not the one we built: on macOS `/tmp` is a symlink to
  // `/private/tmp`, the PATCH canonicalizes what it stores, and a path that
  // disagrees with the topic's own would make every relative path wrong.
  return realpathSync(dir);
}

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function call(router: Router, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`no route handled ${method} ${path}`);
  return res;
}

describe("GET /api/topics/:id/changes", () => {
  test("two writes and one edit: kinds and line counts come out of git", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const repo = makeRepo(`repo-${Date.now()}`);

    const created = await call(router, "POST", "/api/topics", { name: `changes-${Date.now()}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo });
    const topic = ctx.getTopicById(id);
    expect(topic?.projectPath).toBe(repo);

    // What the turn did on disk...
    writeFileSync(join(repo, "new-a.ts"), "alpha\nbeta\n");
    writeFileSync(join(repo, "new-b.ts"), "gamma\n");
    writeFileSync(join(repo, "base.ts"), "one\ntwo\nthree\nfour\n");
    // ...and a file the conversation never named: somebody else's dirt.
    writeFileSync(join(repo, "stranger.ts"), "not mine\n");

    // ...and what the transcript says about it.
    const message: StoredMessage = {
      id: `m-${Date.now()}`,
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      toolCalls: [
        { id: "t1", name: "Write", args: {}, detail: { type: "write", filePath: join(repo, "new-a.ts") } },
        { id: "t2", name: "Write", args: {}, detail: { type: "write", filePath: join(repo, "new-b.ts") } },
        { id: "t3", name: "Edit", args: {}, detail: { type: "edit", filePath: join(repo, "base.ts") } },
      ],
    };
    ctx.appendImportedMessages(topic!.sessionKey, [message]);

    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TopicChanges;

    expect(body.git?.branch).toBe("main");
    expect(body.files.map((f) => f.path).sort()).toEqual(["base.ts", "new-a.ts", "new-b.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["new-a.ts"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 1 });
    expect(byPath["new-b.ts"]).toMatchObject({ kind: "created", added: 1, removed: 0 });
    expect(byPath["base.ts"]).toMatchObject({ kind: "modified", added: 1, removed: 0 });
    expect(body.git?.dirty).toBe(3);
  });

  test("a topic that wrote nothing has nothing to show", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const created = await call(router, "POST", "/api/topics", { name: `quiet-${Date.now()}` });
    const { id } = (await created.json()) as { id: string };
    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], git: null });
  });

  test("an unknown topic is a 404, not an empty panel", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const res = await call(router, "GET", "/api/topics/nope-does-not-exist/changes");
    expect(res.status).toBe(404);
  });
});

/**
 * A topic a task was dispatched to answers with the TASK's diff range, the
 * same one the drawer draws (`resolveTaskDiffRange`), not with the tool calls
 * resolved against `projectPath`.
 *
 * Two defects from the 23/09 review. Once the worktree is pruned every tool
 * call path points into a folder that no longer exists, so all of them came
 * back absolute and uncounted (d6158ec6: 42 paths, 0 resolved). And a file
 * written by a shell command or a sub-agent has no write tool call, so the
 * strip never listed it (e8e3b8bf: strip 5, git 9).
 */
describe("GET /api/topics/:id/changes on a task topic", () => {
  /** An assistant turn: an Edit on base.ts and a Write on src/a.ts in `tree`, plus a shell call that writes nothing the strip can read. */
  function turn(tree: string, shellCommand: string): StoredMessage {
    return {
      id: `m-${Date.now()}-${Math.random()}`,
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      toolCalls: [
        { id: "t1", name: "Write", args: {}, detail: { type: "write", filePath: join(tree, "src/a.ts") } },
        { id: "t2", name: "Edit", args: {}, detail: { type: "edit", filePath: join(tree, "base.ts") } },
        { id: "t3", name: "Bash", args: { command: shellCommand } },
      ],
    };
  }

  function bindTask(ctx: Awaited<ReturnType<typeof createTestAppContext>>, taskId: string, topicId: string): void {
    const nowIso = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id)
       VALUES (?, 'proj-changes', ?, 'done', ?, ?, ?)`,
    ).run(taskId, `Task ${taskId}`, nowIso, nowIso, topicId);
  }

  test("landed and pruned: the files come from the land merge, repo-relative and counted, shell writes included", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const label = `landed-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();

    // The task works in its own worktree...
    const wt = join(realpathSync(ROOT), `wt-${label}`);
    git(repo, "worktree", "add", "-q", "-b", "topics/landed", wt);
    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(wt, "scripts"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    writeFileSync(join(wt, "base.ts"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(wt, "scripts/gen.sh"), "a\nb\nc\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    // ...another session lands something on main meanwhile...
    writeFileSync(join(repo, "stranger.ts"), "not mine\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "somebody else");
    // ...then the land merges it and prunes worktree and branch.
    git(repo, "merge", "--no-ff", "-q", "-m", `merge task ${taskId}: landed`, "topics/landed");
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-D", "topics/landed");

    const created = await call(router, "POST", "/api/topics", { name: `task-${label}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo });
    const topic = ctx.getTopicById(id)!;
    bindTask(ctx, taskId, id);
    ctx.appendImportedMessages(topic.sessionKey, [turn(wt, "printf 'a\\nb\\nc\\n' > scripts/gen.sh")]);

    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TopicChanges;

    expect(body.git?.root).toBe(repo);
    expect(body.files.map((f) => f.path).sort()).toEqual(["base.ts", "scripts/gen.sh", "src/a.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["src/a.ts"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 1 });
    expect(byPath["base.ts"]).toMatchObject({ kind: "modified", added: 1, removed: 0, turns: 1 });
    expect(byPath["scripts/gen.sh"]).toMatchObject({ kind: "created", added: 3, removed: 0, turns: 0 });
    // The counts are the land merge's, not the checkout's: the strip opens
    // these rows in the task's drawer, where that same range is drawn.
    expect(body.taskId).toBe(taskId);
    expect(body.files.every((f) => f.inRange)).toBe(true);
  });

  test("live worktree: committed, uncommitted and untracked files all come from the task's range", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const label = `live-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();

    const wt = join(realpathSync(ROOT), `wt-${label}`);
    git(repo, "worktree", "add", "-q", "-b", "topics/live", wt);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    // Not committed yet: an edit a tool call named, and a file only a shell command wrote.
    writeFileSync(join(wt, "base.ts"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(wt, "notes.md"), "x\ny\n");

    const project = ctx.projectStore.create({ name: label, slug: label, path: repo });
    const worktree = ctx.worktreeStore.create({
      projectId: project.id, name: "live", branchName: "topics/live", baseRef: "main", mode: "branch", absPath: wt,
    });
    const created = await call(router, "POST", "/api/topics", { name: `task-${label}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo, worktreeId: worktree.id });
    const topic = ctx.getTopicById(id)!;
    expect(topic.worktreeId).toBe(worktree.id);
    bindTask(ctx, taskId, id);
    ctx.appendImportedMessages(topic.sessionKey, [turn(wt, "printf 'x\\ny\\n' > notes.md")]);

    const res = await call(router, "GET", `/api/topics/${id}/changes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TopicChanges;

    expect(body.git).toMatchObject({ root: wt, branch: "topics/live" });
    expect(body.files.map((f) => f.path).sort()).toEqual(["base.ts", "notes.md", "src/a.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["src/a.ts"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 1 });
    expect(byPath["base.ts"]).toMatchObject({ kind: "modified", added: 1, removed: 0, turns: 1 });
    expect(byPath["notes.md"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 0 });
  });

  /** A topic bound to a live branch worktree `topics/<label>` of a fresh repo, and the task bound to it when `withTask`. */
  async function liveWorktreeTopic(label: string, withTask: boolean) {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const repo = makeRepo(label);
    const wt = join(realpathSync(ROOT), `wt-${label}`);
    const branch = `topics/${label}`;
    git(repo, "worktree", "add", "-q", "-b", branch, wt);
    const project = ctx.projectStore.create({ name: label, slug: label, path: repo });
    const worktree = ctx.worktreeStore.create({
      projectId: project.id, name: label, branchName: branch, baseRef: "main", mode: "branch", absPath: wt,
    });
    const created = await call(router, "POST", "/api/topics", { name: `topic-${label}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo, worktreeId: worktree.id });
    const topic = ctx.getTopicById(id)!;
    if (withTask) bindTask(ctx, crypto.randomUUID(), id);
    const changes = async (): Promise<TopicChanges> => {
      const res = await call(router, "GET", `/api/topics/${id}/changes`);
      expect(res.status).toBe(200);
      return (await res.json()) as TopicChanges;
    };
    return { ctx, repo, wt, branch, topic, changes };
  }

  function writeTurn(...paths: string[]): StoredMessage {
    return {
      id: `m-${Date.now()}-${Math.random()}`,
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      toolCalls: paths.map((filePath, i) => ({ id: `w${i}`, name: "Write", args: {}, detail: { type: "write" as const, filePath } })),
    };
  }

  test("a live worktree whose commits another local branch also holds still lists the files the chat wrote", async () => {
    // The card's branch was already merged into an integration branch (or
    // copied to a backup one): the own-commit subtraction then finds none, the
    // range shrinks to the uncommitted work, and git's file set is empty.
    const { ctx, repo, wt, branch, topic, changes } = await liveWorktreeTopic(`merged-${Date.now()}`, true);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    git(repo, "branch", "integra/tornata", branch);
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(wt, "src/a.ts"))]);

    const body = await changes();
    expect(body.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(body.files[0]).toMatchObject({ kind: "created", turns: 1 });
    // Outside the range: its diff is the checkout's, not the drawer's.
    expect(body.files[0]!.inRange).toBeUndefined();
  });

  test("a file the chat wrote stays listed past the untracked cap", async () => {
    const { ctx, wt, topic, changes } = await liveWorktreeTopic(`untracked-${Date.now()}`, true);
    mkdirSync(join(wt, "artifacts"), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(wt, `artifacts/shot-${String(i).padStart(2, "0")}.txt`), "x\n");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/new.ts"), "one\ntwo\nthree\n");
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(wt, "src/new.ts"))]);

    const body = await changes();
    const written = body.files.find((f) => f.path === "src/new.ts");
    expect(written).toMatchObject({ kind: "created", added: 3, removed: 0, turns: 1 });
  });

  test("a worktree topic no task owns reads its own worktree's range: shell writes show up", async () => {
    // A sub-agent's isolated worktree, a fan-out attempt, a card released
    // back to the queue: the topic has a branch of its own and no task row.
    const { ctx, wt, topic, changes } = await liveWorktreeTopic(`no-task-${Date.now()}`, false);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "sub-agent work");
    writeFileSync(join(wt, "notes.md"), "x\ny\n");
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(wt, "src/a.ts"))]);

    const body = await changes();
    expect(body.git?.root).toBe(wt);
    expect(body.files.map((f) => f.path).sort()).toEqual(["notes.md", "src/a.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["src/a.ts"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 1 });
    expect(byPath["notes.md"]).toMatchObject({ kind: "created", added: 2, removed: 0, turns: 0 });
    // No task, no drawer to open them in.
    expect(body.taskId).toBeUndefined();
  });
});
