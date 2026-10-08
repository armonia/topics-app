/**
 * Body of `task-diff-file.git-hung.test.ts`, run in a separate process so the fake
 * `git` first in the PATH is the one `Bun.spawn` finds. `runGit` (revision and size
 * questions) is stubbed; the blob itself comes from the fake `git` on the PATH.
 * Prints how the body ended and how long it took.
 */
import { serveDiffBlob } from "./task-diff-file";

const SIZE = Number(process.argv[2]);
const SHA = "a".repeat(40);
const runGit = async (_cwd: string, args: string[]) => {
  if (args[0] === "cat-file" && args.includes("-s")) return { code: 0, stdout: `${SIZE}\n`, stderr: "" };
  return { code: 0, stdout: `${SHA}\n`, stderr: "" };
};

const t0 = performance.now();
const res = await serveDiffBlob({ cwd: process.cwd(), range: SHA, live: true } as never, "pic.png", SHA, { runGit });
let outcome = "complete";
let bytes = 0;
try {
  bytes = (await res.arrayBuffer()).byteLength;
} catch {
  outcome = "errored";
}
console.log(JSON.stringify({ status: res.status, contentLength: res.headers.get("Content-Length"), outcome, bytes, ms: Math.round(performance.now() - t0) }));
process.exit(0);
