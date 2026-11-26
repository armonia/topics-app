/**
 * How a `spawn_agent` child ended, read from its own transcript, and whether
 * its prompt ever reached it.
 *
 * The records below are the shapes the Claude CLI writes today: the start-up
 * preamble (mode, permission-mode, a system line) before any prompt, one
 * assistant record per content block with the turn's `stop_reason`, and a
 * `<synthetic>` record flagged `isApiErrorMessage` for an API failure. The
 * cases are the production ones behind the "ended with no output" report and
 * behind the working sentences reported as results (08/09-29/09).
 * @covers SUBAGENT-04, SUBAGENT-05
 */
import { describe, expect, test } from "bun:test";
import { transcriptHasPrompt } from "./claude-subagent-transcript";

const PROMPT = "Mappa dove finisce il tool_result del provider nativo e riporta i file";

const j = (o: unknown) => JSON.stringify(o);
const preamble = [
  j({ type: "mode", mode: "default" }),
  j({ type: "permission-mode", permissionMode: "bypassPermissions" }),
  j({ type: "system", subtype: "informational", content: "AGENTS.md loaded" }),
];
const prompt = (text = PROMPT) => j({ type: "user", message: { role: "user", content: text } });
const toolResult = () =>
  j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

describe("transcriptHasPrompt: a transcript file is not a delivered prompt", () => {
  test("the start-up records alone do not count (d6158ec6, c82359c1: zero user records)", () => {
    expect(transcriptHasPrompt(preamble, PROMPT.slice(0, 80))).toBe(false);
  });

  test("the user record carrying the prompt does, pasted several times or not", () => {
    expect(transcriptHasPrompt([...preamble, prompt()], PROMPT.slice(0, 80))).toBe(true);
    expect(transcriptHasPrompt([...preamble, prompt(`<pasted_content>${PROMPT}</pasted_content>`.repeat(3))], PROMPT.slice(0, 80))).toBe(true);
  });

  test("a tool result or another prompt is not this prompt", () => {
    expect(transcriptHasPrompt([...preamble, toolResult(), prompt("Sei vivo?")], PROMPT.slice(0, 80))).toBe(false);
  });
});

