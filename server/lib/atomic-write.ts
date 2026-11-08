/**
 * The one way this server replaces a state file: write a temp next to it,
 * then rename over it. A reader, or the next boot after a SIGKILL, sees the
 * old file or the new one, never a truncated one. A plain `writeFileSync`
 * truncates first and writes after, so a kill or ENOSPC in between leaves an
 * empty or half-written file.
 *
 * There used to be five copies of this function (utils, usage store, browser
 * state store, direct endpoint store, daemon state) that disagreed on the temp
 * name, on the mode and on when to chmod. They all delegate here now.
 *
 * - The temp is `<file>.tmp.<pid>.<epochMs>.<seq>`: the usage store's boot
 *   cleanup (`isOrphanTmp`) reads the pid and the age out of that name, and
 *   the sequence number keeps two writes in the same millisecond apart.
 *   It is created with `wx`, so a leftover with the same name is never reused.
 * - `mode`, when given, is set with chmod on the temp BEFORE the rename: the
 *   file is never visible with other bits, whatever the umask. Without it the
 *   file gets the process default, as `writeFileSync` does.
 * - Any failure removes the temp and throws: the caller decides what a failed
 *   write means.
 */
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

let seq = 0;

/** The temp a write of `path` goes through (see the header for the shape). */
export function atomicTempPath(path: string): string {
  return `${path}.tmp.${process.pid}.${Date.now()}.${++seq}`;
}

export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const tmp = atomicTempPath(path);
  try {
    writeFileSync(tmp, data, opts.mode === undefined ? { flag: "wx" } : { flag: "wx", mode: opts.mode });
    if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}
