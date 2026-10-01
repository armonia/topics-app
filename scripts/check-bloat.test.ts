/**
 * A gate is worth something only once it has been SEEN RED. Here it is seen red
 * on purpose, in both of its modes, against a throwaway git repo built line by
 * line: a file that is too long, a block copied into two files, a baseline that
 * says "this was already like that", and then the same tree grown past what the
 * baseline allowed.
 *
 * The script runs as a PROCESS, not as an import: what has to be proven is the
 * exit code that stops CI, and `main()` runs at import time and calls
 * `process.exit`. `--root` exists for exactly this, so the fixture is a real
 * repo with a real git index rather than a mocked file list.
  * @covers GATE-02
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";

const SCRIPT = resolve(import.meta.dir, "check-bloat.ts");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git repo whose index holds the given files. No commit: `git ls-files` reads the index. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bloat-"));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }
  const init = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf-8" });
  expect(init.status).toBe(0);
  const add = spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf-8" });
  expect(add.status).toBe(0);
  return dir;
}

function run(dir: string, ...args: string[]): { code: number; out: string } {
  const res = spawnSync("bun", ["run", SCRIPT, `--root=${dir}`, ...args], { encoding: "utf-8" });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

/** A file of `n` distinct, substantial lines. Distinct so it is not itself a clone. */
function longFile(n: number, salt = "a"): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) rows.push(`export const ${salt}${i} = ${i} + ${i} * 2;`);
  return `${rows.join("\n")}\n`;
}

/** A block that is worth reporting: substantial, distinct, and long enough. */
function sharedBlock(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) rows.push(`  const shared${i} = compute(${i}, "value ${i}");`);
  return `export function shared() {\n${rows.join("\n")}\n}\n`;
}

const BASELINE = (over: Record<string, number>, duplicated: number) =>
  JSON.stringify({
    $schema: "bloat-baseline-v1",
    _comment: [],
    updated: "2026-08-14",
    tolerance_pct: 5,
    max_lines: 100,
    min_clone_lines: 20,
    files: over,
    duplicated_lines: duplicated,
    clone_groups: duplicated > 0 ? 1 : 0,
  });

describe("check-bloat, absolute mode", () => {
  test("exits 1 and names the file when one is over the line threshold", () => {
    const dir = repo({ "src/big.ts": longFile(300) });
    const { code, out } = run(dir, "--max-lines=100", "--min-clone-lines=9999");
    expect(code).toBe(1);
    expect(out).toContain("src/big.ts");
    expect(out).toContain("FAIL");
  });

  test("exits 0 on the same tree when the threshold is above it", () => {
    const dir = repo({ "src/big.ts": longFile(300) });
    expect(run(dir, "--max-lines=9999", "--min-clone-lines=9999").code).toBe(0);
  });

  test("finds a block copied into two files, and says where both copies are", () => {
    const block = sharedBlock(30);
    const dir = repo({ "src/a.ts": `${block}\n`, "src/b.ts": `${block}\n` });
    const { code, out } = run(dir, "--max-lines=9999", "--min-clone-lines=20");
    expect(code).toBe(1);
    expect(out).toContain("src/a.ts:");
    expect(out).toContain("src/b.ts:");
  });

  test("a re-indented copy is still a copy", () => {
    const block = sharedBlock(30);
    const indented = block
      .split("\n")
      .map((l) => (l ? `    ${l}` : l))
      .join("\n");
    const dir = repo({ "src/a.ts": `${block}\n`, "src/b.ts": `function wrap() {\n${indented}\n}\n` });
    expect(run(dir, "--max-lines=9999", "--min-clone-lines=20").code).toBe(1);
  });

  test("a comment copied around is not a clone: only code counts", () => {
    const comment = Array.from({ length: 40 }, (_, i) => `// licence line number ${i}`).join("\n");
    const dir = repo({
      "src/a.ts": `${comment}\nexport const a = 1;\n`,
      "src/b.ts": `${comment}\nexport const b = 2;\n`,
    });
    expect(run(dir, "--max-lines=9999", "--min-clone-lines=20").code).toBe(0);
  });

  test("a run of closing braces is not a clone either", () => {
    const braces = Array.from({ length: 40 }, () => "}").join("\n");
    const dir = repo({ "src/a.ts": `${braces}\n`, "src/b.ts": `${braces}\n` });
    expect(run(dir, "--max-lines=9999", "--min-clone-lines=20").code).toBe(0);
  });

  test("duplication inside a test file is out of scope, size is not", () => {
    const block = sharedBlock(30);
    const dir = repo({ "src/a.test.ts": `${block}\n`, "src/b.test.ts": `${block}\n` });
    expect(run(dir, "--max-lines=9999", "--min-clone-lines=20").code).toBe(0);
    expect(run(dir, "--max-lines=10", "--min-clone-lines=9999").code).toBe(1);
  });
});

describe("check-bloat, ratchet mode", () => {
  test("a file already in the baseline stays green", () => {
    const dir = repo({ "src/big.ts": longFile(300), "scripts/bloat-baseline.json": BASELINE({ "src/big.ts": 300 }, 0) });
    const { code, out } = run(dir);
    expect(code).toBe(0);
    expect(out).toContain("OK");
  });

  test("the same file grown past its ceiling turns it red", () => {
    const dir = repo({ "src/big.ts": longFile(500), "scripts/bloat-baseline.json": BASELINE({ "src/big.ts": 300 }, 0) });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("GREW");
    expect(out).toContain("src/big.ts");
  });

  test("growth inside the tolerance is allowed, and the ceiling is stated", () => {
    // 300 + GROWTH_FLOOR(120) = 420 allowed; 5% of 300 is smaller, so the floor wins.
    const dir = repo({ "src/big.ts": longFile(410), "scripts/bloat-baseline.json": BASELINE({ "src/big.ts": 300 }, 0) });
    expect(run(dir).code).toBe(0);
  });

  test("a file the baseline never heard of is a NEW offender", () => {
    const dir = repo({
      "src/big.ts": longFile(300),
      "src/other.ts": longFile(300, "b"),
      "scripts/bloat-baseline.json": BASELINE({ "src/big.ts": 300 }, 0),
    });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("NEW offender");
    expect(out).toContain("src/other.ts");
  });

  test("duplication that rises above the recorded total turns it red", () => {
    const block = sharedBlock(30);
    const dir = repo({
      "src/a.ts": `${block}\n`,
      "src/b.ts": `${block}\n`,
      "scripts/bloat-baseline.json": BASELINE({}, 0),
    });
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain("DUPLICATION rose");
  });

  test("a cured file is reported, and never fails the gate", () => {
    const dir = repo({ "src/big.ts": longFile(20), "scripts/bloat-baseline.json": BASELINE({ "src/big.ts": 300 }, 0) });
    const { code, out } = run(dir);
    expect(code).toBe(0);
    expect(out).toContain("cured");
  });
});

/**
 * The v1 writer, kept here only as the "before" of the merge proof: `files`
 * sorted by size, an `updated` date, everything else as JSON.stringify left it.
 */
function v1Baseline(sizes: Record<string, number>, updated: string): string {
  const files = Object.fromEntries(Object.entries(sizes).sort((a, b) => b[1] - a[1]));
  return `${JSON.stringify(
    { $schema: "bloat-baseline-v1", _comment: [], updated, tolerance_pct: 5, max_lines: 100, min_clone_lines: 20, files, duplicated_lines: 0, clone_groups: 0 },
    null,
    2,
  )}\n`;
}

/** `git merge-file` on three texts: its exit code is the number of conflicts. */
function mergeFile(base: string, ours: string, theirs: string): { conflicts: number; merged: string } {
  const dir = mkdtempSync(join(tmpdir(), "bloat-merge-"));
  dirs.push(dir);
  writeFileSync(join(dir, "base"), base);
  writeFileSync(join(dir, "ours"), ours);
  writeFileSync(join(dir, "theirs"), theirs);
  const res = spawnSync("git", ["merge-file", "-p", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")], { encoding: "utf-8" });
  return { conflicts: res.status ?? -1, merged: res.stdout };
}

/** The baseline `--update-baseline` writes for a tree of files with these sizes. */
function recorded(sizes: Record<string, number>, notes?: Record<string, string[]>): string {
  const files: Record<string, string> = {};
  for (const [path, n] of Object.entries(sizes)) files[path] = longFile(n, path.replace(/\W/g, "_"));
  // A note is written by hand into the entry; the writer then reformats it.
  const entries = Object.fromEntries(Object.entries(notes ?? {}).map(([path, why]) => [path, { lines: sizes[path], why }]));
  files["scripts/bloat-baseline.json"] = JSON.stringify({ ...JSON.parse(BASELINE({}, 0)), files: entries });
  const dir = repo(files);
  expect(run(dir, "--update-baseline").code).toBe(0);
  return readFileSync(join(dir, "scripts/bloat-baseline.json"), "utf-8");
}

describe("check-bloat, a baseline two branches can both record", () => {
  // Three files of neighbouring size AND neighbouring path: the worst case for
  // both orders. In v1 a.ts and b.ts sat on adjacent lines and the one that grew
  // jumped to the top; in v2 they are adjacent in path order.
  const BASE = { "src/a.ts": 300, "src/b.ts": 301, "src/c.ts": 302 };
  const BRANCH_A = { ...BASE, "src/a.ts": 330 };
  const BRANCH_B = { ...BASE, "src/b.ts": 340 };

  test("v1: two branches recording different files conflict", () => {
    // Same day on both sides, so the conflict is the size order alone.
    const same = mergeFile(v1Baseline(BASE, "2026-09-01"), v1Baseline(BRANCH_A, "2026-09-01"), v1Baseline(BRANCH_B, "2026-09-01"));
    expect(same.conflicts).toBeGreaterThan(0);
    // Different days, as two branches usually are: `updated` collides too.
    const days = mergeFile(v1Baseline(BASE, "2026-09-01"), v1Baseline(BASE, "2026-09-02"), v1Baseline(BASE, "2026-09-03"));
    expect(days.conflicts).toBeGreaterThan(0);
  });

  test("v2: the same two updates merge cleanly, into what the merged tree records", () => {
    const { conflicts, merged } = mergeFile(recorded(BASE), recorded(BRANCH_A), recorded(BRANCH_B));
    expect(conflicts).toBe(0);
    expect(merged).toBe(recorded({ ...BASE, "src/a.ts": 330, "src/b.ts": 340 }));
    expect(JSON.parse(merged).files).toEqual({ "src/a.ts": 330, "src/b.ts": 340, "src/c.ts": 302 });
  });

  test("v2: a new offender and a bump on its neighbour merge cleanly", () => {
    const { conflicts, merged } = mergeFile(recorded(BASE), recorded({ ...BASE, "src/bb.ts": 500 }), recorded(BRANCH_B));
    expect(conflicts).toBe(0);
    expect(JSON.parse(merged).files).toEqual({ "src/a.ts": 300, "src/b.ts": 340, "src/bb.ts": 500, "src/c.ts": 302 });
  });

  test("v2: notes on two different files merge cleanly, and --update-baseline keeps them", () => {
    const ours = recorded(BRANCH_A, { "src/a.ts": ["why a grew"] });
    const theirs = recorded(BRANCH_B, { "src/b.ts": ["why b grew"] });
    const { conflicts, merged } = mergeFile(recorded(BASE), ours, theirs);
    expect(conflicts).toBe(0);
    expect(JSON.parse(merged).files).toEqual({
      "src/a.ts": { lines: 330, why: ["why a grew"] },
      "src/b.ts": { lines: 340, why: ["why b grew"] },
      "src/c.ts": 302,
    });
  });

  test("v2: two branches recording the SAME file still conflict", () => {
    // The merged size is neither side's number: it has to be measured again.
    const { conflicts } = mergeFile(recorded(BASE), recorded(BRANCH_A), recorded({ ...BASE, "src/a.ts": 350 }));
    expect(conflicts).toBeGreaterThan(0);
  });

  test("v2: the ratchet reads it with the same ceilings and messages", () => {
    const sizes = { "src/big.ts": 300 };
    const baseline = recorded(sizes);
    const green = repo({ "src/big.ts": longFile(410, "src_big_ts"), "scripts/bloat-baseline.json": baseline });
    const ok = run(green);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("all within the baseline of");
    const red = repo({ "src/big.ts": longFile(421, "src_big_ts"), "scripts/bloat-baseline.json": baseline });
    const grew = run(red);
    expect(grew.code).toBe(1);
    expect(grew.out).toContain("GREW  src/big.ts: 300 -> 421 lines (+121, ceiling 420)");
  });
});

describe("check-bloat, refusing to guess", () => {
  test("exits 2 rather than 0 when there is nothing to measure", () => {
    // A green on an empty measurement is the worst outcome of the three: it
    // reports success for something that never happened.
    const dir = repo({ "README.md": "no source here\n" });
    const { code, out } = run(dir, "--max-lines=10", "--min-clone-lines=20");
    expect(code).toBe(2);
    expect(out).toContain("no tracked source file");
  });

  test("exits 2 on an unknown argument", () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n" });
    expect(run(dir, "--nope").code).toBe(2);
  });

  test("the repo's own baseline is green today", () => {
    const res = spawnSync("bun", ["run", SCRIPT], { encoding: "utf-8" });
    expect(`${res.stdout}${res.stderr}`).toContain("OK");
    expect(res.status).toBe(0);
  });
});
