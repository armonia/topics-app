/**
 * How a card's preview server is started from its worktree.
 *
 * Kept apart from the boot wiring so the choice can be tested on real folders.
 * `preview:worktree` is the contract of a project that knows how to show itself
 * from a freshly born worktree (builds what it needs, uses its own data, listens
 * on `PORT`): when present it wins over the generic scripts. The other three are
 * the heuristic for any frontend.
 */
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installArgv, missingPackageManager, runScriptArgv } from "../lib/project-scripts";
import type { PreviewCommand } from "./preview-manager";

export const PREVIEW_SCRIPT_CANDIDATES = ["preview:worktree", "preview", "dev", "start"];

/** A `preview:worktree` script builds by itself (measured: 97 s of build alone on a loaded Mac), so the wait cap is wide. */
export const PREVIEW_CONTRACT_READY_MS = 300_000;

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: object;
  devDependencies?: object;
}

/**
 * Env override (TOPICS_PREVIEW_CMD / TOPICS_PREVIEW_PATH) wins; otherwise the
 * first present of the candidates in the worktree package.json. null = nothing
 * to start (no package.json, or no matching script).
 */
export function resolvePreviewCommand(
  worktreePath: string,
  env: Record<string, string | undefined> = process.env,
): PreviewCommand | null {
  const deepLinkPath = env.TOPICS_PREVIEW_PATH?.trim() || "/";
  const override = env.TOPICS_PREVIEW_CMD?.trim();
  if (override) return { cmd: override.split(/\s+/), deepLinkPath };
  try {
    const pkgPath = join(worktreePath, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
    const scripts = pkg?.scripts ?? {};
    const script = PREVIEW_SCRIPT_CANDIDATES.find((s) => typeof scripts[s] === "string" && scripts[s].trim());
    if (!script) return null;
    // A worktree is born WITHOUT node_modules: running `dev` there died in
    // "command not found" and the wait recorded it as slowness. Install first,
    // with the manager the lockfile declares, but only when the package declares
    // dependencies: a script-only package.json has nothing to install, and a
    // frozen install without a lockfile fails.
    const declaresDeps = Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length > 0;
    const prepare: string[][] = [];
    if (declaresDeps && !existsSync(join(worktreePath, "node_modules")) && !missingPackageManager(worktreePath)) {
      prepare.push(installArgv(worktreePath));
    }
    const contract = script === "preview:worktree";
    return {
      cmd: runScriptArgv(worktreePath, [script]),
      deepLinkPath,
      prepare,
      readyTimeoutMs: contract ? PREVIEW_CONTRACT_READY_MS : undefined,
      // The contract script may write the page to show (see PreviewCommand.deepLinkFile).
      deepLinkFile: contract ? join(tmpdir(), "topics-preview-{port}.deeplink") : undefined,
    };
  } catch { return null; }
}
