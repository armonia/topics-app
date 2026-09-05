/**
 * The scoped restore, measured against a REAL repository with a second
 * pair of hands in it.
 *
 * Every claim here is about what survives on disk after a rewind: the turn's
 * own edit goes back, the other person's edit stays, the file they created is
 * still there. A mock of git would just be the test asserting what the author
 * believes `git restore` does to untracked files, and the first restore
 * shipped with exactly that belief wrong. So: a temp repo, real commands, and
 * "somebody else" is a plain `writeFileSync` between two snapshots.
 *
 * @covers CHAT-05
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRestorePlan, buildRestorePlan } from "./checkpoint-restore-plan";
import {
  CHECKPOINT_REF_ROOT,
  captureTurnCheckpoint,
  listRestorePoints,
  sessionRefSlug,
} from "./turn-checkpoints";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const SESSION = "topic-7/session";
const read = (name: string) => readFileSync(join(repo, name), "utf8");
const write = (name: string, content: string) => writeFileSync(join(repo, name), content);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "topics-restoreplan-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  write("a.txt", "a before\n");
  write("b.txt", "b before\n");
  git("add", "-A");
  git("commit", "-m", "one");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** One full turn: a `before` mark, the turn's writes, an `after` mark. Returns the restore point. */
async function turn(writes: () => void): Promise<string> {
  const before = await captureTurnCheckpoint(repo, SESSION, "the turn", "before");
  writes();
  await captureTurnCheckpoint(repo, SESSION, "the turn", "after");
  return before!.commit;
}

describe("the manifest keeps the restore inside the turn", () => {
  test("a concurrent edit on a file the turn never touched survives the restore", async () => {
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    write("b.txt", "b by somebody else\n");

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.safe).toBe(true);
    expect(plan.entries.map((e) => e.path)).toEqual(["a.txt"]);
    const out = await applyRestorePlan(repo, plan);

    expect(read("a.txt")).toBe("a before\n");
    expect(read("b.txt"), "not in the manifest, so not touched").toBe("b by somebody else\n");
    expect(out.restored).toBe(1);
    expect(out.removed).toBe(0);
  });

  test("a file the turn created goes; a file somebody else created after the turn stays", async () => {
    const target = await turn(() => write("by-turn.txt", "created by the turn\n"));
    write("by-other.txt", "created by somebody else\n");

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.entries).toEqual([{ path: "by-turn.txt", state: "added" }]);
    const out = await applyRestorePlan(repo, plan);

    expect(existsSync(join(repo, "by-turn.txt"))).toBe(false);
    expect(existsSync(join(repo, "by-other.txt")), "the old restore deleted this one").toBe(true);
    expect(out.removed).toBe(1);
    expect(out.restored).toBe(0);
  });

  test("a file the turn edited and somebody else edited again is skipped, not overwritten", async () => {
    const target = await turn(() => {
      write("a.txt", "a by the turn\n");
      write("b.txt", "b by the turn\n");
    });
    write("b.txt", "b by somebody else, on top of the turn\n");

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.safe, "a skipped path does not make the plan unsafe").toBe(true);
    expect(plan.entries.map((e) => e.path)).toEqual(["a.txt"]);
    expect(plan.skipped).toEqual([{ path: "b.txt", state: "modified", reason: "changed-after-checkpoint" }]);
    const out = await applyRestorePlan(repo, plan);

    expect(read("a.txt")).toBe("a before\n");
    expect(read("b.txt")).toBe("b by somebody else, on top of the turn\n");
    expect(out.skipped.map((e) => e.path)).toEqual(["b.txt"]);
  });

  test("a file the turn deleted is recreated, unless somebody else already put one there", async () => {
    const target = await turn(() => {
      rmSync(join(repo, "a.txt"));
      rmSync(join(repo, "b.txt"));
    });
    write("b.txt", "b recreated by somebody else\n");

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.entries).toEqual([{ path: "a.txt", state: "deleted" }]);
    expect(plan.skipped.map((e) => e.path)).toEqual(["b.txt"]);
    await applyRestorePlan(repo, plan);

    expect(read("a.txt")).toBe("a before\n");
    expect(read("b.txt")).toBe("b recreated by somebody else\n");
  });

  test("a turn that wrote nothing, then an edit by hand: empty safe plan, no false turn-in-progress, edit intact", async () => {
    // The case that killed the ref heuristic: no `after` mark exists for an
    // idle turn, so a dirty worktree on top of a `before` used to read as a
    // turn still writing, and blocked every restore of the chat for good.
    const target = await turn(() => {});
    write("a.txt", "a by somebody else\n");

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.safe).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([]);
    const out = await applyRestorePlan(repo, plan);

    expect(out.restored).toBe(0);
    expect(out.removed).toBe(0);
    expect(read("a.txt"), "nothing in the plan, nothing touched").toBe("a by somebody else\n");
  });

  test("an older restore point rewinds every turn since, still path by path", async () => {
    const first = await turn(() => write("a.txt", "a by turn 1\n"));
    await turn(() => write("c.txt", "c by turn 2\n"));
    write("b.txt", "b by somebody else\n");

    const plan = await buildRestorePlan(repo, SESSION, first);
    expect(plan.entries.map((e) => `${e.state}:${e.path}`).sort()).toEqual(["added:c.txt", "modified:a.txt"]);
    await applyRestorePlan(repo, plan);

    expect(read("a.txt")).toBe("a before\n");
    expect(existsSync(join(repo, "c.txt"))).toBe(false);
    expect(read("b.txt")).toBe("b by somebody else\n");
  });
});

describe("blockers refuse the whole plan", () => {
  test("turn-in-progress: with turnActive the plan is refused, apply throws, the worktree is untouched", async () => {
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    write("a.txt", "still being written\n");

    const plan = await buildRestorePlan(repo, SESSION, target, { turnActive: true });
    expect(plan.safe).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toEqual(["turn-in-progress"]);
    await expect(applyRestorePlan(repo, plan)).rejects.toThrow("turn-in-progress");
    expect(read("a.txt"), "a refused plan touches nothing").toBe("still being written\n");
  });

  test("no-turn-mark: a `before` as newest, a worktree that moved, and no turn running", async () => {
    // The end of that turn was never recorded (the process died between the
    // two snapshots, or git refused the second): the paths that moved cannot
    // be attributed, and both guesses are wrong. It refuses and says which.
    const before = await captureTurnCheckpoint(repo, SESSION, "the turn", "before");
    write("a.txt", "written by a turn whose end was never recorded\n");

    const plan = await buildRestorePlan(repo, SESSION, before!.commit, { turnActive: false });

    expect(plan.safe).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toEqual(["no-turn-mark"]);
    await expect(applyRestorePlan(repo, plan)).rejects.toThrow("no-turn-mark");
    expect(read("a.txt")).toBe("written by a turn whose end was never recorded\n");
  });

  test("a closed turn that wrote nothing does NOT read as a lost mark, whatever is typed after", async () => {
    // The mark is recorded even when the bytes did not change, which is what
    // keeps the two states apart. Without it this case and the one above are
    // the same refs, and one of the two verdicts is always wrong.
    const target = await turn(() => {});
    write("a.txt", "typed by hand after an idle turn\n");

    const plan = await buildRestorePlan(repo, SESSION, target, { turnActive: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.safe).toBe(true);
    expect(plan.entries).toEqual([]);
  });

  test("other-session-active: another session's checkpoint younger than our latest", async () => {
    const target = await turn(() => write("a.txt", "a by the turn\n"));

    // Git dates are whole seconds, so the other session's snapshot is stamped
    // a minute ahead instead of waiting a second for the clock to tick.
    const tree = git("write-tree");
    const later = new Date(Date.now() + 60_000).toISOString();
    const commit = execFileSync(
      "git", ["commit-tree", tree, "-m", "topics-checkpoint: theirs\n\nTopics-Kind: before\n"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } },
    ).trim();
    git("update-ref", `${CHECKPOINT_REF_ROOT}/${sessionRefSlug("topic-8/other")}/0000000000`, commit);

    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.safe).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toEqual(["other-session-active"]);
    expect(plan.blockers[0].detail).toContain(sessionRefSlug("topic-8/other"));
  });

  test("another session's OLDER checkpoint is not a blocker", async () => {
    await captureTurnCheckpoint(repo, "topic-8/other", "theirs, earlier", "before");
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    const plan = await buildRestorePlan(repo, SESSION, target);
    expect(plan.blockers).toEqual([]);
  });

  test("no-checkpoint: a commit that is not one of the session's snapshots", async () => {
    await turn(() => write("a.txt", "a by the turn\n"));
    const plan = await buildRestorePlan(repo, SESSION, git("rev-parse", "HEAD"));
    expect(plan.blockers.map((b) => b.code)).toEqual(["no-checkpoint"]);
  });

  test("not-a-repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "topics-norepo-"));
    try {
      const plan = await buildRestorePlan(plain, SESSION, "0000000");
      expect(plan.blockers.map((b) => b.code)).toEqual(["not-a-repo"]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("what the restore leaves alone in git itself", () => {
  test("HEAD stays on its branch and the user's staged changes are untouched", async () => {
    write("staged.txt", "staged by hand\n");
    git("add", "staged.txt");
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    const statusBefore = git("status", "--porcelain");

    const out = await applyRestorePlan(repo, await buildRestorePlan(repo, SESSION, target));

    expect(out.branch).toBe("main");
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    // `restore --worktree` leaves the index alone: the staged file is still
    // staged, and a.txt shows as clean again because its bytes match HEAD.
    expect(git("status", "--porcelain")).toBe(statusBefore.split("\n").filter((l) => !l.endsWith("a.txt")).join("\n"));
    expect(git("diff", "--cached", "--name-only")).toBe("staged.txt");
  });

  test("`checkout <hash>` instead DETACHES the head: the non-vacuity of the test above", async () => {
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    expect(() => git("checkout", target), "if this did not detach, the defect never existed").not.toThrow();
    expect(() => git("symbolic-ref", "HEAD")).toThrow();
  });

  test("the outcome declares that the conversation does NOT come back", async () => {
    // Decision 3 of `turn-checkpoints.ts` on the wire. Two different promises;
    // the plan keeps one and says so, rather than letting a caller imply the
    // other.
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    const out = await applyRestorePlan(repo, await buildRestorePlan(repo, SESSION, target));
    expect(out.conversationRewound).toBe(false);
  });

  test("the restore points offered are the ones a plan accepts", async () => {
    const target = await turn(() => write("a.txt", "a by the turn\n"));
    const [point] = await listRestorePoints(repo, SESSION);
    expect(point.commit).toBe(target);
    expect((await buildRestorePlan(repo, SESSION, point.commit)).safe).toBe(true);
  });
});
