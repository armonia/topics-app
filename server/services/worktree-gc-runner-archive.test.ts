/**
 * A CARD CLOSED WITHOUT A LAND, THROUGH THE RUNNER, ON REAL GIT.
 *
 * `worktree-gc-free-checkout.test.ts` proves the archive promise on the sweep
 * alone, with hand-made deps: a merge put back in the runner's wiring would
 * never show up there. Here nothing between the card and git is a stand-in for
 * the code under test: the card goes review -> approve through the real
 * `TaskService`, the pass is the one `createWorktreeGcRunner` builds (the same
 * factory `server.ts` mounts), and the verdict is read back from the repo.
 *
 * What has to hold after ONE pass:
 *   - local `main` is byte-for-byte the commit it was before (no merge, no
 *     fast-forward);
 *   - `refs/topics/archive/<taskId>` points at the branch tip;
 *   - and both hold whatever the board's auto-merge setting says, because
 *     archiving is not landing.
 *
 * @covers WORKTREE-09, WORKTREE-10
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { createWorktreeGcRunner, type WorktreeGcDeps } from "./worktree-gc-runner";
import { ARCHIVE_REF_PREFIX } from "./worktree-archive";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const PID = "topics-app-archive";

/** `git` with the machine's environment kept out (see `worktree-gc-review-land.test.ts`). */
function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

/**
 * The schema the TaskService needs, plus the two columns of `topics` the
 * runner reads to go from a worktree to its card (`worktree_id`,
 * `session_key`), on the same database: one source of truth for both sides.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT, session_key TEXT, worktree_id TEXT)");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run("CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, dispatch_retry_cap INTEGER)");
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  return db;
}

type Row = { id: string; projectId: string; absPath: string; branchName: string; mode: "branch"; status: "ready" };

describe("the runner archives a card closed without a land", () => {
  let repo: string;
  let root: string;
  let db: Database;
  let svc: TaskService;
  /** The worktree store as the runner sees it. */
  let rows: Map<string, Row>;
  let deleted: Array<{ id: string; deleteBranch: boolean }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gc-archive-"));
    repo = join(root, "repo");
    rows = new Map();
    deleted = [];
    db = freshDb();
    let n = 0;
    svc = createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `id-${++n}` });

    expect(git(root, "init", "-q", "-b", "main", "repo").code).toBe(0);
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    expect(git(repo, "commit", "-q", "-m", "base").code).toBe(0);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A card with a worktree on its own branch and one commit main does not
   * have, delivered, then sent to review and APPROVED by a human: `done`,
   * never landed.
   */
  function approvedWithoutLand(name: string): { taskId: string; row: Row; tip: string } {
    const branch = `topics/${name}`;
    const absPath = join(root, name);
    expect(git(repo, "worktree", "add", "-q", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${name}.txt`), "the card's work\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-q", "-m", `work of ${name}`).code).toBe(0);
    const tip = git(absPath, "rev-parse", "HEAD").out;

    const row: Row = { id: `wt-${name}`, projectId: "p", absPath, branchName: branch, mode: "branch", status: "ready" };
    rows.set(row.id, row);
    const topicId = `topic-${name}`;
    db.run("INSERT INTO topics (id, session_key, worktree_id) VALUES (?, ?, ?)", [topicId, `topic:${topicId}`, row.id]);

    const t = svc.create({ projectId: PID, text: `card ${name}`, status: "todo" });
    svc.recordDelivery({ taskId: t.id, branch, commit: tip });
    // The hand-off to review is the dispatcher's job and needs a live agent;
    // only the column and the binding matter to the GC, so they are written
    // the way `worktree-gc-review-land.test.ts` writes them.
    db.prepare("UPDATE tasks SET status = 'review', assigned_topic_id = ? WHERE id = ?").run(topicId, t.id);
    svc.reviewDecision({ taskId: t.id, by: "user", decision: "approve" });
    expect(svc.get(t.id)!.task.status).toBe("done");
    return { taskId: t.id, row, tip };
  }

  /** The runner's deps, with the real TaskService and real git behind them. */
  function deps(autoMerge: boolean): WorktreeGcDeps {
    // The board's setting, answered from here: the runner must not ask, and if
    // it did, both answers must lead to the same archive.
    const boardSvc = Object.assign(Object.create(svc) as object, {
      getBoardSettings: () => ({ dispatchAutoMerge: autoMerge }),
    });
    return {
      db,
      worktreeStore: { list: () => [...rows.values()] },
      worktreeManager: {
        delete: async (id, opts) => {
          const row = rows.get(id);
          if (!row) return false;
          const deleteBranch = opts?.deleteBranch !== false;
          if (git(repo, "worktree", "remove", "--force", row.absPath).code !== 0) return false;
          if (deleteBranch) git(repo, "branch", "-D", row.branchName);
          rows.delete(id);
          deleted.push({ id, deleteBranch });
          return true;
        },
      },
      projectStore: { get: () => ({ path: repo }) },
      getTopicBySessionKey: () => null,
      resolveTopicCwd: () => null,
      svc: boardSvc,
      broadcast: () => {},
      isInFlight: () => false,
      worktreeOfTask: () => null,
      deliveryIsOnMain: async () => null,
      previewList: () => [],
      previewTeardown: async () => {},
    };
  }

  for (const autoMerge of [true, false]) {
    test(`auto-merge ${autoMerge ? "on" : "off"}: main is untouched, the tip is pinned under the archive ref`, async () => {
      const { taskId, row, tip } = approvedWithoutLand(`closed-${autoMerge ? "on" : "off"}`);
      const mainBefore = git(repo, "rev-parse", "main").out;

      const summary = await createWorktreeGcRunner(deps(autoMerge)).runWorktreeGc();

      // Main: the very same commit, and no merge anywhere in its history.
      expect(git(repo, "rev-parse", "main").out).toBe(mainBefore);
      expect(git(repo, "log", "main", "--merges", "--oneline").out).toBe("");
      expect(git(repo, "merge-base", "--is-ancestor", tip, "main").code).not.toBe(0);
      // The archive: the ref exists and resolves to the branch tip.
      expect(git(repo, "rev-parse", "--verify", `${ARCHIVE_REF_PREFIX}${taskId}`).out).toBe(tip);
      // The checkout is gone, the branch is kept, the card is still `done`.
      expect(existsSync(row.absPath)).toBe(false);
      expect(deleted).toEqual([{ id: row.id, deleteBranch: false }]);
      expect(git(repo, "rev-parse", "--verify", `refs/heads/${row.branchName}`).out).toBe(tip);
      expect(svc.get(taskId)!.task.status).toBe("done");
      expect(summary).not.toBeNull();
      expect(summary!.archived).toBe(1);
      expect(summary!.freed).toBe(1);
      expect(summary!.reaped).toBe(0);
    }, 20_000);
  }
});
