/**
 * @covers RUNTIME-06
 *
 * A WARNING THAT DOES NOT SAY WHAT IS BROKEN STOPS BEING READ.
 *
 * The nightly's reporting worked: it opened the issue, commented on it, and
 * refused to close until the suite went green. Nobody read it anyway. Issue #31
 * stayed open from 01/09 collecting EIGHTEEN identical comments, one per night,
 * each saying "open the run and look at the per-shard jobs": eighteen
 * invitations to redo the same investigation. Which test fell - always the same
 * one, `bench-streaming.spec.ts` - was found on 19/09 by a hand census.
 *
 * These tests hold still what makes the warning readable, and above all the
 * cases where the script must STAY QUIET instead of lying.
 *
 * The `results.json` shape here is Playwright's real one, copied from what the
 * nightly 35431055065 artifact actually contains: `status: "expected"` for a
 * pass, `"unexpected"` for a failure, `"flaky"` for one that passed on retry.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), "failed-titles-"));
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

const SCRIPT = join(import.meta.dir, "e2e-failed-titles.ts");

function run(dir: string): string {
  const p = Bun.spawnSync(["bun", SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
  // The exit code is part of the contract: this script INFORMS, and a failure
  // of its own must not stop the issue from being opened.
  expect(p.exitCode, "the script must always exit 0").toBe(0);
  return new TextDecoder().decode(p.stdout).trim();
}

function write(name: string, data: unknown): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "shard-1"), { recursive: true });
  writeFileSync(join(dir, "shard-1", "results.json"), JSON.stringify(data));
  return dir;
}

/** A spec the way Playwright really writes it. */
const spec = (file: string, line: number, title: string, status: string) => ({
  title,
  file,
  line,
  tests: [{ status, results: [{ status }] }],
});

describe("the names of the red tests", () => {
  test("a red is named with file, line and title", () => {
    const dir = write("one", {
      suites: [{ file: "bench-streaming.spec.ts", specs: [spec("bench-streaming.spec.ts", 548, "absorbs a burst @nightly", "unexpected")] }],
    });
    expect(run(dir)).toBe("bench-streaming.spec.ts:548 > absorbs a burst @nightly");
  });

  test("a GREEN does not show up", () => {
    const dir = write("green", {
      suites: [{ file: "a.spec.ts", specs: [spec("a.spec.ts", 10, "all fine", "expected")] }],
    });
    expect(run(dir)).toContain("no red test");
  });

  test("a test that passed on RETRY is not a red", () => {
    // The distinction that avoids the hunt for a defect that is not there:
    // `flaky` means it passed in the end. Listing it would send somebody after
    // a fault that does not exist, which is exactly how a warning loses credit.
    // The first version of the script got this wrong and this test caught it.
    const dir = write("flaky", {
      suites: [{ file: "b.spec.ts", specs: [{ title: "dancer", file: "b.spec.ts", line: 3, tests: [{ status: "flaky", results: [{ status: "unexpected" }, { status: "expected" }] }] }] }],
    });
    expect(run(dir)).toContain("no red test");
  });

  test("skipped ones are not red", () => {
    const dir = write("skip", {
      suites: [{ file: "c.spec.ts", specs: [spec("c.spec.ts", 7, "skipped one", "skipped")] }],
    });
    expect(run(dir)).toContain("no red test");
  });

  test("nested suites are walked", () => {
    const dir = write("nested", {
      suites: [{ title: "outer", file: "d.spec.ts", suites: [{ title: "inner", file: "d.spec.ts", specs: [spec("d.spec.ts", 42, "deep down", "unexpected")] }] }],
    });
    expect(run(dir)).toBe("d.spec.ts:42 > deep down");
  });

  test("the same red on several shards shows up once", () => {
    const dir = join(root, "dup");
    for (const s of ["shard-1", "shard-2"]) {
      mkdirSync(join(dir, s), { recursive: true });
      writeFileSync(join(dir, s, "results.json"), JSON.stringify({
        suites: [{ file: "e.spec.ts", specs: [spec("e.spec.ts", 9, "the same", "unexpected")] }],
      }));
    }
    expect(run(dir)).toBe("e.spec.ts:9 > the same");
  });

  test("a truncated artifact does not silence the others", () => {
    // Half a JSON is the norm when a shard dies: if the script blew up, the
    // issue would lose the names that WERE readable too.
    const dir = join(root, "broken");
    mkdirSync(join(dir, "shard-1"), { recursive: true });
    writeFileSync(join(dir, "shard-1", "results.json"), "{ this is not json");
    mkdirSync(join(dir, "shard-2"), { recursive: true });
    writeFileSync(join(dir, "shard-2", "results.json"), JSON.stringify({
      suites: [{ file: "f.spec.ts", specs: [spec("f.spec.ts", 1, "survivor", "unexpected")] }],
    }));
    expect(run(dir)).toBe("f.spec.ts:1 > survivor");
  });

  test("a shard that died before writing says so, instead of pretending", () => {
    // The job is red but no TEST is: it sends the reader after a crash instead
    // of an assertion, which is the right diagnosis for that case.
    const dir = write("empty", { suites: [] });
    expect(run(dir)).toContain("die before writing");
  });

  test("with no paths it does not blow up", () => {
    const p = Bun.spawnSync(["bun", SCRIPT], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(new TextDecoder().decode(p.stdout)).toContain("no path");
  });
});
