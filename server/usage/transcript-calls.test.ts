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

const line = (id: string, model = "m", cwd?: string) => JSON.stringify({ type: "assistant", timestamp: "2026-11-20T10:00:00Z", cwd, message: { id, model, usage: { input_tokens: 1, output_tokens: 2 } } });

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

  test("a multi-byte character cut between two reads does not lose its line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-")); dirs.push(dir);
    const file = join(dir, "s.jsonl");
    const second = Buffer.from(line("b", "m", "/città"));
    const cut = second.indexOf(0xc3) + 1; // between the two bytes of the accented letter
    writeFileSync(file, Buffer.concat([Buffer.from(`${line("a")}
`), second.subarray(0, cut)]));
    expect(readTranscript(file).length).toBe(1);
    appendFileSync(file, Buffer.concat([second.subarray(cut), Buffer.from("\n")]));
    expect(readTranscript(file).length).toBe(2);
  });

  test("the second read parses only the new bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-")); dirs.push(dir);
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${line("a", "old")}
`);
    expect(readTranscript(file)[0].model).toBe("old");
    // Same size, other model: a read from the start would show it, a read of the tail alone cannot.
    writeFileSync(file, `${line("a", "new")}
${line("b")}
`);
    const calls = readTranscript(file);
    expect(calls.map((c) => c.model)).toEqual(["old", "m"]);
  });
});
