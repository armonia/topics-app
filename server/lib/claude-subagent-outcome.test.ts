/**
 * How a `spawn_agent` child ended, read from its own transcript, and whether
 * its prompt ever reached it.
 *
 * The records below are the shapes the Claude CLI writes today: the start-up
 * preamble (mode, permission-mode, a system line) before any prompt, one
 * assistant record per content block with the turn's `stop_reason`, and a
 * `<synthetic>` record flagged `isApiErrorMessage` for an API failure. The
 * cases are the production ones behind "terminato senza output" and behind
 * the working sentences reported as results (08/09-29/09).
 * @covers SUBAGENT-04, SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { classifySubAgentTranscript, transcriptHasPrompt } from "./claude-subagent-transcript";

const PROMPT = "Mappa dove finisce il tool_result del provider nativo e riporta i file";

const j = (o: unknown) => JSON.stringify(o);
const startup = [
  j({ type: "mode", mode: "default" }),
  j({ type: "permission-mode", permissionMode: "bypassPermissions" }),
  j({ type: "system", subtype: "informational", content: "AGENTS.md loaded" }),
];
const prompt = (text = PROMPT) => j({ type: "user", message: { role: "user", content: text } });
const say = (text: string, stop: "end_turn" | "tool_use" | null) =>
  j({ type: "assistant", message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const toolUse = () =>
  j({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
const toolResult = () =>
  j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const apiError = (text: string) =>
  j({ type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text }] } });

describe("transcriptHasPrompt: a transcript file is not a delivered prompt", () => {
  test("the start-up records alone do not count (d6158ec6, c82359c1: zero user records)", () => {
    expect(transcriptHasPrompt(startup, PROMPT.slice(0, 80))).toBe(false);
  });

  test("the user record carrying the prompt does, pasted several times or not", () => {
    expect(transcriptHasPrompt([...startup, prompt()], PROMPT.slice(0, 80))).toBe(true);
    expect(transcriptHasPrompt([...startup, prompt(`<pasted_content>${PROMPT}</pasted_content>`.repeat(3))], PROMPT.slice(0, 80))).toBe(true);
  });

  test("a tool result or another prompt is not this prompt", () => {
    expect(transcriptHasPrompt([...startup, toolResult(), prompt("Sei vivo?")], PROMPT.slice(0, 80))).toBe(false);
  });
});

describe("classifySubAgentTranscript", () => {
  test("a turn closed by end_turn is completed, with the final text", () => {
    const lines = [...startup, prompt(), toolUse(), toolResult(), say("Report: 3 files", "end_turn")];
    expect(classifySubAgentTranscript(lines, "stopped")).toEqual({ status: "completed", partial: false, text: "Report: 3 files" });
  });

  test("a stop mid-turn is stopped and partial, and the working sentence is not the outcome", () => {
    const lines = [...startup, prompt(), say("Sto mappando dove il tool_result finisce", "tool_use"), toolUse(), toolResult()];
    expect(classifySubAgentTranscript(lines, "stopped")).toEqual({
      status: "stopped", partial: true, text: "Sto mappando dove il tool_result finisce",
      reason: { code: "stopped-by-parent" },
    });
  });

  test("a prompt that never arrived is undelivered, not a silent finish", () => {
    expect(classifySubAgentTranscript(startup, "stopped")).toEqual({
      status: "undelivered", partial: false, text: "", reason: { code: "no-prompt" },
    });
  });

  test("a prompt with no answer yet, stopped 7 s after the spawn, is a stop with nothing to quote", () => {
    expect(classifySubAgentTranscript([...startup, prompt()], "stopped")).toEqual({
      status: "stopped", partial: false, text: "", reason: { code: "stopped-by-parent" },
    });
  });

  test("a spend limit is a failure carrying its line", () => {
    const lines = [...startup, prompt(), toolUse(), toolResult(), apiError("You've hit your monthly spend limit")];
    expect(classifySubAgentTranscript(lines, "stopped")).toEqual({
      status: "failed", partial: false, text: "",
      reason: { code: "api-error", detail: "You've hit your monthly spend limit" },
    });
  });

  test("a follow-up turn cut mid-way is partial even when the first turn had finished", () => {
    const lines = [...startup, prompt(), say("Primo report", "end_turn"), prompt("Ora il secondo file"), say("Apro il secondo", "tool_use")];
    expect(classifySubAgentTranscript(lines, "closed")).toEqual({
      status: "stopped", partial: true, text: "Apro il secondo", reason: { code: "tab-closed" },
    });
  });

  test("a PTY that died on its own mid-turn is a failure with its exit code", () => {
    const lines = [...startup, prompt(), say("Lancio i test", "tool_use")];
    expect(classifySubAgentTranscript(lines, "exited", 137)).toEqual({
      status: "failed", partial: true, text: "Lancio i test", reason: { code: "exit-code", exitCode: 137 },
    });
  });

  test("a terminal lost to a restart is lost, and no transcript is named as such", () => {
    expect(classifySubAgentTranscript([...startup, prompt(), toolUse()], "lost").status).toBe("lost");
    expect(classifySubAgentTranscript(null, "lost")).toEqual({
      status: "lost", partial: false, text: "", reason: { code: "no-transcript" },
    });
  });

  test("an Escape marker keeps the turn open instead of counting as a new prompt", () => {
    const esc = j({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    const lines = [...startup, prompt(), say("Leggo i file", "tool_use"), esc];
    expect(classifySubAgentTranscript(lines, "stopped")).toMatchObject({ status: "stopped", partial: true, text: "Leggo i file" });
  });
});
