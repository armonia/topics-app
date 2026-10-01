/**
 * `bun --preload` for a child process that must die between the temp write
 * and the rename of a tmp + rename write (`server/lib/atomic-write.ts`): the
 * first `renameSync` whose destination ends with `$KILL_ON_RENAME_OF` SIGKILLs
 * the process, the way a kill -9 or a power cut would land in that window.
 * Every other rename goes through untouched.
 */
import * as fs from "node:fs";
import { spyOn } from "bun:test";

const target = process.env.KILL_ON_RENAME_OF;
if (!target) throw new Error("kill-on-rename: KILL_ON_RENAME_OF is not set");
const rename = fs.renameSync;
spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
  if (String(to).endsWith(target)) process.kill(process.pid, "SIGKILL");
  return rename(from, to);
});
