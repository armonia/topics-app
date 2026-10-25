/**
 * @covers TERM-14
 *
 * A seeded prompt carrying a suspend byte is filtered once, with the child
 * session type, and the filtered text drives both the typing and the echo
 * checks: otherwise the echo probe misses and the seed retypes the prompt.
 */
import { describe, expect, test } from "bun:test";
import { normalizePromptSnippet, transcriptHasPrompt } from "../lib/claude-subagent-transcript";
import { composerHoldsPrompt } from "../lib/subagent-seed";
import { seedPromptFingerprintForSession, seedPromptForSession } from "./terminal";

// Ctrl+Z, built without a literal control byte in source.
const SUSPEND = String.fromCharCode(26);

describe("seedPromptForSession", () => {
  test("a prompt carrying ctrl+z is typed without it", () => {
    expect(seedPromptForSession("claude-code", "do it" + SUSPEND + " now")).toBe("do it now");
  });

  test("the echo check sees the filtered text, so a present prompt is not retyped", () => {
    const typed = seedPromptForSession("claude-code", "do it" + SUSPEND + " now");
    const screen = "> do it now";
    expect(composerHoldsPrompt(screen, typed)).toBe(true);
    expect(composerHoldsPrompt(screen, "do it" + SUSPEND + " now")).toBe(false);
  });

  test("the transcript fingerprint matches the filtered prompt that Claude received", () => {
    const rawPrompt = "do it" + SUSPEND + " now";
    const fingerprint = seedPromptFingerprintForSession("claude-code", rawPrompt);
    const transcript = [JSON.stringify({ type: "user", message: { content: "do it now" } })];

    expect(fingerprint).toBe("do it now");
    expect(transcriptHasPrompt(transcript, fingerprint)).toBe(true);
    expect(transcriptHasPrompt(transcript, normalizePromptSnippet(rawPrompt))).toBe(false);
  });

  test("other sessions seed the prompt untouched", () => {
    expect(seedPromptForSession("shell", "do it" + SUSPEND)).toBe("do it" + SUSPEND);
  });
});
