/**
 * LANDING A CARD IN REVIEW, END TO END AND ON REAL STUFF.
 *
 * On 12/08 four cards that were sitting in `review` waiting for a human
 * decision - `d6baaf5e`, `3bde1ab0`, `c8ea8173`, `5472e584` - ended up in
 * `backlog` marked `failed` within the same hour, all with the same line:
 * "Worktree liberato: il branch del worktree non esiste piu'". None of them had  allow-italian: the notice the GC actually wrote, quoted verbatim
 * failed. Their work had LANDED: the land prunes the branch, the GC finds a
 * ghost row and parks the card. Nobody dispatches the backlog and nobody looks
 * at it, so the decision was not postponed: it was lost from sight. And it
 * happened precisely to the cards that had worked.
 *
 * Why this file exists next to `worktree-gc.test.ts`, which already tests the
 * contract: there the pieces are fake. Here the branch is pruned by GIT after a
 * real merge, and the card's state is written by the real `TaskService` on a
 * real SCHEMA (the migration chain). A mock returning `"gone"` would have passed
 * even the version that parks, and that is exactly what happened.
 *
 * The three lines that have to hold, which are the task's bar:
 *   • a card in `review` whose branch was pruned by a land STAYS in review;
 *   • its attempts counter does not move by a single unit;
 *   • a branch gone with no landing, under a task that declares it is working on
 *     it, still gets parked - the real fault has not been masked.
 *
 * @covers WORKTREE-12
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { branchStatusFromRepo, commitStatusFromRepo } from "./branch-status";
import { classifyLanding } from "./landing-audit";
import { worktreeDirtProbe } from "./task-automerge";
import { abandonNoticeFromRepo } from "./worktree-abandon-notice";
import { sweepWorktrees, type GcWorktree, type WorktreeGcDeps } from "./worktree-gc";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const PID = "topics-app-live";

/**
 * `git` for the tests, with the MACHINE's environment kept out.
 *
 * `-c core.hooksPath=` (empty) disables the hooks. It is not fussiness: on this
 * machine the global config points at a third-party `prepare-commit-msg` hook
 * that on every commit makes two `curl --max-time 2` calls to `localhost:3333`.
 * Measured: 679ms per commit against 219ms without. These two files make 24
 * commits, so the hook on its own can add some ten seconds - and when the port
 * answers slowly instead of refusing straight away, it reaches 4s per commit
 * and the tests blow past the timeout.
 *
 * The symptom was a red that appeared only when running the whole suite, never
 * on the files alone: it looked like a collision between tests, and it was
 * instead the outside world coming in. A test on real git has to bring its own
 * git, not the one belonging to whoever runs it.
 *
 * `commit.gpgsign=false` for the same reason: whoever signs their commits must
 * not be asked for the passphrase by a test suite.
 */
function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // `gitEnv()` carries the preload's isolation: without an explicit `env`,
    // `Bun.spawnSync` does NOT inherit what the preload put into `process.env`
    // - measured, the child sees the variables empty.
    env: gitEnv(),
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, effort TEXT)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, dispatch_retry_cap INTEGER)`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  return db;
}

describe("una card in review che viene landata", () => {
  let repo: string;
  let root: string;
  let db: Database;
  let svc: TaskService;
  let trees: Map<string, GcWorktree>;
  /** The task tied to each worktree. */
  let bound: Map<string, string>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gc-review-repo-"));
    root = mkdtempSync(join(tmpdir(), "gc-review-trees-"));
    trees = new Map();
    bound = new Map();
    db = freshDb();
    let n = 0;
    svc = createTaskService(db, { now: () => new Date().toISOString(), uuid: () => `id-${++n}` });

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    db.close();
  });

  /**
   * A delivered card: a worktree with its branch, a commit inside, the delivery
   * snapshot recorded the way the real delivery records it, and the card in
   * `review` with some attempts already spent (so they can be looked at later).
   */
  function deliveredCard(id: string, attempts = 1): { taskId: string; wt: GcWorktree } {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-q", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "il lavoro della card\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-q", "-m", `lavoro di ${id}`).code).toBe(0);
    const commit = git(absPath, "rev-parse", "HEAD").out;

    const t = svc.create({ projectId: PID, text: `card ${id}`, status: "todo" });
    db.prepare("UPDATE tasks SET status = 'review', dispatch_attempts = ? WHERE id = ?").run(attempts, t.id);
    svc.recordDelivery({ taskId: t.id, branch, commit });

    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    bound.set(id, t.id);
    return { taskId: t.id, wt };
  }

  /** The land as the system does it: merge onto main and branch PRUNED. */
  function land(wt: GcWorktree) {
    expect(git(repo, "merge", "-q", "--no-ff", "-m", `land ${wt.branchName}`, wt.branchName!).code).toBe(0);
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);
  }

  /**
   * The same deps `server.ts` mounts, with the real functions inside: git for
   * the state of branches and commits, the `TaskService` for the cards' state.
   */
  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (wtId) => {
        const taskId = bound.get(wtId);
        if (!taskId) return { taskId: null };
        const t = svc.get(taskId)!.task;
        return { taskId, status: t.status as "review", archived: false };
      },
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeDirtProbe(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      tryLand: async () => "skipped",
      deliveryLanded: async (taskId) => {
        const commit = svc.get(taskId)?.task?.deliveryCommit;
        if (!commit) return null;
        const state = classifyLanding(await commitStatusFromRepo(repo, commit));
        return state === "unverifiable" ? null : state === "landed";
      },
      unbind: async (taskId, wt, reason, deliveryLanded) => {
        const notice = await abandonNoticeFromRepo({
          reason, repoPath: repo, branchName: wt.branchName,
          deliveryCommit: svc.get(taskId)?.task?.deliveryCommit ?? null,
          deliveryLanded, taskFate: "stays",
        });
        svc.release({ taskId, requeue: false, keepStatus: true, by: "system", reason: notice });
        return trees.delete(wt.id);
      },
      abandon: async (taskId, wt, reason) => {
        const notice = await abandonNoticeFromRepo({ reason, repoPath: repo, branchName: wt.branchName });
        svc.release({ taskId, requeue: false, parkState: "failed", by: "system", reason: notice });
        return trees.delete(wt.id);
      },
      reap: async (wtId) => trees.delete(wtId),
      freeCheckout: async (wtId) => trees.delete(wtId),
      noteOnTask: (taskId, content) => { svc.addComment({ taskId, author: "system", content }); },
      log: () => {},
      ...over,
    };
  }

  test("landata → resta in review, senza timbro e col contatore fermo", async () => {
    const { taskId, wt } = deliveredCard("d6baaf5e", 1);
    const before = svc.get(taskId)!.task;
    expect(before.status).toBe("review");

    land(wt);
    const s = await sweepWorktrees(deps());

    const after = svc.get(taskId)!.task;
    expect(after.status).toBe("review");                 // the bar
    expect(after.dispatchAttempts).toBe(before.dispatchAttempts); // the bar
    expect(after.dispatchState).toBeNull();
    expect(after.dispatchError).toBeNull();
    expect(after.assignedTopicId).toBeNull();
    expect(s.unbound).toBe(1);
    expect(s.abandoned).toBe(0);
  });

  test("il thread spiega l'atterraggio invece di suonare l'allarme", async () => {
    const { taskId, wt } = deliveredCard("3bde1ab0");
    land(wt);
    await sweepWorktrees(deps());

    const text = svc.get(taskId)!.comments.map((c) => c.content).join("\n");
    expect(text).toContain("atterraggio riuscito");
    expect(text).not.toContain("torna in backlog");
    expect(text).not.toContain("git fsck");
  });

  // More worktrees = more real gits: 3 process spawns for each of them, and
  // under a suite running in parallel the 5s default is not enough. It is not a
  // patch on the symptom: the work here is genuinely three times that of the
  // other tests in the file, which stay within the default budget.
  test("quattro card nella stessa passata: quattro restano in review", async () => {
    const cards = ["d6baaf5e", "3bde1ab0", "c8ea8173", "5472e584"].map((id) => deliveredCard(id));
    for (const c of cards) land(c.wt);

    const s = await sweepWorktrees(deps());

    expect(cards.map((c) => svc.get(c.taskId)!.task.status)).toEqual(["review", "review", "review", "review"]);
    expect(s.unbound).toBe(4);
    expect(s.abandoned).toBe(0);
  }, 20_000);

  // THE CHECK THAT STOPS THIS FROM BEING JUST A SILENCED ALARM. A branch
  // deleted WITHOUT the work having reached main, under a task that declares it
  // is working on it, is the real fault: that one still gets parked.
  test("ramo cancellato senza land, task attivo → parcheggiato come sempre", async () => {
    const { taskId, wt } = deliveredCard("perduta");
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    // No merge: the branch goes away and the work with it.
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);

    const s = await sweepWorktrees(deps());

    const after = svc.get(taskId)!.task;
    expect(after.status).toBe("backlog");
    expect(after.dispatchState).toBe("failed");
    expect(s.abandoned).toBe(1);
    expect(s.unbound).toBe(0);
  });

  // The same loss under a card in review: the card does NOT go down anyway - in
  // review it waits for a person - but the sentence does not pretend all is well.
  test("ramo perduto sotto una card in review → resta in review, con l'allarme scritto", async () => {
    const { taskId, wt } = deliveredCard("perduta-in-review", 2);
    expect(git(repo, "worktree", "remove", "--force", wt.absPath).code).toBe(0);
    expect(git(repo, "branch", "-D", wt.branchName!).code).toBe(0);

    await sweepWorktrees(deps());

    const after = svc.get(taskId)!.task;
    expect(after.status).toBe("review");
    expect(after.dispatchAttempts).toBe(2);
    const text = svc.get(taskId)!.comments.map((c) => c.content).join("\n");
    expect(text).toContain("il branch NON c'è");
    expect(text).toContain("git fsck --lost-found");
  });
});
