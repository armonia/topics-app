/**
 * A SUB-AGENT'S OWN CHECKOUT, against a real git repository.
 *
 * The unit tests prove the shape of the decision; this one proves the thing the
 * card is about: two children of the same parent write the SAME file and do not
 * overwrite each other, because each holds a directory and a branch of its own.
 * Nothing here goes through HTTP — the route is a thin caller of these two
 * functions, and a real `git worktree add` is the part no double can fake.
 *
 * Isolation follows `project-worktree-domain.test.ts`: DATA_DIR and
 * TOPICS_WORKTREES_DIR are set before the first import that opens the database.
 *
 * @covers WORKTREE-14, WORKTREE-01, WORKTREE-08
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT, testTmpDir } from "./helpers";

/* DATA_DIR is shared environment and this file writes it: restored at the end,
 * see the same note in `project-worktree-domain.test.ts`. */
const DATA_DIR_BEFORE = process.env.DATA_DIR;
const WT_DIR_BEFORE = process.env.TOPICS_WORKTREES_DIR;

const TEST_REPO = testTmpDir("subagent-wt-repo");
const TEST_DATA = testTmpDir("subagent-wt-data");
const TEST_WT = testTmpDir("subagent-wt-trees");

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf-8",
  }).trim();
}

function rmAll() {
  for (const d of [TEST_REPO, TEST_DATA, TEST_WT]) fs.rmSync(d, { recursive: true, force: true });
}

beforeAll(() => {
  rmAll();
  fs.mkdirSync(TEST_REPO, { recursive: true });
  git(TEST_REPO, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(`${TEST_REPO}/same.txt`, "base\n");
  git(TEST_REPO, ["add", "-A"]);
  git(TEST_REPO, ["commit", "-q", "-m", "init"]);
  // The shared checkout stands somewhere else on purpose: WORKTREE-08 says the
  // children are born from `main` anyway, and with `HEAD` as the base they
  // would inherit this branch instead.
  git(TEST_REPO, ["checkout", "-q", "-b", "somebody-elses-work"]);
  process.env.DATA_DIR = TEST_DATA;
  process.env.TOPICS_WORKTREES_DIR = TEST_WT;
});

afterAll(() => {
  rmAll();
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_BEFORE;
  if (WT_DIR_BEFORE === undefined) delete process.env.TOPICS_WORKTREES_DIR;
  else process.env.TOPICS_WORKTREES_DIR = WT_DIR_BEFORE;
});

// Deferred and destructured: an `import()` whose result is not destructured is
// opaque to the dead-code gate. See the same note in the Phase A test.
const utilsPromise = (async () => {
  const { createAppContext } = await import("../../server/utils");
  return { createAppContext };
})();
const forAgentPromise = (async () => {
  const { createAgentWorktree, resolveAgentProject } = await import(
    "../../server/services/worktree-for-agent"
  );
  return { createAgentWorktree, resolveAgentProject };
})();

describe("un sotto-agente nasce nel suo worktree", () => {
  test("two children of the same project get two directories and two branches, both from main", async () => {
    const { createAppContext } = await utilsPromise;
    const { createAgentWorktree } = await forAgentPromise;
    const ctx = createAppContext(PROJECT_ROOT);
    const project = ctx.projectStore.create({ name: "Fan", slug: "fan-out", path: TEST_REPO });

    const deps = {
      projectPath: (id: string) => ctx.projectStore.get(id)?.path,
      create: (input: { projectId: string; mode: "branch"; baseRef: string }) =>
        ctx.worktreeManager.create(input),
      awaitMaterialisation: (id: string, timeoutMs: number) =>
        ctx.worktreeManager.awaitMaterialisation(id, timeoutMs),
      warn: () => {},
    };

    const first = ctx.worktreeStore.get(await createAgentWorktree(deps, project.id, 30_000))!;
    const second = ctx.worktreeStore.get(await createAgentWorktree(deps, project.id, 30_000))!;

    expect(first.absPath).not.toBe(second.absPath);
    expect(first.branchName).not.toBe(second.branchName);
    for (const wt of [first, second]) {
      expect(fs.existsSync(wt.absPath)).toBe(true);
      expect(git(TEST_REPO, ["rev-parse", "--verify", `refs/heads/${wt.branchName}`])).toBeTruthy();
      // Born from main, not from the branch the shared checkout stands on.
      expect(git(TEST_REPO, ["merge-base", "--is-ancestor", "main", wt.branchName!])).toBe("");
      expect(git(TEST_REPO, ["log", "--oneline", `main..${wt.branchName}`])).toBe("");
    }

    // The measure the card asks for: the same file, written by both children.
    const mainSha = git(TEST_REPO, ["rev-parse", "main"]);
    for (const [wt, text] of [[first, "figlio A"], [second, "figlio B"]] as const) {
      fs.writeFileSync(`${wt.absPath}/same.txt`, `${text}\n`);
      git(wt.absPath, ["add", "-A"]);
      git(wt.absPath, ["commit", "-q", "-m", `${text} scrive`]);
    }

    expect(git(TEST_REPO, ["show", `${first.branchName}:same.txt`])).toBe("figlio A");
    expect(git(TEST_REPO, ["show", `${second.branchName}:same.txt`])).toBe("figlio B");
    // One commit each, and none of it on main.
    expect(git(TEST_REPO, ["log", "--oneline", `main..${first.branchName}`]).split("\n").length).toBe(1);
    expect(git(TEST_REPO, ["log", "--oneline", `main..${first.branchName}`])).toContain("figlio A scrive");
    expect(git(TEST_REPO, ["log", "--oneline", `main..${second.branchName}`])).toContain("figlio B scrive");
    expect(git(TEST_REPO, ["rev-parse", "main"])).toBe(mainSha);
    expect(git(TEST_REPO, ["status", "--porcelain"])).toBe("");

    for (const wt of [first, second]) await ctx.worktreeManager.delete(wt.id);
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  }, 60_000);

  test("a cwd that is itself a worktree still resolves to its project, and an unknown path is refused", async () => {
    const { createAppContext } = await utilsPromise;
    const { createAgentWorktree, resolveAgentProject } = await forAgentPromise;
    const ctx = createAppContext(PROJECT_ROOT);
    const project = ctx.projectStore.create({ name: "Nest", slug: "nested-parent", path: TEST_REPO });

    const wt = ctx.worktreeStore.get(
      await createAgentWorktree(
        {
          projectPath: (id: string) => ctx.projectStore.get(id)?.path,
          create: (input: { projectId: string; mode: "branch"; baseRef: string }) =>
            ctx.worktreeManager.create(input),
          awaitMaterialisation: (id: string, timeoutMs: number) =>
            ctx.worktreeManager.awaitMaterialisation(id, timeoutMs),
          warn: () => {},
        },
        project.id,
        30_000,
      ),
    )!;

    const lookup = {
      getByPath: (path: string) => ctx.projectStore.getByPath(path),
      getByAbsPath: (absPath: string) => ctx.worktreeStore.getByAbsPath(absPath),
    };
    // The parent is a card's agent: its cwd is a checkout `projects.path` has
    // never heard of, and WORKTREE-01 refuses to create a worktree from one.
    expect(resolveAgentProject({ parentCwd: wt.absPath }, lookup)).toEqual({
      ok: true,
      projectStoreId: project.id,
    });
    const refused = resolveAgentProject({ cwd: `${TEST_REPO}-nowhere` }, lookup);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal).toContain(`${TEST_REPO}-nowhere`);

    await ctx.worktreeManager.delete(wt.id);
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  }, 60_000);
});
