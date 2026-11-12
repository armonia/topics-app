/**
 * The scratch space a native turn may use freely: `/tmp`, `/private/tmp` and
 * the server's `$TMPDIR`.
 *
 * WHY A MODULE. Three guards in the native runtime used to say "outside" about
 * the same folders: the `rm` rule (`permissions.ts`), the write perimeter and
 * the bash `cwd` perimeter (`tools.ts`). Channel turns kept being refused for
 * work on their own temporaries, so the list now lives in one place and every
 * guard reads it.
 *
 * TWO LISTS, ON PURPOSE.
 *  - `scratchRoots()` is what a turn may WRITE into and use as a `cwd`:
 *    exactly `/tmp`, `/private/tmp` and `$TMPDIR`, nothing wider.
 *  - `removableRoots()` is what an `rm` may remove under. It adds
 *    `/var/folders`, which the rule always accepted: widening writes to the
 *    whole per-user folder would reach the app caches next to `T/`, and
 *    narrowing the `rm` rule would change what already passes.
 */

import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

const FIXED_SCRATCH_ROOTS = ["/tmp", "/private/tmp"];
const FIXED_REMOVABLE_ROOTS = ["/var/folders", "/private/var/folders"];

/**
 * A TMPDIR that is not a filesystem root and does not contain the home folder.
 * `TMPDIR=/` or `TMPDIR=~` in the server's environment must not turn the whole
 * disk into scratch space.
 */
function saneTempDir(raw: string | undefined): string | null {
  if (!raw || !isAbsolute(raw)) return null;
  const abs = resolve(raw);
  if (abs === resolve("/")) return null;
  const home = resolve(homedir());
  if (abs === home || home.startsWith(`${abs}/`)) return null;
  return abs;
}

/** The server's `$TMPDIR` when it names a usable temp folder. This is also what the agent's shell inherits. */
export function shellTmpdir(): string | null {
  return saneTempDir(process.env.TMPDIR);
}

/** Where a turn may write and start a command: `/tmp`, `/private/tmp`, `$TMPDIR`. */
export function scratchRoots(): string[] {
  const dynamic = saneTempDir(tmpdir());
  return dynamic ? [...FIXED_SCRATCH_ROOTS, dynamic] : [...FIXED_SCRATCH_ROOTS];
}

/** Where an `rm` may remove: the scratch roots plus the per-user temp folder. */
export function removableRoots(): string[] {
  return [...scratchRoots(), ...FIXED_REMOVABLE_ROOTS];
}

/** True when `abs` is strictly below one of `roots`: the root itself never counts. */
function strictlyBelow(abs: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, abs);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** An absolute path an `rm` may remove under the temp roots (never the root itself). */
export function isRemovableTempPath(abs: string): boolean {
  return strictlyBelow(abs, removableRoots());
}
