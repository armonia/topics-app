/**
 * THE TAURI SIDECARS IN A DISPATCH WORKTREE, or the Rust crate does not build.
 *
 * ── The fault ───────────────────────────────────────────────────────────────
 * `desktop-tauri/src-tauri/binaries/` holds the compiled sidecars
 * (`topics-server-*`, `pty-bridge-*`, `webrtc-bridge-*`, ~250 MB). They are
 * build artifacts, so git does not track them, so `git worktree add` does not
 * materialise them. In a fresh worktree `cargo check` stops before compiling
 * anything:
 *
 *     resource path `binaries/topics-server-aarch64-apple-darwin` doesn't exist
 *
 * Every Rust change delivered from a worktree therefore arrives WITHOUT proof
 * of compilation, and the first place a mistake shows up is Windows CI, a whole
 * round later. Measured on 2026-08-28, card 175735ba.
 *
 * ── Why a clone and not a symlink ───────────────────────────────────────────
 * A link into the main checkout is one command, and it has the same sharp edge
 * `installDeps` already refuses for `node_modules`: a build run inside the
 * worktree would write through the link into the REAL checkout, so a release
 * built from main could ship a sidecar compiled on somebody's branch. The copy
 * is a clone (APFS `cp -Rc`, `--reflink=auto` on Linux): 254 MB in 4 ms and no
 * duplicated block on disk, so the reason to link is gone. Where cloning is not
 * available we still fall back to a link, because half a remedy beats a crate
 * that cannot be compiled at all.
 *
 * ── The half everybody forgets ──────────────────────────────────────────────
 * `desktop-tauri/src-tauri/.gitignore` had `/binaries/` WITH the trailing
 * slash, which only matches a directory: a symlink of the same name showed up
 * as `??` and one `git add -A` would have committed a link to a home directory
 * into a public repo. That line is now slash-less, and it covers directory,
 * file and link alike. Provisioning without that fix plants an absolute path in
 * the repo, so the two belong to the same change.
 */

import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Where the sidecars live, relative to a checkout root. */
export const SIDECAR_DIR_REL = join("desktop-tauri", "src-tauri", "binaries");

/** The directory that must exist for the crate to be there at all. */
const CRATE_DIR_REL = join("desktop-tauri", "src-tauri");

export type SidecarProvisionStatus =
  /** The crate is not in this tree (a branch without `desktop-tauri/`). */
  | "no-crate"
  /** The main checkout has no sidecars either: nothing to hand over. */
  | "no-source"
  /** The worktree already has them (re-run, or a manual copy). */
  | "present"
  /** Cloned block-for-block from the main checkout. */
  | "cloned"
  /** Cloning failed, a symlink was used instead. */
  | "linked"
  /** Neither worked; the reason says which command spoke last. */
  | "failed";

export interface SidecarProvisionResult {
  status: SidecarProvisionStatus;
  /** Populated on `failed`, for the log line. */
  reason?: string;
  ms: number;
}

/**
 * The copy command that shares blocks instead of duplicating them, per
 * platform. Windows has no `cp`, so it goes straight to the link fallback.
 */
function cloneCommand(source: string, dest: string): string[] | null {
  if (process.platform === "darwin") return ["cp", "-Rc", source, dest];
  if (process.platform === "linux") return ["cp", "-R", "--reflink=auto", source, dest];
  return null;
}

/**
 * Give `worktreePath` the sidecars of `projectPath`. Idempotent, best effort:
 * it never throws, because a worktree that is missing its sidecars is worse off
 * than one that failed to get them but exists.
 */
export async function provisionTauriSidecars(
  projectPath: string,
  worktreePath: string,
): Promise<SidecarProvisionResult> {
  const started = Date.now();
  const done = (status: SidecarProvisionStatus, reason?: string): SidecarProvisionResult =>
    reason === undefined
      ? { status, ms: Date.now() - started }
      : { status, reason, ms: Date.now() - started };

  if (!existsSync(join(worktreePath, CRATE_DIR_REL))) return done("no-crate");

  const source = join(projectPath, SIDECAR_DIR_REL);
  if (!existsSync(source)) return done("no-source");

  const dest = join(worktreePath, SIDECAR_DIR_REL);
  // `lstat` and not `existsSync`: a dangling symlink left by an earlier run is
  // "already there" for `cp`, which would then fail on an existing path.
  try {
    lstatSync(dest);
    return done("present");
  } catch {
    // Not there, which is the normal case for a fresh worktree.
  }

  const cmd = cloneCommand(source, dest);
  let lastError = "no clone command on this platform";
  if (cmd) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code === 0 && existsSync(dest)) return done("cloned");
      lastError = (await new Response(proc.stderr).text()).trim() || `${cmd[0]} exited ${code}`;
    } catch (err) {
      lastError = String(err);
    }
  }

  try {
    // "junction" is ignored on POSIX and is what lets Windows link a directory
    // without administrator rights.
    symlinkSync(source, dest, "junction");
    return done("linked");
  } catch (err) {
    return done("failed", `${lastError}; symlink: ${String(err)}`);
  }
}
