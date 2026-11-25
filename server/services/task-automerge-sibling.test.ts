/**
 * The default branch is open in the repo's main worktree while the project
 * itself is a worktree parked on another branch (card 1297f5db): the land
 * merges in the sibling instead of failing on `git worktree add`. Real git.
 *
 * @covers KANBAN-76
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskAutoMerge } from "./task-automerge";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const runGit = async (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  sh(["add", "."], cwd);
  sh(["commit", "-q", "-m", msg], cwd);
};

let root: string, mainWt: string, projectWt: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "automerge-sibling-")));
  mainWt = join(root, "main-wt");
  projectWt = join(root, "project-wt");
  sh(["init", "-q", "-b", "main", mainWt]);
  sh(["config", "user.name", "t"], mainWt);
  sh(["config", "user.email", "t@t"], mainWt);
  commit(mainWt, "a.txt", "base");
  sh(["worktree", "add", "-q", "-b", "park", projectWt], mainWt);
  sh(["switch", "-q", "-c", "topics/card"], projectWt);
  commit(projectWt, "card.txt", "card work");
  sh(["switch", "-q", "park"], projectWt);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const make = () => createTaskAutoMerge({
  resolveTaskMerge: () => ({ repoPath: projectWt, branch: "topics/card", defaultBranch: "main" }) as never,
  runGit,
});

describe("land with main open in a sibling worktree", () => {
  test("dirty sibling → skipped naming its path", async () => {
    writeFileSync(join(mainWt, "a.txt"), "dirty\n");
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.reason).toContain(mainWt);
    sh(["checkout", "--", "a.txt"], mainWt);
  });

  test("clean sibling → merged, main advances there", async () => {
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    expect(sh(["log", "--oneline", "-1", "--format=%s"], mainWt)).toContain("merge");
    expect(sh(["status", "--porcelain"], mainWt)).toBe("");
  });
});
