/**
 * The evidence trace keeps the test's attachments wherever the trace merge
 * finishes, and drops them only on the Node that stalls it.
 *
 * Playwright 1.59 folds every `testInfo.attach` (the json and png of a spec,
 * the poster, the video) into trace.zip. On Node 26 the merge of that zip
 * stalls as soon as one attachment deflates to more than ~64 KB: the test is
 * green, teardown hangs until "Test timeout of 30000ms exceeded" and trace.zip
 * is left truncated. Measured 2026-09-29 with a copy of `mergeTraceFiles` and
 * a 200 KB random entry: Node 22.23, 24.21 and 25.9 finish, Node 26.9 stalls;
 * and with the real runner on Node 26 a 200 KB random png timed out while a
 * 30 KB one and 200 KB of zeros passed.
 *
 * Dropping the attachments everywhere cost the living-doc its proofs: the page
 * on specflow.armonia.io reads only video, trace and screenshot from the report,
 * so a geometry json or a theme png reaches a reader only inside trace.zip.
 * The gate is therefore on the Node major, not on evidence mode as a whole.
 *
 * Same child-process shape as e2e-shard-output-dir.test.ts: the config reads
 * the environment at import time, so each case imports it in a fresh `bun`.
 *
 * @covers E2E-UAT-01
 */
import { describe, it, expect } from "bun:test";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

type Probe = { node: string; trace: unknown; keeps: Record<string, boolean> };

/** Imports playwright.config.ts in a fresh process and reports what it computed. */
function readConfig(env: Record<string, string>): Probe {
  const script = [
    "const m = await import('./playwright.config.ts');",
    "const keeps = {};",
    "for (const v of ['20.19.0', '22.23.2', '24.21.0', '25.9.0', '26.0.0', '26.9.0', '27.1.0']) keeps[v] = m.traceKeepsAttachments(v);",
    "console.log(JSON.stringify({ node: process.versions.node, trace: m.default.use.trace, keeps }));",
  ].join(" ");
  const r = Bun.spawnSync(["bun", "-e", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, E2E_PORT: "", TOPICS_E2E_LIST_ONLY: "1", E2E_EVIDENCE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString().trim().split("\n").pop() ?? "";
  if (r.exitCode !== 0 || !out) {
    throw new Error(`config not readable (exit ${r.exitCode}): ${r.stderr.toString().slice(-400)}`);
  }
  return JSON.parse(out) as Probe;
}

describe("evidence trace attachments", () => {
  it("only Node 26 and later lose the attachments", () => {
    expect(readConfig({}).keeps).toEqual({
      "20.19.0": true,
      "22.23.2": true,
      "24.21.0": true,
      "25.9.0": true,
      "26.0.0": false,
      "26.9.0": false,
      "27.1.0": false,
    });
  }, 60_000);

  it("the evidence trace follows the Node that runs the config", () => {
    const probe = readConfig({ E2E_EVIDENCE: "1" });
    const major = Number(probe.node.split(".")[0]);
    expect(probe.trace).toMatchObject({ mode: "on", sources: false, snapshots: true, attachments: major < 26 });
  }, 60_000);

  it("without evidence mode the trace is still the plain first-retry one", () => {
    expect(readConfig({}).trace).toBe("on-first-retry");
  }, 60_000);
});
