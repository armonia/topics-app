/**
 * The default branch is open in the repo's main worktree while the project
 * itself is a worktree parked on another branch (card 1297f5db): the land
 * merges in the sibling instead of failing on `git worktree add`. Real git.
 *
 * @covers KANBAN-76
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  commit(mainWt, "shared.txt", "shared base");
  sh(["worktree", "add", "-q", "-b", "park", projectWt], mainWt);
  sh(["switch", "-q", "-c", "topics/card"], projectWt);
  commit(projectWt, "card.txt", "card work");
  commit(projectWt, "shared.txt", "shared card edit");
  sh(["switch", "-q", "park"], projectWt);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const make = () => createTaskAutoMerge({
  resolveTaskMerge: () => ({ repoPath: projectWt, branch: "topics/card", defaultBranch: "main" }) as never,
  runGit,
});

describe("land with main open in a sibling worktree", () => {
  test("modified file the merge changes → skipped naming the file and the path", async () => {
    // shared.txt is changed by the card branch, so a local edit to it overlaps the merge.
    writeFileSync(join(mainWt, "shared.txt"), "dirty\n");
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.code).toBe("dirty-checkout");
      expect(res.reason.split("\\").join("/")).toContain(mainWt.split("\\").join("/"));
      expect(res.reason).toContain("shared.txt");
    }
    sh(["checkout", "--", "shared.txt"], mainWt);
  });

  test("staged change → skipped even when unrelated", async () => {
    writeFileSync(join(mainWt, "a.txt"), "staged\n");
    sh(["add", "a.txt"], mainWt);
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.code).toBe("dirty-checkout");
      expect(res.reason).toContain("a.txt");
    }
    sh(["reset", "-q", "--hard", "HEAD"], mainWt);
  });

  test("modified file the merge does not touch → merged, file intact and out of the commit", async () => {
    writeFileSync(join(mainWt, "a.txt"), "unrelated edit\n");
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    expect(readFileSync(join(mainWt, "a.txt"), "utf8")).toBe("unrelated edit\n");
    expect(sh(["show", "--name-only", "--format=", "HEAD"], mainWt)).not.toContain("a.txt");
    sh(["checkout", "--", "a.txt"], mainWt);
    sh(["reset", "-q", "--hard", "HEAD~1"], mainWt);
  });

  test("clean sibling → merged, main advances there", async () => {
    const res = await make().tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    if (res.status === "merged") {
      expect(res.landedNotLive).toBe(true);
      expect(res.checkoutBranch).toBe("park");
    }
    expect(sh(["log", "--oneline", "-1", "--format=%s"], mainWt)).toContain("merge");
    expect(sh(["status", "--porcelain"], mainWt)).toBe("");
  });
});
