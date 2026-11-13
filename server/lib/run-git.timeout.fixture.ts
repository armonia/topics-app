/**
 * Body of `run-git.test.ts`, run in a separate process so that the fake `git`
 * first in the PATH is the one `Bun.spawn` finds. Asks every exported runner
 * the same question (`log`, on which the fake hangs) and prints the codes.
 */
import { runGit } from "./run-git";
import { defaultRunGit as ownCommits } from "../services/own-commits";
import { defaultRunGit as taskAutomerge } from "../services/task-automerge";
import { defaultRunGit as worktreeResidue } from "../services/worktree-residue";

const cwd = process.argv[2]!;
const hung = await runGit(cwd, ["log"], { timeoutMs: 60_000 });
const codes = {
  runGit: hung.code,
  runGitStderr: hung.stderr,
  ownCommits: (await ownCommits(cwd, ["log"])).code,
  taskAutomerge: (await taskAutomerge(cwd, ["log"])).code,
  worktreeResidue: (await worktreeResidue(cwd, ["log"])).code,
};
console.log(JSON.stringify(codes));
process.exit(0);
