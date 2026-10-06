/**
 * The handover a CLI-born child carries when it comes back on the engine
 * (SUBAGENT-14): its starting task and its last report, read off the CLI
 * transcript, composed into the migrated child's first turn.
 * @covers SUBAGENT-14
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cliHandover, findCliTranscript, migratedChildPrompt } from "./subagent-migration";

const line = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content } });

describe("cliHandover", () => {
  test("the task is the first person message, the report the last assistant text; tool rows are skipped", () => {
    const jsonl = [
      line("user", "build the bastion"),
      line("assistant", [{ type: "text", text: "starting" }, { type: "tool_use", id: "t", name: "Bash", input: {} }]),
      line("user", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      line("assistant", [{ type: "text", text: "70/70 green" }]),
      "not json",
    ].join("\n");
    expect(cliHandover(jsonl)).toEqual({ task: "build the bastion", lastReport: "70/70 green" });
  });
});

describe("migratedChildPrompt", () => {
  test("names the child, carries task, report and transcript, ends with the new message", () => {
    const p = migratedChildPrompt({ name: "arte", task: "T", lastReport: "R", transcriptPath: "/x.jsonl", promptSnippet: null, newInput: "next" });
    expect(p).toContain("«arte»");
    expect(p).toContain("<compito>\nT\n</compito>");
    expect(p).toContain("<resoconto>\nR\n</resoconto>");
    expect(p).toContain("/x.jsonl");
    expect(p.endsWith("next")).toBe(true);
  });

  test("without a transcript the snippet stands in for the task", () => {
    const p = migratedChildPrompt({ name: "a", task: null, lastReport: null, transcriptPath: null, promptSnippet: "S", newInput: "n" });
    expect(p).toContain("<compito>\nS\n</compito>");
    expect(p).not.toContain("<resoconto>");
  });
});

describe("findCliTranscript", () => {
  test("finds the session in any project folder, refuses a non-uuid", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-proj-"));
    const sid = "00000000-0000-4000-8000-0000000000bb";
    mkdirSync(join(dir, "-Users-x-proj"));
    writeFileSync(join(dir, "-Users-x-proj", `${sid}.jsonl`), "");
    expect(findCliTranscript(sid, dir)).toBe(join(dir, "-Users-x-proj", `${sid}.jsonl`));
    expect(findCliTranscript("../etc", dir)).toBeNull();
  });
});
