/**
 * Reading the end of a log a process writes by itself, and cutting it while
 * that process still writes. Every reload of the server loads a command's log,
 * so only its last part is read, never the whole file; and a command left
 * running (a dev server) would grow its log without bound, so the registry
 * cuts it to its last part the way it rotates a manifest script's log.
 *
 * @covers CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openTail, readFileEnd, readTail, shrinkLog } from "./file-tail";

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

describe("shrinkLog", () => {
  /** A log held open the way the registry hands it to a command: append mode. */
  function liveLog(name: string, lines: number): { path: string; writer: number } {
    const path = join(DIR, name);
    const writer = openSync(path, "a");
    writeSync(writer, Array.from({ length: lines }, (_, i) => `line ${i}\n`).join(""));
    return { path, writer };
  }

  test("keeps the last whole lines, and the writer goes on at the new end", () => {
    const { path, writer } = liveLog("live.log", 1000);
    try {
      const tail = openTail(path);
      readTail(tail);
      shrinkLog(tail, 100);
      const kept = readFileSync(path, "utf8");
      expect(kept.length).toBeLessThanOrEqual(100);
      expect(kept.startsWith("line ")).toBe(true);
      expect(kept.endsWith("line 999\n")).toBe(true);
      writeSync(writer, "after the cut\n");
      expect(readFileSync(path, "utf8")).toBe(`${kept}after the cut\n`);
      // The tail moved with the cut: it reads the new line, and only that.
      expect(readTail(tail).text).toBe("after the cut\n");
    } finally {
      closeSync(writer);
    }
  });

  test("what the tail had not read yet stays, and is read once", () => {
    const { path, writer } = liveLog("unread.log", 1000);
    try {
      const tail = openTail(path);
      readTail(tail);
      writeSync(writer, "not read yet\n");
      shrinkLog(tail, 100);
      expect(readTail(tail).text).toBe("not read yet\n");
      expect(readTail(tail).text).toBe("");
    } finally {
      closeSync(writer);
    }
  });

  test("a log within the limit is left as it is", () => {
    const { path, writer } = liveLog("small.log", 3);
    try {
      const tail = openTail(path);
      readTail(tail);
      shrinkLog(tail, 1000);
      expect(readFileSync(path, "utf8")).toBe("line 0\nline 1\nline 2\n");
      expect(tail.offset).toBe(statSync(path).size);
    } finally {
      closeSync(writer);
    }
  });
});
