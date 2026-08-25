/**
 * @covers CCLI-10
 */
import { describe, test, expect } from "bun:test";
import { parseCompletionStdout } from "./claude-code";

describe("parseCompletionStdout", () => {
  test("single result object → content + usage", () => {
    const out = parseCompletionStdout(JSON.stringify({
      type: "result", result: "opus ok",
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 },
    }));
    expect(out.content).toBe("opus ok");
    expect(out.usage).toEqual({ promptTokens: 15, completionTokens: 2 });
  });

  test("event ARRAY (ex --verbose): the result event wins — mai il JSON grezzo", () => {
    // Regression: the init event carries a model id ("claude-haiku-4-5");
    // returning raw JSON made the model-picker read 'haiku' out of it.
    const out = parseCompletionStdout(JSON.stringify([
      { type: "system", subtype: "init", cwd: "/Users/x", model: "claude-haiku-4-5" },
      { type: "assistant", message: { content: [{ type: "text", text: "opus ok" }] } },
      { type: "result", result: "opus ok", usage: { input_tokens: 3, output_tokens: 1 } },
    ]));
    expect(out.content).toBe("opus ok");
    expect(out.content.includes("haiku")).toBe(false);
    expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 1 });
  });

  test("json without a result event → EMPTY content (caller fallback), not raw json", () => {
    const out = parseCompletionStdout(JSON.stringify([
      { type: "system", subtype: "init", model: "claude-haiku-4-5" },
    ]));
    expect(out.content).toBe("");
  });

  test("non-json stdout → plain text passthrough", () => {
    expect(parseCompletionStdout("opus ok\n").content).toBe("opus ok");
  });
});
