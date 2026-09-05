/**
 * THE GUARD OF THE GUARD: the preload turns a `bun test` red when a file leaves
 * a fake DOM global behind, and leaves alone the file that puts it back.
 *
 * Why it is proven by spawning: the guard is an `afterAll` registered by the
 * preload, which runs once per PROCESS after the last file (measured, see
 * `tests/setup/bun-test-preload.ts`). Inside this very process there is no way
 * to trip it without turning this file red as well. A child process with its
 * cwd in the repo picks the preload up from bunfig.toml like everybody else,
 * even when the test file lives in a temporary folder outside the tree: so no
 * fake `*.test.ts` ever enters the roots of the suite.
 *
 * The two cases are the whole contract: a red without the green would only say
 * that the preload throws; a green without the red, that the guard is blind.
 *
 * @covers GATE-13
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOM_LEAK_MARKER } from "../setup/bun-test-preload.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function runAlone(source: string): { code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "preload-globals-"));
  const file = join(dir, "caso.test.ts");
  writeFileSync(file, source);
  try {
    const r = Bun.spawnSync(["bun", "test", "--timeout", "30000", file], {
      cwd: REPO_ROOT,
      // `process.env` porta `TOPICS_GATE_HELD`: il figlio non si mette in coda al semaforo.
      env: { ...process.env, CI: "1" },
    });
    return { code: r.exitCode, stderr: new TextDecoder().decode(r.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("preload: i globali DOM finti non sopravvivono al loro file", () => {
  it("un file che lascia `window` fa uscire rossa la corsa, e il messaggio dice cosa e' rimasto", () => {
    const r = runAlone(`
      import { test } from "bun:test";
      test("installa e non toglie", () => { (globalThis as any).window = { localStorage: {} }; });
    `);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`${DOM_LEAK_MARKER}: window`);
  });

  it("un file che rimette a posto in afterAll passa senza un fiato", () => {
    const r = runAlone(`
      import { afterAll, test } from "bun:test";
      afterAll(() => { delete (globalThis as any).window; });
      test("installa e toglie", () => { (globalThis as any).window = { localStorage: {} }; });
    `);
    expect(r.stderr).not.toContain(DOM_LEAK_MARKER);
    expect(r.code).toBe(0);
  });
});
