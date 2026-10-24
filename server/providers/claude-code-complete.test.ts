/**
 * @covers CCLI-10
 * @covers USAGE-24
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider, parseCompletionStdout } from "./claude-code";

describe("parseCompletionStdout", () => {
  test("single result object → content + usage", () => {
    const out = parseCompletionStdout(JSON.stringify({
      type: "result", result: "opus ok",
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 },
    }));
    expect(out.content).toBe("opus ok");
    expect(out.usage).toEqual({
      promptTokens: 15, completionTokens: 2,
      cacheReadTokens: 5, cacheCreationTokens: 0, cacheCreation1hTokens: 0,
    });
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
    expect(out.usage).toMatchObject({ promptTokens: 3, completionTokens: 1 });
  });

  test("the shares, the model and the CLI's own price come back for the side-call ledger", () => {
    // Shape of a real card-title call (9-12/10): almost the whole prompt
    // written to the one-hour cache, the price computed by the CLI.
    const out = parseCompletionStdout(JSON.stringify({
      type: "result", result: "Titolo",
      total_cost_usd: 0.0794,
      modelUsage: { "claude-sonnet-5-5": { inputTokens: 3 } },
      usage: {
        input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 12_810,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 12_810 },
        output_tokens: 21,
      },
    }));
    expect(out.usage).toEqual({
      promptTokens: 12_813, completionTokens: 21,
      cacheReadTokens: 0, cacheCreationTokens: 12_810, cacheCreation1hTokens: 12_810,
      model: "claude-sonnet-5-5", costUsd: 0.0794,
    });
  });

  test("two models in modelUsage: the parse names none, the provider says which one ran", () => {
    // The parse cannot tell which of two models answered; the ledger then asks
    // the provider (`completionModel`), whose one-shots run on their OWN
    // default, not on the chat's (`defaultModel`).
    const out = parseCompletionStdout(JSON.stringify({
      type: "result", result: "ok",
      modelUsage: { "claude-sonnet-5-5": {}, "claude-haiku-4-5": {} },
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    expect(out.usage?.model).toBeUndefined();
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    expect(provider.completionModel()).toBe("claude-sonnet-5-5");
    expect(provider.completionModel({ model: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
    expect(new ClaudeCodeProvider({ type: "claude-code", model: "claude-opus-5-5" }).completionModel()).toBe("claude-opus-5-5");
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
