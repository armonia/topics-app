/** @covers E2E-GATE-09 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "e2e-report-input-"));
  const current = join(dir, "current");
  const old = join(dir, "topics-e2e-shards");
  for (const [path, count] of [[current, 1], [old, 2]] as const) {
    mkdirSync(path);
    writeFileSync(join(path, "report-1.json"), JSON.stringify({
      suites: [{ specs: Array.from({ length: count }, (_, i) => ({
        id: `${count}-${i}`, title: `fixture ${i}`, file: "fixture.spec.ts", line: 1,
        tests: [{ status: "expected", results: [] }],
      })) }],
    }));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir };
  delete env.E2E_SHARD_OUT_DIR;
  delete env.E2E_SHARDS_OUT_DIR;
  const out = join(dir, "merged.json");
  return {
    dir, current, old,
    run(tool: "summary" | "merge", extra: Record<string, string> = {}, input?: string) {
      const args = tool === "summary" ? ["scripts/e2e-shards-summary.ts", "1", ...(input ? [input] : [])]
        : ["scripts/merge-shard-reports.ts", ...(input ? [input] : []), "--out", out];
      const result = Bun.spawnSync([process.execPath, ...args], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
    count() { return JSON.parse(readFileSync(out, "utf8")).suites[0].specs.length; },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test.each(["summary", "merge"] as const)("%s requires an explicit run and does not report the old shared directory", (tool) => {
  const f = fixture();
  try {
    const result = f.run(tool);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("E2E_SHARD_OUT_DIR");
    expect(result.stdout).not.toContain("passati");
  } finally { f.close(); }
});

test.each(["summary", "merge"] as const)("%s prefers the canonical output variable and preserves its legacy alias", (tool) => {
  const f = fixture();
  try {
    const settings: Record<string, string>[] = [
      { E2E_SHARD_OUT_DIR: f.current, E2E_SHARDS_OUT_DIR: f.old },
      { E2E_SHARDS_OUT_DIR: f.current },
    ];
    for (const env of settings) {
      const result = f.run(tool, env);
      expect(result.code, result.stderr).toBe(0);
      if (tool === "summary") expect(result.stdout).toContain("1 passati");
      else expect(f.count()).toBe(1);
    }
  } finally { f.close(); }
});

test.each(["summary", "merge"] as const)("%s accepts the caller's exact run directory ahead of environment defaults", (tool) => {
  const f = fixture();
  try {
    const result = f.run(tool, { E2E_SHARD_OUT_DIR: f.old }, f.current);
    expect(result.code, result.stderr).toBe(0);
    if (tool === "summary") expect(result.stdout).toContain("1 passati");
    else expect(f.count()).toBe(1);
  } finally { f.close(); }
});
