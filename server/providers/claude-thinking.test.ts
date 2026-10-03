/**
 * The thinking payload of the API-key Claude provider, per model id.
 * @covers NATIVE-EFFORT-01
 */
import { describe, expect, it } from "bun:test";
import { ClaudeProvider } from "./claude";

/**
 * Which `thinking` payload the API-key provider sends, model by model.
 *
 * The rule used to be a list of the models that want `adaptive`: every new
 * model that removed `budget_tokens` (Opus 4.8, the whole 5 family) fell
 * through to the legacy branch and got a 400. Now the LEGACY models are the
 * explicit list, and anything newer is adaptive by default.
 */
function thinkingFor(model: string, maxTokens = 16384): unknown {
  const provider = new ClaudeProvider({ apiKey: "sk-ant-fake" } as any) as any;
  const params: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [] };
  provider.applyThinking(params, model, maxTokens);
  return params.thinking;
}

const ADAPTIVE = { type: "adaptive" };
const LEGACY = { type: "enabled", budget_tokens: 8000 };

const TABLE: Array<[string, unknown]> = [
  // Every id the app offers or resolves to today.
  ["claude-sonnet-4-6", ADAPTIVE],
  ["claude-opus-4-8", ADAPTIVE],
  ["claude-opus-4-8[1m]", ADAPTIVE],
  ["claude-opus-4-7", ADAPTIVE],
  ["claude-opus-4-6", ADAPTIVE],
  ["claude-opus-5", ADAPTIVE],
  ["claude-opus-5[1m]", ADAPTIVE],
  ["claude-opus-5-5", ADAPTIVE],
  ["claude-opus-5-5[1m]", ADAPTIVE],
  ["claude-sonnet-5", ADAPTIVE],
  ["claude-sonnet-5-5", ADAPTIVE],
  ["claude-fable-5", ADAPTIVE],
  ["claude-fable-5-1", ADAPTIVE],
  ["claude-fable-5-mythos-5", ADAPTIVE],
  // Future ids nobody has listed yet: adaptive unless explicitly legacy.
  ["claude-sonnet-4-7", ADAPTIVE],
  ["claude-haiku-5", ADAPTIVE],
  ["claude-opus-6-2", ADAPTIVE],
  ["claude-newfamily-1", ADAPTIVE],
  // Legacy: these still take (and the 4.5 Haiku needs) a fixed budget.
  ["claude-haiku-4-5", LEGACY],
  ["claude-haiku-4-5-20251001", LEGACY],
  ["claude-sonnet-4-5", LEGACY],
  ["claude-opus-4-5", LEGACY],
  ["claude-opus-4-1", LEGACY],
  ["claude-sonnet-4-20250514", LEGACY],
  ["claude-opus-4-20250514", LEGACY],
  ["claude-3-7-sonnet-20250219", LEGACY],
  // No extended thinking at all.
  ["claude-3-5-haiku-20241022", undefined],
  ["claude-3-haiku-20240307", undefined],
];

describe("ClaudeProvider thinking payload", () => {
  for (const [model, expected] of TABLE) {
    it(`${model} -> ${JSON.stringify(expected)}`, () => {
      expect(thinkingFor(model)).toEqual(expected);
    });
  }

  it("a legacy budget never reaches max_tokens", () => {
    expect(thinkingFor("claude-sonnet-4-5", 1024)).toBeUndefined();
    expect(thinkingFor("claude-sonnet-4-5", 4096)).toEqual({ type: "enabled", budget_tokens: 2048 });
  });
});
