/**
 * Body of `own-commits.git-hung.test.ts`, run in a separate process so that a fake
 * `git` first in the PATH is the one `Bun.spawn` finds (see
 * `routes/files.git-hung.fixture.ts`). Prints the answer as JSON.
 */
import { commitIsIn, defaultRunGit } from "./own-commits";

const run = await defaultRunGit(process.cwd(), ["merge-base", "--is-ancestor", "abc", "main"]);
const verdict = await commitIsIn(process.cwd(), "abc", "main");
console.log(JSON.stringify({ code: run.code, verdict }));
process.exit(0);
