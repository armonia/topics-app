/**
 * HOW LONG A FOREGROUND MARKER LIVES, which is the whole invariant "a foreground
 * command is never frozen".
 *
 * This module is the ONLY evidence the freezer has for that rule, and it had no
 * test at all: everything downstream passed `foregroundBash` as a hand-written
 * string, so nobody measured what the hooks actually do to it. Three ordinary
 * turns used to empty it while the command was still running - a `PostToolUse`
 * of any other tool (the hook is installed on every matcher), a background Bash
 * arriving in the same response, a second foreground Bash in the same response -
 * and each of them handed a live foreground command to the freezer as a
 * candidate, because a stale background record (no expiry, cap of 20) is a
 * substring of its `ps` line.
 *
 * @covers KANBAN-85
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  backgroundBashFor,
  endBashToolCall,
  foregroundBashFor,
  forgetBashRecords,
  noteBashToolCall,
  readBashHook,
} from "./background-bash-record";

const SID = "claude-session-brina";

const fg = (command: string, id?: string, now = 1): void => noteBashToolCall(SID, "Bash", { command }, now, id);
const bg = (command: string, id?: string, now = 1): void =>
  noteBashToolCall(SID, "Bash", { command, run_in_background: true }, now, id);

beforeEach(() => forgetBashRecords(SID));

describe("what a PreToolUse says, and nothing more", () => {
  test("only a Bash is read, and `run_in_background` decides which kind it is", () => {
    expect(readBashHook("Read", { file_path: "/x" }).kind).toBe("other");
    expect(readBashHook("Bash", { command: "   " }).kind).toBe("other");
    expect(readBashHook("Bash", { command: "bun test" }).kind).toBe("foreground");
    expect(readBashHook("Bash", { command: "bun test", run_in_background: true }).kind).toBe("background");
    // Anything but a literal `true` is not a promise of a background shell.
    expect(readBashHook("Bash", { command: "bun test", run_in_background: "true" }).kind).toBe("foreground");
  });
});

describe("the foreground marker outlives everything that is not its own PostToolUse", () => {
  test("the PostToolUse of another tool leaves the command in flight alone", () => {
    fg("bun test tests/foo.test.ts", "toolu_01");
    endBashToolCall(SID, "Read", { file_path: "/repo/README.md" }, "toolu_02");
    expect(foregroundBashFor(SID)).toEqual(["bun test tests/foo.test.ts"]);
  });

  test("a background Bash in the same response does not empty it", () => {
    fg("bun test tests/foo.test.ts", "toolu_01");
    bg("bun run build:all", "toolu_02");
    expect(foregroundBashFor(SID)).toEqual(["bun test tests/foo.test.ts"]);
    expect(backgroundBashFor(SID).map((b) => b.command)).toEqual(["bun run build:all"]);
  });

  test("two foreground Bash calls in one response are both in flight", () => {
    fg("bun test a.test.ts", "toolu_01");
    fg("bun test b.test.ts", "toolu_02");
    expect(foregroundBashFor(SID)).toEqual(["bun test a.test.ts", "bun test b.test.ts"]);
  });

  test("its own PostToolUse removes exactly that call, by id", () => {
    fg("bun test a.test.ts", "toolu_01");
    fg("bun test b.test.ts", "toolu_02");
    endBashToolCall(SID, "Bash", { command: "bun test a.test.ts" }, "toolu_01");
    expect(foregroundBashFor(SID)).toEqual(["bun test b.test.ts"]);
  });

  test("with no id in the payload the command text is the key, and one end removes one entry", () => {
    fg("bun test a.test.ts");
    fg("bun test a.test.ts");
    fg("bun test b.test.ts");
    endBashToolCall(SID, "Bash", { command: "bun test a.test.ts" });
    expect(foregroundBashFor(SID)).toEqual(["bun test a.test.ts", "bun test b.test.ts"]);
  });

  test("a PostToolUse that identifies nothing keeps the marker: an unread payload is never an opportunity", () => {
    fg("bun test a.test.ts");
    endBashToolCall(SID, "Bash", {}, undefined);
    endBashToolCall(SID, "Read", { file_path: "/x" }, undefined);
    expect(foregroundBashFor(SID)).toEqual(["bun test a.test.ts"]);
  });

  test("the end of a background shell running the same text does not unname the foreground one", () => {
    // No ids in these payloads, so the command text is the only key - and the
    // same text can be running in both shapes at once.
    fg("bun test a.test.ts");
    endBashToolCall(SID, "Bash", { command: "bun test a.test.ts", run_in_background: true }, undefined);
    expect(foregroundBashFor(SID)).toEqual(["bun test a.test.ts"]);
  });

  test("a session that ended keeps nothing", () => {
    fg("bun test a.test.ts", "toolu_01");
    bg("bun run build:all", "toolu_02");
    forgetBashRecords(SID);
    expect(foregroundBashFor(SID)).toEqual([]);
    expect(backgroundBashFor(SID)).toEqual([]);
  });

  test("a PostToolUse that never arrives cannot grow the list without bound", () => {
    for (let i = 0; i < 40; i++) fg(`bun test ${i}.test.ts`, `toolu_${i}`);
    const live = foregroundBashFor(SID);
    expect(live).toHaveLength(20);
    expect(live.at(-1), "the newest call is the one still worth protecting").toBe("bun test 39.test.ts");
  });
});
