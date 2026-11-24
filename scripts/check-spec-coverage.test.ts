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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-spec-coverage.ts");
const UNTRACED_SCRIPT = resolve(import.meta.dir, "check-untraced-tests.ts");
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

/** Two requirements, both claimed apart, so the only thing on trial below is the joint unit. */
const PAIR_SPEC = `## Requirements\n\n### Requirement: LEFT-01 — the left side\nThe app SHALL do the left thing.\n\n### Requirement: RIGHT-01 — the right side\nThe app SHALL do the right thing.\n`;
// Built from pieces for the same reason as COVERS_TAG: written out, the real run of the gate would read
// this line as an annotation of its own.
const ANNOTATION_TAG = `test.info().annotations.push({ ${["type", '"spec"'].join(": ")}, ${["description", ""].join(": ")}`;

async function runWithMap(root: string): Promise<{ code: number; out: string; map: { joint: { ids: string[]; file: string; channel: string }[] } }> {
  const mapPath = join(root, "coverage-map.json");
  const proc = Bun.spawn(["bun", "run", SCRIPT, "--json", mapPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SPEC_COVERAGE_ROOT: root },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: stdout + stderr, map: JSON.parse(readFileSync(mapPath, "utf8")) };
}

describe("check-spec-coverage: the joint units spec-flow's D19 reads", () => {
  test("`@covers A+B` in one docblock is ONE per-file joint unit, and both ids are still claimed", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", PAIR_SPEC);
    write(root, "scripts/meeting.test.ts", `/** ${COVERS_TAG} LEFT-01+RIGHT-01 */\nimport { test } from "bun:test";\ntest("both", () => {});\n`);

    const { code, out, map } = await runWithMap(root);
    expect(code).toBe(0);
    expect(out).not.toContain("R2");
    expect(map.joint).toEqual([{ ids: ["LEFT-01", "RIGHT-01"], file: "scripts/meeting.test.ts", channel: "covers" }]);
  });

  test("`@covers A, B` is two claims, never a joint unit", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", PAIR_SPEC);
    write(root, "scripts/apart.test.ts", `/** ${COVERS_TAG} LEFT-01, RIGHT-01 */\nimport { test } from "bun:test";\ntest("apart", () => {});\n`);

    const { code, map } = await runWithMap(root);
    expect(code).toBe(0);
    expect(map.joint).toEqual([]);
  });

  test("two ids in ONE annotation are a per-test joint unit; two annotations are not", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", PAIR_SPEC);
    write(root, "tests/e2e/together.spec.ts", `test("x", async () => {\n  ${ANNOTATION_TAG}"LEFT-01 RIGHT-01" });\n});\n`);
    write(
      root,
      "tests/e2e/separate.spec.ts",
      `test("y", async () => {\n  ${ANNOTATION_TAG}"LEFT-01" });\n  ${ANNOTATION_TAG}"RIGHT-01" });\n});\n`,
    );

    const { code, map } = await runWithMap(root);
    expect(code).toBe(0);
    expect(map.joint).toEqual([{ ids: ["LEFT-01", "RIGHT-01"], file: "tests/e2e/together.spec.ts", channel: "annotation" }]);
  });

  test("an id that is no requirement is dropped from the joint unit, so one typo does not break the gate that reads it", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", PAIR_SPEC);
    write(root, "scripts/typo.test.ts", `/** ${COVERS_TAG} LEFT-01+NOPE-99 */\nimport { test } from "bun:test";\ntest("t", () => {});\n`);
    write(root, "scripts/rest.test.ts", `/** ${COVERS_TAG} RIGHT-01 */\nimport { test } from "bun:test";\ntest("r", () => {});\n`);

    const { map, out } = await runWithMap(root);
    expect(map.joint).toEqual([]);
    expect(out).toContain("NOPE-99"); // still R1 dangling: the typo is not hidden, only kept out of the proof
  });

  test("a joint unit is not a double declaration: R4 stays quiet when both ids are also titles elsewhere", async () => {
    const root = fixtureRoot();
    write(root, "openspec/specs/demo/spec.md", PAIR_SPEC);
    write(root, "scripts/left.test.ts", `/** ${COVERS_TAG} LEFT-01 */\nimport { test } from "bun:test";\ntest("LEFT-01: the left", () => {});\n`);
    write(root, "scripts/right.test.ts", `/** ${COVERS_TAG} RIGHT-01 */\nimport { test } from "bun:test";\ntest("RIGHT-01: the right", () => {});\n`);
    write(root, "scripts/meeting.test.ts", `/** ${COVERS_TAG} LEFT-01+RIGHT-01 */\nimport { test } from "bun:test";\ntest("they meet", () => {});\n`);

    const { code, out, map } = await runWithMap(root);
    expect(code).toBe(0);
    expect(out).not.toContain("R4");
    expect(out).not.toContain("R3");
    expect(map.joint).toHaveLength(1);
  });
});

describe("check-untraced-tests: the `A+B` form is a declaration", () => {
  function untracedRun(root: string): { code: number; out: string } {
    try {
      const out = execFileSync("bun", ["run", UNTRACED_SCRIPT], { env: { ...process.env, UNTRACED_TESTS_ROOT: root }, stdio: "pipe" }).toString();
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }
  function gitRoot(testBody: string): string {
    const root = fixtureRoot();
    write(root, "scripts/probe.test.ts", testBody);
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  test("a file whose only declaration is `@covers A+B` is traced", () => {
    const { code, out } = untracedRun(gitRoot(`/** ${COVERS_TAG} LEFT-01+RIGHT-01 */\nimport { test } from "bun:test";\ntest("t", () => {});\n`));
    expect(out).toContain("OK");
    expect(code).toBe(0);
  });

  test("the same file with no declaration is still a new untraced file (the gate is not vacuous)", () => {
    const { code, out } = untracedRun(gitRoot(`import { test } from "bun:test";\ntest("t", () => {});\n`));
    expect(code).toBe(1);
    expect(out).toContain("scripts/probe.test.ts");
  });
});
