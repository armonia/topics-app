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

  /** A delivery as the review records it. */
  type Delivery = { branch: string; commit: string };

  /** The task row the dispatcher writes, with the delivery the review records when there is one. */
  function bindTask(
    ctx: Awaited<ReturnType<typeof createTestAppContext>>,
    taskId: string,
    topicId: string,
    delivery: Delivery | null = null,
  ): void {
    const nowIso = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, delivery_branch, delivery_commit)
       VALUES (?, 'proj-changes', ?, 'done', ?, ?, ?, ?, ?)`,
    ).run(taskId, `Task ${taskId}`, nowIso, nowIso, topicId, delivery?.branch ?? null, delivery?.commit ?? null);
  }

  /** The attempt the dispatcher binds to the topic it launched, on its worktree's branch. */
  function bindAttempt(ctx: Awaited<ReturnType<typeof createTestAppContext>>, taskId: string, topicId: string, branch: string): void {
    ctx.db.prepare(
      `INSERT INTO task_attempts (id, task_id, idx, topic_id, branch, state, created_at) VALUES (?, ?, 1, ?, ?, 'selected', ?)`,
    ).run(crypto.randomUUID(), taskId, topicId, branch, new Date().toISOString());
  }

  /**
   * A task worktree laid out as `worktree-manager.ts` lays it out: folder
   * `<worktrees>/<slug>/<name>` on branch `topics/<name>`. After the prune that
   * name is all that is left of it, through the delivery branch.
   */
  function taskWorktree(repo: string, label: string): { wt: string; branch: string } {
    const name = `card-${label}`;
    const wt = join(realpathSync(ROOT), `worktrees-${label}`, name);
    const branch = `topics/${name}`;
    git(repo, "worktree", "add", "-q", "-b", branch, wt);
    return { wt, branch };
  }

  /** The land: `merge --no-ff` with the card's id in the subject, then worktree and branch pruned. */
  function landAndPrune(repo: string, wt: string, branch: string, taskId: string): string {
    const delivered = execFileSync("git", ["rev-parse", branch], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, "merge", "--no-ff", "-q", "-m", `merge task ${taskId}: landed`, branch);
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-D", branch);
    return delivered;
  }

  /** A topic in the project's checkout with the task bound to it: what a landed card's topic looks like once its worktree row is gone. */
  async function landedTopic(repo: string, taskId: string, delivery: Delivery | null) {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const created = await call(router, "POST", "/api/topics", { name: `task-${taskId}` });
    const { id } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${id}`, { projectPath: repo });
    const topic = ctx.getTopicById(id)!;
    bindTask(ctx, taskId, id, delivery);
    const changes = async (): Promise<TopicChanges> => {
      const res = await call(router, "GET", `/api/topics/${id}/changes`);
      expect(res.status).toBe(200);
      return (await res.json()) as TopicChanges;
    };
    return { ctx, topic, changes };
  }

  test("landed and pruned: the files come from the land merge, repo-relative and counted, shell writes included", async () => {
    const label = `landed-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();

    // The task works in its own worktree...
    const { wt, branch } = taskWorktree(repo, label);
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
    const commit = landAndPrune(repo, wt, branch, taskId);

    const { ctx, topic, changes } = await landedTopic(repo, taskId, { branch, commit });
    ctx.appendImportedMessages(topic.sessionKey, [turn(wt, "printf 'a\\nb\\nc\\n' > scripts/gen.sh")]);

    const body = await changes();
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

  test("landed: only a path in the task's own pruned worktree joins a range row; the shared checkout and other gone folders keep theirs", async () => {
    const label = `landed-anchor-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();
    const { wt, branch } = taskWorktree(repo, label);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\n");
    writeFileSync(join(wt, "README.md"), "read me\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    const commit = landAndPrune(repo, wt, branch, taskId);

    const { ctx, topic, changes } = await landedTopic(repo, taskId, { branch, commit });
    const inWorktree = join(wt, "src/a.ts");
    // A draft in the worktree that never reached a commit: `docs/README.md` is
    // not the range's `README.md`, however it ends.
    const draft = join(wt, "docs/README.md");
    // A scratch folder deleted since, and the agent writing the shared checkout
    // instead of its worktree: neither is the task's tree.
    const scratch = join(realpathSync(ROOT), `gone-scratch-${label}`, "README.md");
    const wrongTree = join(repo, "src/a.ts");
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(inWorktree, draft, scratch, wrongTree)]);

    const body = await changes();
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([draft, scratch, wrongTree, "README.md", "src/a.ts"].sort());
    expect(byPath["src/a.ts"]).toMatchObject({ turns: 1, added: 1, inRange: true });
    expect(byPath["README.md"]).toMatchObject({ turns: 0, added: 1, inRange: true });
    for (const own of [draft, scratch, wrongTree]) {
      expect(byPath[own]).toMatchObject({ turns: 1 });
      expect(byPath[own]!.inRange).toBeUndefined();
    }
  });

  test("landed through an integration branch: the delivery commit finds the merge that brought it to main", async () => {
    // No `merge task <id>` on main: the card went into `integra/*` with git's
    // own merge subject, and main fast-forwarded to it. Only the delivery the
    // review recorded says which merge is this card's.
    const label = `landed-integra-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();
    const { wt, branch } = taskWorktree(repo, label);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    writeFileSync(join(wt, "shell.txt"), "x\ny\nz\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    const commit = execFileSync("git", ["rev-parse", branch], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, "checkout", "-q", "-b", "integra/tornata");
    git(repo, "merge", "--no-ff", "-q", "-m", `Merge branch '${branch}' into integra/tornata`, branch);
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--ff-only", "-q", "integra/tornata");
    git(repo, "worktree", "remove", "--force", wt);
    git(repo, "branch", "-D", branch);

    const { ctx, topic, changes } = await landedTopic(repo, taskId, { branch, commit });
    // `shell.txt` has no write tool call: a shell command wrote it.
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(wt, "src/a.ts"))]);

    const body = await changes();
    expect(body.taskId).toBe(taskId);
    expect(body.files.map((f) => f.path).sort()).toEqual(["shell.txt", "src/a.ts"]);
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(byPath["src/a.ts"]).toMatchObject({ kind: "created", added: 2, turns: 1, inRange: true });
    expect(byPath["shell.txt"]).toMatchObject({ kind: "created", added: 3, turns: 0, inRange: true });
  });

  test("landed with no delivery recorded: the topic's attempt names the pruned worktree, and each file is one row", async () => {
    // 89 of the 416 cards landed by `merge task <id>` on main have no
    // delivery_branch, so nothing named the pruned folder: 58 of their topics
    // listed each file twice, the range's counted row and the tool call's
    // absolute path (03a5e224: 15 rows for 8 files). The attempt the
    // dispatcher bound to the topic still carries its worktree's branch.
    const label = `landed-nodelivery-${Date.now()}`;
    const repo = makeRepo(label);
    const taskId = crypto.randomUUID();
    const { wt, branch } = taskWorktree(repo, label);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    landAndPrune(repo, wt, branch, taskId);

    const { ctx, topic, changes } = await landedTopic(repo, taskId, null);
    bindAttempt(ctx, taskId, topic.id, branch);
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(wt, "src/a.ts"))]);

    const body = await changes();
    expect(body.taskId).toBe(taskId);
    expect(body.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", kind: "created", added: 2, removed: 0, turns: 1, inRange: true }),
    ]);
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
    return { ctx, router, repo, wt, branch, topic, changes };
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

  test("a write in the shared checkout, or in another folder, is not folded into the worktree's row of the same name", async () => {
    // The agent that wrote the project's checkout instead of its worktree is a
    // known failure: its row is the signal, and it must not vanish into the
    // range's `src/a.ts`. Nor may a `package.json` of some other folder.
    const label = `wrongtree-${Date.now()}`;
    const { ctx, repo, wt, topic, changes } = await liveWorktreeTopic(label, true);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\n");
    writeFileSync(join(wt, "package.json"), "{}\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "task work");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "wrong tree\n");
    const elsewhere = join(realpathSync(ROOT), `elsewhere-${label}`);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "package.json"), "{}\n");
    ctx.appendImportedMessages(topic.sessionKey, [writeTurn(join(repo, "src/a.ts"), join(elsewhere, "package.json"))]);

    const body = await changes();
    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([join(elsewhere, "package.json"), join(repo, "src/a.ts"), "package.json", "src/a.ts"].sort());
    expect(byPath["src/a.ts"]).toMatchObject({ added: 1, turns: 0, inRange: true });
    expect(byPath["package.json"]).toMatchObject({ added: 1, turns: 0, inRange: true });
    expect(byPath[join(repo, "src/a.ts")]).toMatchObject({ turns: 1 });
    expect(byPath[join(repo, "src/a.ts")]!.inRange).toBeUndefined();
    expect(byPath[join(elsewhere, "package.json")]!.inRange).toBeUndefined();
  });

  test("a conversation that ran no tool asks git nothing, even with a dirty worktree", async () => {
    // The route runs at the end of every turn. Without a tool call no shell
    // command, sub-agent or write ran, so nothing on disk is this topic's.
    const { ctx, wt, topic, changes } = await liveWorktreeTopic(`chat-only-${Date.now()}`, true);
    writeFileSync(join(wt, "left-by-someone.md"), "x\n");
    ctx.appendImportedMessages(topic.sessionKey, [
      { id: `m-${Date.now()}`, role: "assistant", content: "just talking", timestamp: new Date().toISOString() },
    ]);

    expect(await changes()).toEqual({ files: [], git: null });
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

  test("a worktree topic no task owns lists only its own tool calls: the worktree's range may be another topic's", async () => {
    // The sidebar's «new topic in this worktree» binds a second topic to a
    // worktree someone else is writing. Without a task nothing says whose the
    // worktree's commits and untracked files are, so B, which only READ, must
    // not list what A wrote, and A lists what its tool calls name.
    const { ctx, router, wt, topic: a, changes: changesOfA } = await liveWorktreeTopic(`no-task-${Date.now()}`, false);
    const created = await call(router, "POST", "/api/topics", { name: `b-${a.id}` });
    const { id: b } = (await created.json()) as { id: string };
    await call(router, "PATCH", `/api/topics/${b}`, { projectPath: a.projectPath, worktreeId: a.worktreeId });
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src/a.ts"), "alpha\nbeta\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-qm", "A's work");
    writeFileSync(join(wt, "scratch.md"), "A's notes\n");
    ctx.appendImportedMessages(a.sessionKey, [writeTurn(join(wt, "src/a.ts"))]);
    ctx.appendImportedMessages(ctx.getTopicById(b)!.sessionKey, [{
      id: `m-${Date.now()}`,
      role: "assistant",
      content: "looked",
      timestamp: new Date().toISOString(),
      toolCalls: [{ id: "r1", name: "Read", args: {}, detail: { type: "read", filePath: join(wt, "base.ts") } }],
    }]);

    const res = await call(router, "GET", `/api/topics/${b}/changes`);
    expect(await res.json()).toEqual({ files: [], git: null });

    // A: its Write, read against the worktree's HEAD like any topic without a
    // task. `src/a.ts` is committed, so no count: the editor's diff is empty too.
    const own = await changesOfA();
    expect(own.git?.root).toBe(wt);
    expect(own.files).toEqual([expect.objectContaining({ path: "src/a.ts", turns: 1 })]);
    expect(own.files[0]!.inRange).toBeUndefined();
    expect(own.files[0]!.added).toBeUndefined();
    expect(own.taskId).toBeUndefined();
  });
});

