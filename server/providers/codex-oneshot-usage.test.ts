/**
 * A Codex one-shot reads its answer AND its usage from `codex exec --json`.
 *
 * In text mode the one-shot printed the answer alone, so every title, judge
 * and chat name on Codex left a side-call row with no tokens. The events are a
 * real capture (codex-cli 0.160.0, 24/10), the under-development warning item
 * included: it is an `error` ITEM, not a failure.
 * @covers USAGE-24
 */
import { describe, expect, test } from "bun:test";
import { parseCodexOneShotJsonl } from "./codex";

const CAPTURE = [
  `{"type":"thread.started","thread_id":"01a16e17-59d0-7f21-a949-ee871ad37988"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: chronicle."}}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":37552,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`,
].join("\n");

describe("parseCodexOneShotJsonl", () => {
  test("the last agent message is the answer, turn.completed the usage", () => {
    expect(parseCodexOneShotJsonl(CAPTURE)).toEqual({
      content: "ok",
      // Codex counts the cached tokens inside `input_tokens`: the prompt total.
      usage: { promptTokens: 37_552, completionTokens: 5, cacheReadTokens: 6_912, cacheCreationTokens: 0 },
    });
  });

  test("the cache write is read too (`cache_write_input_tokens`)", () => {
    const out = parseCodexOneShotJsonl(CAPTURE.replace(`"cache_write_input_tokens":0`, `"cache_write_input_tokens":2048`));
    expect(out.usage?.cacheCreationTokens).toBe(2_048);
  });

  test("a failed turn says why", () => {
    const out = parseCodexOneShotJsonl([
      `{"type":"turn.started"}`,
      `{"type":"turn.failed","error":{"message":"stream disconnected"}}`,
    ].join("\n"));
    expect(out.error).toBe("stream disconnected");
    expect(out.usage).toBeUndefined();
  });

  test("a CLI that prints plain text keeps working, without a usage", () => {
    expect(parseCodexOneShotJsonl("Titolo della card\n")).toEqual({ content: "Titolo della card" });
  });
});
