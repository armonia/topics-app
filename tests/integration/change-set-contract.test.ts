/**
 * THREE ROUTES, ONE SHAPE: what the diff panel reads is one contract
 * (`shared/change-set.ts`), whoever answers it.
 *
 * The typecheck proves both sides import the same declaration; it cannot prove
 * the three routes fill it the same way. So the same change is read from a
 * card's diff, from a publish and from a chat's changeset, on one real
 * repository, and each answer goes through `buildFileRows`, the function the
 * panel draws its rows with: one row for the file, the same path, the same
 * counts.
 *
 * @covers CHGSET-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler, StoredMessage } from "../../server/types";
import type { ChangeSet } from "../../shared/change-set";
import { projectIdForPath } from "../../shared/board";
import { buildFileRows } from "../../client/src/components/Board/diffFileRows";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("change-set-contract");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const FILE = "src/a.ts";
const BEFORE = "one\n";
const AFTER = "one\ntwo\nthree\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function call(router: RouteHandler, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await router(req, url, url.pathname, method);
  if (!res) throw new Error(`no route handled ${method} ${path}`);
  return res;
}

describe("a changeset has one shape on every route", () => {
  test("a card's diff, a publish and a chat's changeset give the panel the same row", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { createTasksRouter } = await import("../../server/routes/tasks");
    const ctx = await createTestAppContext();
    const topics = createTopicsRouter(ctx);
    const base = realpathSync(ROOT);
    const label = `contract-${Date.now()}`;

    // The project, with a remote the publish compares against.
    const repo = join(base, label);
    mkdirSync(join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, FILE), BEFORE);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const remote = join(base, `${label}-remote.git`);
    git(base, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");

    // The card: its own branch and worktree, with the file changed and committed.
    const cardTree = join(base, `${label}-card`);
    git(repo, "worktree", "add", "-q", "-b", `topics/${label}`, cardTree);
    writeFileSync(join(cardTree, FILE), AFTER);
    git(cardTree, "commit", "-qam", "the card's change");
    // The publish: the same change committed on main, not pushed yet.
    writeFileSync(join(repo, FILE), AFTER);
    git(repo, "commit", "-qam", "the change about to ship");
    // The chat: a checkout where a conversation wrote the same change, uncommitted.
    const chatTree = join(base, `${label}-chat`);
    git(repo, "worktree", "add", "-q", "-b", `chat/${label}`, chatTree, "origin/main");
    writeFileSync(join(chatTree, FILE), AFTER);

    const project = ctx.projectStore.create({ name: label, slug: label, path: repo });
    const worktree = ctx.worktreeStore.create({
      projectId: project.id, name: label, branchName: `topics/${label}`, baseRef: "main", mode: "branch", absPath: cardTree,
    });
    const cardTopic = ((await (await call(topics, "POST", "/api/topics", { name: `card-${label}` })).json()) as { id: string }).id;
    await call(topics, "PATCH", `/api/topics/${cardTopic}`, { projectPath: repo, worktreeId: worktree.id });
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id) VALUES (?, ?, 'card', 'review', ?, ?, ?)`,
    ).run(taskId, projectIdForPath(repo), now, now, cardTopic);

    const chatTopic = ((await (await call(topics, "POST", "/api/topics", { name: `chat-${label}` })).json()) as { id: string }).id;
    await call(topics, "PATCH", `/api/topics/${chatTopic}`, { projectPath: chatTree });
    const turn: StoredMessage = {
      id: `m-${Date.now()}`,
      role: "assistant",
      content: "done",
      timestamp: now,
      toolCalls: [{ id: "e1", name: "Edit", args: {}, detail: { type: "edit", filePath: join(chatTree, FILE) } }],
    };
    ctx.appendImportedMessages(ctx.getTopicById(chatTopic)!.sessionKey, [turn]);

    const tasks = createTasksRouter(ctx, undefined, { listProjectDirs: () => [repo] });
    const pid = projectIdForPath(repo);
    const answers: Record<string, ChangeSet> = {};
    for (const [name, res] of [
      ["card", await call(tasks, "GET", `/api/boards/${pid}/tasks/${taskId}/diff`)],
      ["publish", await call(tasks, "GET", `/api/boards/${pid}/publish-diff`)],
      ["chat", await call(topics, "GET", `/api/topics/${chatTopic}/changes/diff`)],
    ] as const) {
      expect(res.status, `${name} answers`).toBe(200);
      answers[name] = (await res.json()) as ChangeSet;
    }

    for (const [name, set] of Object.entries(answers)) {
      const rows = buildFileRows(set);
      expect(rows.map((r) => r.path), `${name}: one row for the file`).toEqual([FILE]);
      expect(rows[0]!.stat, `${name}: the counts`).toMatchObject({ path: FILE, additions: 2, deletions: 0, status: "M" });
      expect(rows[0]!.chunk?.body, `${name}: the patch of the file`).toContain("+three");
      expect(set.revs?.base, `${name}: the Before is a SHA`).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
