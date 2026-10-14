/**
 * Body of `worktree-slim.git-hung.test.ts`, run in a separate process so that the
 * fake `git` first in the PATH is the one `Bun.spawn` finds. Prints the result and
 * whether the candidate directory is still there.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { slimWorktree } from "./worktree-slim";

const root = process.argv[2]!;
const result = await slimWorktree(root);
console.log(JSON.stringify({ result, stillThere: existsSync(join(root, ".next")) }));
process.exit(0);
