/**
 * ARE THE TAURI SIDECARS HERE? If not, `cargo check` has NOT COMPILED anything.
 *
 * `bun run check:sidecars` reports, `bun run check:sidecars -- --fix` (or
 * `bun run sidecars:sync`) provisions them from the main checkout.
 *
 * ── Why a gate that only speaks ─────────────────────────────────────────────
 * `desktop-tauri/src-tauri/binaries/` is not tracked, so a dispatch worktree is
 * born without it and tauri-build stops on
 *
 *     resource path `binaries/topics-server-aarch64-apple-darwin` doesn't exist
 *
 * which reads like a broken build and is really a missing setup. Worktrees
 * created after card 175735ba get the sidecars cloned in
 * (`server/services/worktree-sidecars.ts`); this is the net for the ones born
 * before, and for a checkout that never built them at all.
 *
 * Exit 97 is the same "NOT MEASURED" code `check-client-deps.ts` uses: it is
 * not a red build, it is the absence of a measurement.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  provisionTauriSidecars,
  SIDECAR_DIR_REL,
} from "../server/services/worktree-sidecars";

/** Must stay equal to `server/services/review-checks.ts`. */
const NOT_MEASURED_EXIT = 97;

const root = resolve(new URL("..", import.meta.url).pathname);
const here = join(root, SIDECAR_DIR_REL);
const fix = process.argv.includes("--fix");

/**
 * The main checkout of this repository. In a worktree `--git-common-dir` points
 * at the parent's `.git`, whose directory is the checkout we can borrow from.
 */
function mainCheckout(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const gitDir = proc.stdout.toString().trim();
    return gitDir ? dirname(gitDir) : null;
  } catch {
    return null;
  }
}

if (existsSync(here) && !fix) {
  console.log(`✓ sidecars: ${SIDECAR_DIR_REL} is here, the Tauri crate can be compiled.`);
  process.exit(0);
}

const source = mainCheckout();

if (fix) {
  if (!source) {
    console.error("✗ cannot locate the main checkout: run this inside the repository.");
    process.exit(NOT_MEASURED_EXIT);
  }
  const res = await provisionTauriSidecars(source, root);
  if (res.status === "cloned" || res.status === "linked" || res.status === "present") {
    console.log(`✓ sidecars: ${res.status} in ${res.ms} ms.`);
    process.exit(0);
  }
  console.error(
    `✗ sidecars NOT provisioned (${res.status}${res.reason ? `: ${res.reason}` : ""}).\n` +
      `  Nothing to copy from ${join(source, SIDECAR_DIR_REL)}.\n` +
      "  Build them once in the main checkout, then run this again.",
  );
  process.exit(NOT_MEASURED_EXIT);
}

console.error(
  `✗ ${SIDECAR_DIR_REL} is missing.\n` +
    "  The Rust build has NOT run: tauri-build refuses on the missing resource\n" +
    "  path before compiling a line, which looks like a compile error and is not.\n" +
    "  It is a build artifact, git does not track it, a fresh worktree has none.\n" +
    "  To get it: bun run sidecars:sync",
);
process.exit(NOT_MEASURED_EXIT);
