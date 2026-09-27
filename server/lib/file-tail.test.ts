/**
 * Reading the end of a log a process writes by itself. A `run_command` log has
 * no rotation (the command writes it, not the registry), so a dev server left
 * running for days grows it without bound, and every reload of the server
 * loads it: only its last part is read, never the whole file.
 *
 * @covers CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileEnd } from "./file-tail";

const DIR = mkdtempSync(join(tmpdir(), "topics-file-end-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const LOG = join(DIR, "cmd.log");
writeFileSync(LOG, Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join(""));

describe("readFileEnd", () => {
  test("the last bytes only, from the first whole line, and the size a tail resumes from", () => {
    const end = readFileEnd(LOG, 100)!;
    expect(end.size).toBe(statSync(LOG).size);
    expect(end.text.length).toBeLessThanOrEqual(100);
    expect(end.text.startsWith("line ")).toBe(true);
    expect(end.text.endsWith("line 999\n")).toBe(true);
  });

  test("a file smaller than the window is read whole", () => {
    const end = readFileEnd(LOG, 1 << 20)!;
    expect(end.text.startsWith("line 0\n")).toBe(true);
    expect(end.text.split("\n")).toHaveLength(1001);
  });

  test("one line longer than the window is kept, cut, rather than dropped", () => {
    const long = join(DIR, "long.log");
    writeFileSync(long, "x".repeat(500));
    expect(readFileEnd(long, 100)!.text).toBe("x".repeat(100));
  });

  test("no file, nothing", () => {
    expect(readFileEnd(join(DIR, "missing.log"), 100)).toBeNull();
  });
});
