#!/usr/bin/env bun
/**
 * scripts/check-dup.ts - ratchet on EXACT duplicated lines, measured by jscpd.
 *
 * `check:bloat` already counts duplicated blocks, but with a home-made
 * normaliser that is slow to extend. jscpd (Rust, pinned in devDependencies)
 * does the same job over the whole source in about a second, so this gate
 * keeps the number from growing while the baseline file freezes today's value.
 *
 * Scope: server, client/src, shared; typescript and tsx; tests, fixtures and
 * .d.ts excluded; exact clones only (renamed or semantic ones are too noisy
 * for a gate that blocks a merge).
 *
 * EXIT CODES
 *   0  duplicated lines within the baseline
 *   1  more duplicated lines than the baseline
 *   2  the measurement could not be taken (jscpd missing or failed, bad baseline)
 *
 * USAGE
 *   bun run check:dup                      ratchet against scripts/dup-baseline.json
 *   bun run check:dup --update-baseline    rewrite the baseline from today
 *   bun run check:dup --root=<dir>         measure another checkout
 *   bun run check:dup --baseline=<file>    compare against another baseline
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "..");
const SCOPE = ["server", "client/src", "shared"];
const IGNORE = [
  "**/*.test.*",
  "**/*.d.ts",
  "**/tests/**",
  "**/__tests__/**",
  "**/fixtures/**",
  "**/node_modules/**",
];

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const root = resolve(arg("root") ?? REPO);
const baselinePath = resolve(arg("baseline") ?? join(REPO, "scripts", "dup-baseline.json"));
const update = process.argv.includes("--update-baseline");

function fail(message: string): never {
  console.error(`check:dup: ${message}`);
  process.exit(2);
}

/** Duplicated lines of the scoped source under `root`, as counted by jscpd. */
function measure(): { lines: number; clones: number } {
  const bin = join(REPO, "node_modules", ".bin", process.platform === "win32" ? "jscpd.exe" : "jscpd");
  if (!existsSync(bin)) fail("jscpd is not installed (run `bun install`)");
  const out = mkdtempSync(join(tmpdir(), "dup-"));
  try {
    const scope = SCOPE.filter((p) => existsSync(join(root, p)));
    const res = spawnSync(
      bin,
      [...scope, "-f", "typescript,tsx", "--kind", "exact", "-r", "json", "-o", out, "-i", IGNORE.join(","), "--no-colors"],
      { cwd: root, encoding: "utf-8" },
    );
    const report = join(out, "jscpd-report.json");
    if (res.status !== 0 && !existsSync(report)) fail(`jscpd failed: ${res.stderr || res.stdout}`);
    const total = JSON.parse(readFileSync(report, "utf-8")).statistics.total;
    return { lines: total.duplicatedLines, clones: total.clones };
  } catch (err) {
    return fail(`cannot read the jscpd report: ${(err as Error).message}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const started = Date.now();
const now = measure();
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify({ duplicatedLines: now.lines, clones: now.clones }, null, 2)}\n`);
  console.log(`check:dup: baseline written, ${now.lines} duplicated lines in ${now.clones} clones`);
  process.exit(0);
}

if (!existsSync(baselinePath)) fail(`no baseline at ${baselinePath} (run with --update-baseline)`);
let allowed: number;
try {
  allowed = JSON.parse(readFileSync(baselinePath, "utf-8")).duplicatedLines;
  if (!Number.isInteger(allowed)) throw new Error("duplicatedLines is not an integer");
} catch (err) {
  fail(`unreadable baseline: ${(err as Error).message}`);
}

if (now.lines > allowed) {
  console.error(
    `check:dup: FAIL ${now.lines} duplicated lines in ${now.clones} clones, baseline allows ${allowed} (+${now.lines - allowed}). ` +
      `Reuse the existing code instead of copying it; \`bunx jscpd ${SCOPE.join(" ")} -f typescript,tsx --kind exact\` lists the clones.`,
  );
  process.exit(1);
}
if (now.lines < allowed) {
  console.log(
    `check:dup: ok ${now.lines} duplicated lines, baseline ${allowed}: lower it with \`bun run check:dup --update-baseline\` (${seconds}s)`,
  );
} else {
  console.log(`check:dup: ok ${now.lines} duplicated lines, equal to the baseline (${seconds}s)`);
}
