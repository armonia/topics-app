/**
 * The review-entry reuse of `falseMainClaims`: a delivery that denies the land for a commit
 * `origin/main` does not have gets a system note naming how much work it actually carries.
 * Real git, no fake door, same shape as `scheduled-review-sense.git.test.ts`.
 *
 * @covers KANBAN-11
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { createCiPhase } from "./tasks-ci-phase";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb } from "./tasks-test-support";

const root = mkdtempSync(join(tmpdir(), "ci-phase-main-claim-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

function commitFile(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

function repoOffMain(): string {
  const remote = join(root, `remote-${Math.random().toString(36).slice(2)}`);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const mine = `${remote}-mine`;
  git(root, "clone", "-q", remote, mine);
  git(mine, "checkout", "-q", "-B", "main");
  commitFile(mine, "base.txt");
  git(mine, "push", "-q", "origin", "main");
  return mine;
}

let db: Database; let svc: TaskService;
beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

function setup(repo: string) {
  const phase = createCiPhase({
    svc, db, broadcast: () => undefined,
    cardTurnIsLive: () => false,
    landDirect: () => null,
    whenLanded: () => null,
    tryAutoLand: async () => undefined,
    integrationRepo: async () => repo,
  });
  const task = svc.create({ text: "fix the thing", projectId: "p1" } as never);
  return { phase, task };
}

describe("review entry: already-on-main claims get a note, not a block", () => {
  test("a commit off main with a false claim gets a system note naming its own work", async () => {
    const repo = repoOffMain();
    const commit = commitFile(repo, "fix.txt");
    writeFileSync(join(repo, "fix2.txt"), "fix2");
    git(repo, "add", "fix2.txt");
    git(repo, "commit", "-q", "-m", "fix2");
    const second = git(repo, "rev-parse", "HEAD");
    const { phase, task } = setup(repo);
    svc.addComment({ taskId: task.id, author: "agent", content: `nessun commit nuovo, già su main ${second.slice(0, 8)}, si chiude senza land` });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/x', delivery_commit = ? WHERE id = ?").run(second, task.id);
    void commit;

    await phase.afterDelivery(task.projectId, task.id);

    const after = svc.get(task.id, { projectId: task.projectId });
    const note = after?.comments.find((c) => c.content.includes("Verifica automatica"));
    expect(note?.content).toContain("2 commit");
    expect(note?.content).toContain("2 file");
  });

  test("a commit truly on main gets no note", async () => {
    const repo = repoOffMain();
    const onMain = git(repo, "rev-parse", "HEAD");
    const { phase, task } = setup(repo);
    svc.addComment({ taskId: task.id, author: "agent", content: `già su main ${onMain.slice(0, 8)}, nessun commit nuovo` });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/x', delivery_commit = ? WHERE id = ?").run(onMain, task.id);

    await phase.afterDelivery(task.projectId, task.id);

    const after = svc.get(task.id, { projectId: task.projectId });
    expect(after?.comments.some((c) => c.content.includes("Verifica automatica"))).toBe(false);
  });

  test("a denial with no sha ('nessun commit nuovo, si chiude senza land') still gets a note when the branch carries work", async () => {
    const repo = repoOffMain();
    writeFileSync(join(repo, "fix.txt"), "fix");
    git(repo, "add", "fix.txt");
    git(repo, "commit", "-q", "-m", "fix");
    const commit = git(repo, "rev-parse", "HEAD");
    const { phase, task } = setup(repo);
    svc.addComment({ taskId: task.id, author: "agent", content: "nessun commit nuovo, si chiude senza land" });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/x', delivery_commit = ? WHERE id = ?").run(commit, task.id);

    await phase.afterDelivery(task.projectId, task.id);

    const after = svc.get(task.id, { projectId: task.projectId });
    const note = after?.comments.find((c) => c.content.includes("Verifica automatica"));
    expect(note?.content).toContain("1 commit");
    expect(note?.content).toContain("1 file");
  });

  test("the same denial with no sha gets no note when the commit is truly on main", async () => {
    const repo = repoOffMain();
    const onMain = git(repo, "rev-parse", "HEAD");
    const { phase, task } = setup(repo);
    svc.addComment({ taskId: task.id, author: "agent", content: "nessun commit nuovo, si chiude senza land" });
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/x', delivery_commit = ? WHERE id = ?").run(onMain, task.id);

    await phase.afterDelivery(task.projectId, task.id);

    const after = svc.get(task.id, { projectId: task.projectId });
    expect(after?.comments.some((c) => c.content.includes("Verifica automatica"))).toBe(false);
  });
});
