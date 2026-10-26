/**
 * @covers CHAT-DEF-03, MSEL-09
 *
 * The static list the API-key Claude provider offers when it has no key (or
 * the live /v1/models call fails).
 */
import { describe, expect, it } from "bun:test";
import { ClaudeProvider } from "./claude";

describe("ClaudeProvider KNOWN_MODELS (no key: the static list)", () => {
  it("offers only current Claude generations", async () => {
    const models = await new ClaudeProvider({} as unknown as ConstructorParameters<typeof ClaudeProvider>[0]).listModels();
    expect(models).toContain("claude-haiku-5-5");
    expect(models).toContain("claude-sonnet-5-5");
    expect(models).toContain("claude-opus-5-5");
    expect(models).toContain("claude-fable-5-1");
    expect(models.some((model) => /-(3|4)-/.test(model))).toBe(false);
  });
});
