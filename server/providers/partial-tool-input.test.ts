/**
 * The primary argument of a call still being written.
 *
 * @covers CHAT-NTOOL-06
 */
import { describe, expect, test } from "bun:test";
import { extractPrimaryToolArg } from "./partial-tool-input";

describe("extractPrimaryToolArg", () => {
  test("a complete value is read in both modes", () => {
    const buf = '{"command":"ls -la","cwd":"sub';
    expect(extractPrimaryToolArg(buf)).toEqual({ key: "command", value: "ls -la" });
    expect(extractPrimaryToolArg(buf, { open: true })).toEqual({ key: "command", value: "ls -la" });
  });

  test("a value still being written is skipped by default (the CLI contract)", () => {
    expect(extractPrimaryToolArg('{"command":"cat > a.txt <<\'EOF\'\\nline 1')).toBeNull();
  });

  test("open: the value so far, with its escapes decoded", () => {
    const got = extractPrimaryToolArg('{"command":"cat > a.txt <<\'EOF\'\\nline 1\\tx', { open: true });
    expect(got).toEqual({ key: "command", value: "cat > a.txt <<'EOF'\nline 1\tx" });
  });

  test("open: an escape split across two chunks never shows as a backslash", () => {
    expect(extractPrimaryToolArg('{"command":"echo a\\', { open: true })).toEqual({ key: "command", value: "echo a" });
    expect(extractPrimaryToolArg('{"command":"echo \\u00', { open: true })).toEqual({ key: "command", value: "echo " });
    expect(extractPrimaryToolArg('{"command":"echo \\u00e8', { open: true })).toEqual({ key: "command", value: "echo è" });
  });

  test("open: nothing before the first character of the value", () => {
    expect(extractPrimaryToolArg('{"command":"', { open: true })).toBeNull();
    expect(extractPrimaryToolArg('{"comm', { open: true })).toBeNull();
  });

  test("a complete higher-priority key wins over an open lower one", () => {
    const buf = '{"file_path":"/tmp/x.ts","content":"export const';
    expect(extractPrimaryToolArg(buf, { open: true })).toEqual({ key: "file_path", value: "/tmp/x.ts" });
  });

  test("the value grows as chunks arrive", () => {
    const json = JSON.stringify({ command: "for i in 1 2 3; do echo \"riga $i\"; done" });
    const seen: string[] = [];
    for (let end = 1; end <= json.length; end++) {
      const got = extractPrimaryToolArg(json.slice(0, end), { open: true });
      if (got && got.value !== seen.at(-1)) seen.push(got.value);
    }
    expect(seen.at(-1)).toBe("for i in 1 2 3; do echo \"riga $i\"; done");
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
  });
});
