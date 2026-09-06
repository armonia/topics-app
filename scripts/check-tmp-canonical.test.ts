/**
 * The gate that stops a literal `/tmp/` in a spec that hashes a path into a
 * board id, proven on the SCRIPT and on its exit code: a gate whose only proof
 * is a call to its own helper never shows the number that stops CI.
 *
 * The three cases are the three decisions it makes: the offender, the pardon,
 * and the file where a temporary path is just a file.
 * @covers E2E-GATE-10
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { testTmpDir } from "../tests/integration/helpers";

const SCRIPT = resolve(import.meta.dir, "check-tmp-canonical.ts");

/** A fake checkout with a single spec in it, so the gate has a root to scan. */
function checkoutWith(name: string, source: string): string {
  const root = testTmpDir(`tmp-canonical-${name}`);
  const dir = join(root, "tests", "e2e");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sample.spec.ts"), source);
  return root;
}

async function run(root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, `--root=${root}`], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: stdout + stderr };
}

const SEED = 'const PROJECT_PATH = `/tmp/e2e-sample-${Date.now()}`;\nconst ID = boardIdForPath(PROJECT_PATH);\n';

describe("check:tmp-canonical", () => {
  test("a spec that addresses a board with a literal /tmp/ is RED, with file and line", async () => {
    const { code, out } = await run(checkoutWith("red", SEED));
    expect(code).toBe(1);
    expect(out).toContain("tests/e2e/sample.spec.ts:1");
    expect(out).toContain("canonicalTmpRoot");
  });

  test("the same line pardoned on the line above is green", async () => {
    const pardoned = `// allow-literal-tmp: an evidence dump, not an identity.\n${SEED}`;
    const { code } = await run(checkoutWith("pardon", pardoned));
    expect(code).toBe(0);
  });

  test("a file that hashes no path is not the gate's business", async () => {
    const { code } = await run(checkoutWith("unrelated", 'writeFileSync("/tmp/evidence.json", "{}");\n'));
    expect(code).toBe(0);
  });
});
