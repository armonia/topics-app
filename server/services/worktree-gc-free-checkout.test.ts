/**
 * `free-checkout` on REAL GIT.
 *
 * The contract is pure and tested elsewhere (`worktree-gc.test.ts`), but its
 * promise is not a string: it is that after the sweep the FOLDER is gone and
 * the BRANCH is still resolvable. That can only be verified with `git rev-parse`
 * on a repo that exists - a mock returning `true` would have passed even the
 * version that deletes the branch.
 *
 * Three cases, which are the three lines you must not get wrong:
 *   • task `done`, clean tree, branch preserved → folder gone, commits alive;
 *   • task `in_progress` → folder UNTOUCHED even if clean;
 *   • uncommitted changes → folder UNTOUCHED, and the GC says why.
 *
 * The land is forced to `skipped`: it is the NORMAL case since `03ca44c3` (the
 * land refuses a branch carrying commits from another session) and it is exactly
 * the scenario that kept 77 worktrees alive for 33.9 GB.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sweepWorktrees, type GcWorktree, type TaskStatus, type WorktreeGcDeps } from "./worktree-gc";
import { worktreeDirtProbe } from "./task-automerge";
import { branchStatusFromRepo } from "./branch-status";
import { gitEnv } from "../../tests/setup/bun-test-preload";

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

/** `git rev-parse <branch>` exits zero ⇒ the commits are still reachable. */
function branchResolves(repo: string, branch: string): boolean {
  return git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).code === 0;
}

describe("free-checkout su git vero", () => {
  let repo: string;
  let root: string;
  /** Mounted worktrees, by id. */
  let trees: Map<string, GcWorktree>;
  /** Status of the task tied to each worktree. */
  let statuses: Map<string, TaskStatus>;
  let logs: string[];
  let notes: Array<[string, string]>;

  /** A `branch`-mode worktree with a commit main does NOT have. */
  function mountWorktree(id: string, opts: { dirty?: boolean } = {}): GcWorktree {
    const branch = `topics/${id}`;
    const absPath = join(root, id);
    expect(git(repo, "worktree", "add", "-b", branch, absPath, "main").code).toBe(0);
    writeFileSync(join(absPath, `${id}.txt`), "lavoro consegnato\n");
    git(absPath, "add", "-A");
    expect(git(absPath, "commit", "-m", `lavoro di ${id}`).code).toBe(0);
    if (opts.dirty) writeFileSync(join(absPath, `${id}.txt`), "modifica MAI committata\n");
    const wt: GcWorktree = { id, projectId: "p", absPath, branchName: branch, mode: "branch" };
    trees.set(id, wt);
    return wt;
  }

  /** The cards stamped with their branch before the folder disappeared. */
  const stamps: Array<[string, string]> = [];

  function deps(over: Partial<WorktreeGcDeps> = {}): WorktreeGcDeps {
    return {
      listWorktrees: () => [...trees.values()],
      resolveTask: (id) => ({ taskId: `task-${id}`, status: statuses.get(id) ?? "done", archived: false }),
      isBusy: () => false,
      diskPresent: (p) => existsSync(p),
      realDirt: (p) => worktreeDirtProbe(p),
      branchStatus: (wt) => branchStatusFromRepo(repo, wt.branchName),
      autoMergeEnabled: () => true,
      // The `03ca44c3` gate: the branch carries commits that are not the card's.
      tryLand: async () => "skipped",
      freeCheckout: async (id) => {
        const wt = trees.get(id)!;
        // `deleteBranch: false` - the folder, not the ref.
        const r = git(repo, "worktree", "remove", "--force", wt.absPath);
        if (r.code !== 0) return false;
        trees.delete(id);
        return true;
      },
      reap: async (id) => {
        const wt = trees.get(id)!;
        git(repo, "worktree", "remove", "--force", wt.absPath);
        git(repo, "branch", "-D", wt.branchName!);
        trees.delete(id);
        return true;
      },
      noteOnTask: (taskId, msg) => notes.push([taskId, msg]),
      stampDeliveryBranch: (taskId, branch) => stamps.push([taskId, branch]),
      log: (m) => logs.push(m),
      ...over,
    };
  }

  beforeEach(() => {
    stamps.length = 0;
    root = mkdtempSync(join(tmpdir(), "wt-gc-"));
    repo = join(root, "repo");
    git(root, "init", "--quiet", "repo");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    trees = new Map();
    statuses = new Map();
    logs = [];
    notes = [];
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test("task done + albero pulito → la CARTELLA sparisce e il BRANCH resta risolvibile", async () => {
    const wt = mountWorktree("chiuso");
    statuses.set("chiuso", "done");
    const tip = git(wt.absPath, "rev-parse", "HEAD").out;
    expect(tip).toHaveLength(40);

    const s = await sweepWorktrees(deps());

    // WORK first, space second: if a change turns `free-checkout` into `reap`
    // it is THIS line that has to go red first, not a counter - the red has to
    // name the damage, not the side effect.
    // The commits are there: `git rev-parse` green, and on the SAME tip as before.
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
    expect(git(repo, "rev-parse", wt.branchName!).out).toBe(tip);
    // And the content is still readable from the repo, not just the ref.
    expect(git(repo, "show", `${wt.branchName}:chiuso.txt`).out).toBe("lavoro consegnato");
    // The folder, on the other hand, is gone: that is the space being freed.
    expect(existsSync(wt.absPath)).toBe(false);
    expect(s.freed).toBe(1);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(0);
  });

  test("la card resta LANDABILE: il ramo le viene timbrato prima che la cartella sparisca", async () => {
    // THE FAULT, measured on 714c2fc5 (the `_close` fix), which lost the land
    // TWICE for this reason. Once the folder is freed, `topics.worktree_id`
    // stays empty: `worktreeOfTask` no longer resolves, `taskDeliveryRef`
    // answers `null`, `captureDelivery` does not write `delivery_branch`, and
    // `chooseMergeTarget(null, {branch: null})` answers `no-branch` - the only
    // code that leaves the card closed without having merged anything. The
    // "Land on main" button on that card could not work.
    //
    // Here the branch is still known: it is the last instant in which the card
    // can be told where its work lives.
    const wt = mountWorktree("chiuso");
    statuses.set("chiuso", "done");
    await sweepWorktrees(deps());
    expect(stamps).toEqual([["task-chiuso", wt.branchName!]]);
  });

  test("il timbro arriva PRIMA della liberazione, non dopo", async () => {
    // Afterwards the branch can no longer be named: the `worktrees` row is gone
    // and with it the only way the card has of tracing it. The ORDER is the fix.
    mountWorktree("chiuso");
    statuses.set("chiuso", "done");
    const order: string[] = [];
    await sweepWorktrees(deps({
      stampDeliveryBranch: () => { order.push("timbro"); },
      freeCheckout: async (id) => {
        order.push("libera");
        const wt = trees.get(id)!;
        if (git(repo, "worktree", "remove", "--force", wt.absPath).code !== 0) return false;
        trees.delete(id);
        return true;
      },
    }));
    expect(order).toEqual(["timbro", "libera"]);
  });

  test("il task viene avvisato di DOVE è finito il suo lavoro", async () => {
    const wt = mountWorktree("avvisato");
    statuses.set("avvisato", "done");

    await sweepWorktrees(deps());

    expect(notes).toHaveLength(1);
    expect(notes[0][0]).toBe("task-avvisato");
    expect(notes[0][1]).toContain(wt.branchName!);
    expect(notes[0][1]).toContain("NON è perso");
  });

  for (const status of ["todo", "in_progress", "review", "backlog"] as const) {
    test(`task '${status}' → cartella INTATTA anche se pulita`, async () => {
      const wt = mountWorktree(`attivo-${status}`);
      statuses.set(`attivo-${status}`, status);

      const s = await sweepWorktrees(deps());

      expect(s.freed).toBe(0);
      expect(s.reaped).toBe(0);
      expect(s.kept).toBe(1);
      expect(existsSync(wt.absPath)).toBe(true);
      expect(branchResolves(repo, wt.branchName!)).toBe(true);
    });
  }

  test("modifiche non committate → cartella INTATTA, e il GC lo dice", async () => {
    const wt = mountWorktree("sporco", { dirty: true });
    statuses.set("sporco", "done");

    const s = await sweepWorktrees(deps());

    expect(s.freed).toBe(0);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(1);
    expect(existsSync(wt.absPath)).toBe(true);
    // The uncommitted file is still there, with its content.
    expect(Bun.spawnSync(["cat", join(wt.absPath, "sporco.txt")]).stdout.toString().trim())
      .toBe("modifica MAI committata");
    // "It says so": the reason for the keep is recorded and names the dirt.
    expect(Object.keys(s.keptReasons).join(" ")).toContain("non committate");
  });

  test("junk d'agente non è sporco: `.topics-daemon/` da solo non salva la cartella", async () => {
    const wt = mountWorktree("junk");
    statuses.set("junk", "done");
    Bun.spawnSync(["mkdir", "-p", join(wt.absPath, ".topics-daemon")]);
    writeFileSync(join(wt.absPath, ".topics-daemon", "state.json"), "{}\n");

    const s = await sweepWorktrees(deps());

    expect(s.freed).toBe(1);
    expect(existsSync(wt.absPath)).toBe(false);
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
  });

  // More worktrees = more real gits: 3 process spawns for each of them, and
  // under a suite running in parallel the 5s default is not enough. It is not a
  // patch on the symptom: the work here is genuinely three times that of the
  // other tests in the file, which stay within the default budget.
  test("una passata mista tocca solo ciò che deve: 1 liberato, 2 intatti", async () => {
    const chiuso = mountWorktree("misto-chiuso");
    const attivo = mountWorktree("misto-attivo");
    const sporco = mountWorktree("misto-sporco", { dirty: true });
    statuses.set("misto-chiuso", "done");
    statuses.set("misto-attivo", "in_progress");
    statuses.set("misto-sporco", "done");

    const s = await sweepWorktrees(deps());

    expect(s.total).toBe(3);
    expect(s.freed).toBe(1);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(2);
    expect(existsSync(chiuso.absPath)).toBe(false);
    expect(existsSync(attivo.absPath)).toBe(true);
    expect(existsSync(sporco.absPath)).toBe(true);
    // None of the three branches has been lost.
    for (const wt of [chiuso, attivo, sporco]) {
      expect(branchResolves(repo, wt.branchName!)).toBe(true);
    }
  }, 20_000);

  test("un host che non sa liberare il checkout non perde niente: keep, cartella e branch intatti", async () => {
    const wt = mountWorktree("host-cieco");
    statuses.set("host-cieco", "done");

    const s = await sweepWorktrees(deps({ freeCheckout: undefined }));

    expect(s.freed).toBe(0);
    expect(s.reaped).toBe(0);
    expect(s.kept).toBe(1);
    expect(existsSync(wt.absPath)).toBe(true);
    expect(branchResolves(repo, wt.branchName!)).toBe(true);
  });

  test("land riuscito davvero (contenuto su main) → reap pieno, branch incluso", async () => {
    const wt = mountWorktree("landato");
    statuses.set("landato", "done");

    const s = await sweepWorktrees(deps({
      tryLand: async () => {
        // A real land: the content arrives on main.
        expect(git(repo, "merge", "--no-ff", "-m", "land", wt.branchName!).code).toBe(0);
        return "landed";
      },
    }));

    expect(s.landed).toBe(1);
    expect(s.reaped).toBe(1);
    expect(s.freed).toBe(0);
    expect(existsSync(wt.absPath)).toBe(false);
    expect(branchResolves(repo, wt.branchName!)).toBe(false);
    // The work is not lost: it is on main.
    expect(git(repo, "show", "main:landato.txt").out).toBe("lavoro consegnato");
  });
});
