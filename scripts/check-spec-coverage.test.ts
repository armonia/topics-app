/**
 * R1 has to tell APART two shapes that used to read as one: a test claiming an
 * id that resolves to NOTHING (a typo, or a requirement never written), and a
 * test claiming an id that lives in an OPEN change's delta spec
 * (`openspec/changes/<name>/specs/**\/spec.md`) but has not been archived into
 * `openspec/specs/` yet. Before this gate learned to read the delta, both cases
 * went R1 DANGLING the same way — measured 2026-09-11 on `pane-zoom` wave 1, 12
 * ids at once.
 *
 * The script is spawned as a real process against a throwaway fixture tree
 * (`SPEC_COVERAGE_ROOT`), the same way `check-emdash.test.ts` does it: what is
 * on trial is the exit code that stops CI, not an internal function.
 * @covers GATE-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-spec-coverage.ts");
const dirs: string[] = [];

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-coverage-"));
  dirs.push(dir);
  return dir;
}

function write(root: string, relPath: string, body: string): void {
  const file = join(root, relPath);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body, "utf-8");
}

/** A base spec that is otherwise empty of the id under test. */
const BASE_SPEC = `## Requirements\n\n### Requirement: BASE-01 — already archived\nThe app SHALL do the base thing.\n`;

// Built with a join rather than a literal "@covers ...": this file is itself scanned by the real
// (non-fixture) run of check-spec-coverage.ts, and a literal tag here would make THAT run read
// "BASE-01" or "LAYOUT-34" as a real claim against the real specs, where neither id exists.
const COVERS_TAG = ["@", "covers"].join("");

/** Keeps R2 UNCOVERED quiet: BASE-01 has to be claimed so only R1 is on trial below. */
const BASE_TEST = `/** ${COVERS_TAG} BASE-01 */\nimport { test, expect } from "bun:test";\ntest("does the base thing", () => { expect(1).toBe(1); });\n`;

function testFile(coversId: string): string {
  return `/** ${COVERS_TAG} ${coversId} */\nimport { test, expect } from "bun:test";\ntest("does the thing", () => { expect(1).toBe(1); });\n`;
}

async function run(root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SPEC_COVERAGE_ROOT: root },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: stdout + stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-spec-coverage: R1 vs an open change's delta", () => {
  test("an id declared only in an OPEN change's delta spec is in flight, not dangling", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", BASE_SPEC);
    write(root, "scripts/base.test.ts", BASE_TEST);
    write(
      root,
      "openspec/changes/pane-zoom/specs/layout/spec.md",
      `## ADDED Requirements\n\n### Requirement: LAYOUT-34 — in flight, not archived yet\nThe app SHALL zoom a pane.\n`,
    );
    write(root, "scripts/probe.test.ts", testFile("LAYOUT-34"));

    const { code, out } = await run(root);
    expect(code).toBe(0);
    expect(out).not.toContain("R1");
  });

  test("an id that resolves nowhere — not in the specs, not in any open change — stays R1 DANGLING", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", BASE_SPEC);
    write(root, "scripts/base.test.ts", BASE_TEST);
    write(
      root,
      "openspec/changes/pane-zoom/specs/layout/spec.md",
      `## ADDED Requirements\n\n### Requirement: LAYOUT-34 — in flight, not archived yet\nThe app SHALL zoom a pane.\n`,
    );
    write(root, "scripts/probe.test.ts", testFile("LAYOUT-99"));

    const { code, out } = await run(root);
    expect(code).toBe(1);
    expect(out).toContain("R1");
    expect(out).toContain("LAYOUT-99");
  });

  test("an id sitting only in an ARCHIVED change does not count as in flight", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", BASE_SPEC);
    write(root, "scripts/base.test.ts", BASE_TEST);
    write(
      root,
      "openspec/changes/archive/2026-01-01-old-wave/specs/layout/spec.md",
      `## ADDED Requirements\n\n### Requirement: LAYOUT-34 — already landed, or so the archive claims\nThe app SHALL zoom a pane.\n`,
    );
    write(root, "scripts/probe.test.ts", testFile("LAYOUT-34"));

    const { code, out } = await run(root);
    expect(code).toBe(1);
    expect(out).toContain("R1");
    expect(out).toContain("LAYOUT-34");
  });
});
