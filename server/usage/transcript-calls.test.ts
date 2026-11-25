/**
 * Reading a transcript appends to what was parsed instead of re-reading the file.
 * @covers USAGE-28
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcript-calls";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const line = (id: string) => JSON.stringify({ type: "assistant", timestamp: "2026-11-20T10:00:00Z", message: { id, model: "m", usage: { input_tokens: 1, output_tokens: 2 } } });

describe("readTranscript", () => {
  test("a grown file adds only its new calls, a repeated id counts once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-")); dirs.push(dir);
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${line("a")}\n${line("a")}\n${line("b")}\n`);
    expect(readTranscript(file).length).toBe(2);
    appendFileSync(file, `${line("c")}\n`);
    expect(readTranscript(file).length).toBe(3);
  });

  test("a half-written last line waits for its end", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-")); dirs.push(dir);
    const file = join(dir, "s.jsonl");
    const whole = line("x");
    writeFileSync(file, `${line("a")}\n${whole.slice(0, 20)}`);
    expect(readTranscript(file).length).toBe(1);
    appendFileSync(file, `${whole.slice(20)}\n`);
    expect(readTranscript(file).length).toBe(2);
  });

  test("a truncated file is read again from the start", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-")); dirs.push(dir);
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${line("a")}\n${line("b")}\n`);
    expect(readTranscript(file).length).toBe(2);
    writeFileSync(file, `${line("z")}\n`);
    expect(readTranscript(file).length).toBe(1);
  });
});
