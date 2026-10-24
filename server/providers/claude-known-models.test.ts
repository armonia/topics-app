/**
 * The static list the API-key Claude provider offers when it has no key (or
 * the live /v1/models call fails).
 */
import { describe, expect, it } from "bun:test";
import { ClaudeProvider } from "./claude";

describe("ClaudeProvider KNOWN_MODELS (no key: the static list)", () => {
  it("carries Haiku 5.5 and still Haiku 4.5, which the picker folds under the older ones", async () => {
    const models = await new ClaudeProvider({} as unknown as ConstructorParameters<typeof ClaudeProvider>[0]).listModels();
    expect(models).toContain("claude-haiku-5-5");
    expect(models).toContain("claude-haiku-4-5");
  });
});
