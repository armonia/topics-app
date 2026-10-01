#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type LintTarget = "client" | "relay" | "server";

/** What each target lints, from the repo root (client lints itself from client/). */
export const LINT_TARGET_PATHS: Record<Exclude<LintTarget, "client">, string[]> = {
  relay: ["relay"],
  server: ["server", "shared", "server.ts"],
};

export function lintCachePath(root: string, target: LintTarget): string {
  // The current rules inspect individual files, without a TypeScript project.
  // Include dependencies too: not every ESLint plugin exposes its own version.
  const key = createHash("sha256");
  for (const file of ["bun.lock", "client/bun.lock"]) {
    key.update(readFileSync(resolve(root, file)));
  }
  return resolve(root, ".cache/checks", `eslint-${target}-${key.digest("hex").slice(0, 16)}.cache`);
}

if (import.meta.main) {
  const [target, ...args] = process.argv.slice(2);
  if (target !== "client" && target !== "relay" && target !== "server") {
    console.error("Usage: bun run scripts/lint.ts <client|relay|server> [eslint arguments]");
    process.exit(2);
  }
  const root = resolve(import.meta.dir, "..");
  const result = spawnSync(resolve(root, "client/node_modules/.bin/eslint"), [
    ...(target === "client" ? ["."] : ["--config", "client/eslint.config.js", ...LINT_TARGET_PATHS[target]]),
    "--cache", "--cache-strategy", "content", "--cache-location", lintCachePath(root, target),
    ...args,
  ], { cwd: target === "client" ? resolve(root, "client") : root, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
