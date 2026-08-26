/**
 * Two shards must not write into the same Playwright artifacts folder.
 *
 * Shards exist to run TOGETHER: each gets its own port, DATA_DIR, bundle and
 * tunnel. The artifacts folder was a FIXED path, so N processes created, moved
 * and deleted inside the same working area, and whoever arrived second found
 * the file another had just moved. Measured on a 4-shard run: three ENOENT on
 * trace and network-recording files — errors that name a file and no defect,
 * and read like a product fault.
 *
 * WHY A CHILD PROCESS. The config reads `process.env.E2E_PORT` at import time
 * and the module is cached, so one process can only ever observe one branch.
 * Each case therefore asks a fresh `bun` to import the config and print the
 * value it computed. That is the real config, not a copy of its source: a test
 * that string-matched the file would keep passing over an expression that had
 * stopped working.
 *
 * @covers E2E-GATE-09
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Imports playwright.config.ts in a fresh process and returns its outputDir. */
function outputDirWith(env: Record<string, string>): string {
  const r = Bun.spawnSync(
    ["bun", "-e", "console.log((await import('./playwright.config.ts')).default.outputDir)"],
    { cwd: REPO_ROOT, env: { ...process.env, E2E_PORT: "", ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  if (r.exitCode !== 0 || !out) {
    throw new Error(`config non leggibile (exit ${r.exitCode}): ${r.stderr.toString().slice(-400)}`);
  }
  return out;
}

describe("cartella degli artefatti degli shard", () => {
  it("due shard con porte diverse ottengono cartelle diverse", () => {
    const a = outputDirWith({ E2E_PORT: "13910" });
    const b = outputDirWith({ E2E_PORT: "13911" });
    expect(a, "la cartella non porta traccia della porta dello shard").not.toBe(b);
  }, 60_000);

  it("la cartella nomina lo shard, non un indice qualsiasi", () => {
    expect(outputDirWith({ E2E_PORT: "13910" })).toContain("13910");
  }, 60_000);

  it("senza identita' di shard resta la cartella storica", () => {
    // The counter-proof: whoever runs the suite normally must see nothing
    // different, or we would be curing a fault that does not exist there.
    expect(outputDirWith({})).toBe("test-results/artifacts");
  }, 60_000);

  it("e' lo script degli shard a dare quell'identita'", () => {
    // If the script stopped exporting E2E_PORT tomorrow, the three cases above
    // would stay green and the defect would come back: the config would be
    // correct and nobody would put it in a position to be so any more.
    const src = Bun.file(resolve(REPO_ROOT, "scripts/e2e-shards.sh"));
    return src.text().then((t) => {
      expect(t, "e2e-shards.sh non esporta piu' E2E_PORT").toContain('E2E_PORT="$port"');
    });
  });
});
