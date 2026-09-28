/**
 * A `testTmpDir` root is removed once the test file that made it is over, and
 * not a moment before its own teardown has run.
 *
 * THE DEFECT IT PINS (measured on 28/09/2026). The helper removed its roots in
 * a `process.on("exit")` handler, and under `bun test` (bun 1.3.8) that handler
 * never runs. Every run left its roots behind: one run of
 * `chat-woken-turn.test.ts` took `/tmp/topics-test/chat-woken-ws-*` from 80 to
 * 88, the folder had grown to 76,579 directories and 36 GB, the disk reached
 * 100% and the production server logged SQLITE_FULL.
 *
 * WHY CHILD PROCESSES. The removal happens between two files and after the last
 * one, which a test cannot watch from inside its own run. A child `bun test`
 * with its cwd in the repo loads the preload from bunfig.toml like any other
 * run, and the fixture files live in a scratch folder, outside the suite roots.
 * They are numbered because bun runs the files of a run in path order.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, testTmpDir } from "./index";

const HELPER_MODULE = path.join(PROJECT_ROOT, "tests/integration/helpers/index.ts");
const DB_MODULE = path.join(PROJECT_ROOT, "server/db.ts");
const REPORT_ENV = "TEST_TMP_DIR_CLEANUP_REPORT";

/**
 * Prepended to every fixture file. `record` writes down each root the fixture
 * made, so the parent can look for it once the child is gone.
 */
const PRELUDE = `
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDataDir, testTmpDir } from ${JSON.stringify(HELPER_MODULE)};
import { getDatabase, initDatabase } from ${JSON.stringify(DB_MODULE)};
const REPORT = process.env.${REPORT_ENV}!;
function record(key: string, dir: string): void { appendFileSync(REPORT, key + "\\t" + dir + "\\n"); }
function recorded(key: string): string {
  const line = readFileSync(REPORT, "utf8").split("\\n").find((l) => l.startsWith(key + "\\t"));
  if (!line) throw new Error("nothing recorded under " + key);
  return line.slice(key.length + 1);
}
`;

interface ChildRun {
  code: number;
  /** The tail of what the child printed, for the message of a red. */
  output: string;
  /** Every root the fixtures recorded, by key. */
  roots: Record<string, string>;
}

/** Runs the fixture files, in the order of their names, in ONE child `bun test`. */
function runFixtures(files: Record<string, string>): ChildRun {
  const scratch = testTmpDir("tmp-dir-cleanup-fixtures");
  const report = path.join(scratch, "report.tsv");
  writeFileSync(report, "");
  const paths = Object.entries(files).map(([name, body]) => {
    const file = path.join(scratch, name);
    writeFileSync(file, PRELUDE + body);
    return file;
  });
  const child = Bun.spawnSync(["bun", "test", ...paths], {
    cwd: PROJECT_ROOT,
    // `process.env` carries `TOPICS_GATE_HELD`: the child does not queue for the semaphore.
    env: { ...process.env, [REPORT_ENV]: report },
    stdout: "pipe",
    stderr: "pipe",
  });
  const roots: Record<string, string> = {};
  for (const line of readFileSync(report, "utf8").split("\n")) {
    const [key, dir] = line.split("\t");
    if (key && dir) roots[key] = dir;
  }
  // The tail is enough to read a red, and the migrations log hundreds of lines before it.
  const output = (new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr)).slice(-4000);
  return { code: child.exitCode ?? -1, output, roots };
}

function leftBehind(run: ChildRun): string[] {
  return Object.values(run.roots).filter((dir) => existsSync(dir));
}

describe("testTmpDir roots live exactly as long as their test file", () => {
  test("roots made at collection, in beforeAll and inside a test outlive every test and the file's own teardown, then go", () => {
    const run = runFixtures({
      "1-one-file.test.ts": `
        const atCollection = testTmpDir("tmp-cleanup-collection");
        record("collection", atCollection);
        let inBeforeAll = "";
        let inTest = "";
        beforeAll(() => { inBeforeAll = testTmpDir("tmp-cleanup-before-all"); record("beforeAll", inBeforeAll); });
        // The file's teardown writes into every root: a root removed before
        // this hook makes it throw, and the child exits red.
        afterAll(() => { for (const dir of [atCollection, inBeforeAll, inTest]) writeFileSync(join(dir, "teardown"), "ok"); });
        test("a root made inside a test", () => { inTest = testTmpDir("tmp-cleanup-in-test"); record("test", inTest); });
        test("every root is still there for the next test", () => {
          for (const dir of [atCollection, inBeforeAll, inTest]) expect(existsSync(dir)).toBe(true);
        });
      `,
    });
    expect(run.code, run.output).toBe(0);
    expect(Object.keys(run.roots).sort()).toEqual(["beforeAll", "collection", "test"]);
    expect(leftBehind(run), run.output).toEqual([]);
  }, 60_000);

  test("in a run of two files the first file's roots are gone before the second file's tests, not only at the end", () => {
    const run = runFixtures({
      "1-first.test.ts": `
        const ROOT = testTmpDir("tmp-cleanup-first");
        record("first", ROOT);
        test("uses its root", () => writeFileSync(join(ROOT, "work"), "1"));
      `,
      "2-second.test.ts": `
        const ROOT = testTmpDir("tmp-cleanup-second");
        record("second", ROOT);
        test("finds the first file's root gone and its own in place", () => {
          expect(existsSync(recorded("first"))).toBe(false);
          expect(existsSync(ROOT)).toBe(true);
        });
      `,
    });
    expect(run.code, run.output).toBe(0);
    expect(Object.keys(run.roots).sort()).toEqual(["first", "second"]);
    expect(leftBehind(run), run.output).toEqual([]);
  }, 60_000);

  test("a root that still holds the open process database is not pulled from under the next file", () => {
    // The shape that exists in the suite: a file leaves the database singleton
    // open in its root (18 of the 46 files using setupTestDataDir never close
    // it), and a later file calls initDatabase, which hands back that same
    // handle. Removing the root under it makes the next query fail with
    // SQLITE_IOERR_VNODE.
    const run = runFixtures({
      "1-leaves-database-open.test.ts": `
        const ROOT = testTmpDir("tmp-cleanup-db-owner");
        record("owner", ROOT);
        beforeAll(() => { setupTestDataDir(ROOT); initDatabase(${JSON.stringify(PROJECT_ROOT)}); });
        test("the database lives in this root", () => expect(getDatabase().filename.startsWith(ROOT)).toBe(true));
      `,
      "2-adopts-the-handle.test.ts": `
        beforeAll(() => { initDatabase(${JSON.stringify(PROJECT_ROOT)}); });
        test("the handle it was given still answers", () => {
          expect(getDatabase().query("SELECT count(*) AS n FROM sqlite_master").get()).toBeTruthy();
        });
      `,
    });
    expect(run.code, run.output).toBe(0);
    expect(Object.keys(run.roots)).toEqual(["owner"]);
    expect(leftBehind(run), run.output).toEqual([]);
  }, 60_000);
});
