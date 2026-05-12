// server/providers/fast-models.test.ts
import { describe, test, expect } from "bun:test";
import { getFastModelFor, findFastModelHeuristic, FAST_MODELS } from "./fast-models";

describe("getFastModelFor", () => {
  test("claude-code → claude-haiku-4-5", () => {
    expect(getFastModelFor("claude-code")).toBe("claude-haiku-4-5");
  });

  test("claude → claude-haiku-4-5", () => {
    // Anthropic API accepts the short alias; matches KNOWN_MODELS in claude.ts.
    expect(getFastModelFor("claude")).toBe("claude-haiku-4-5");
  });

  test("codex → gpt-5.4-mini", () => {
    expect(getFastModelFor("codex")).toBe("gpt-5.4-mini");
  });

  test("openai → gpt-4o-mini", () => {
    expect(getFastModelFor("openai")).toBe("gpt-4o-mini");
  });

  test("openclaw → null (delegated to gateway)", () => {
    expect(getFastModelFor("openclaw")).toBeNull();
  });

  test("unknown provider → null", () => {
    expect(getFastModelFor("gemini")).toBeNull();
    expect(getFastModelFor("nonexistent")).toBeNull();
  });

  test("empty string → null", () => {
    expect(getFastModelFor("")).toBeNull();
  });

  test("case-insensitive lookup", () => {
    expect(getFastModelFor("Claude-Code")).toBe("claude-haiku-4-5");
    expect(getFastModelFor("CLAUDE")).toBe("claude-haiku-4-5");
    expect(getFastModelFor("OpenAI")).toBe("gpt-4o-mini");
  });

  test("does not match inherited Object properties", () => {
    // Regression: a provider literally named "toString" or "constructor"
    // would have matched `FAST_MODELS["toString"]` (inherited from Object.prototype)
    // returning the function reference instead of null. Guard against this.
    expect(getFastModelFor("toString")).toBeNull();
    expect(getFastModelFor("constructor")).toBeNull();
    expect(getFastModelFor("hasOwnProperty")).toBeNull();
  });

  test("FAST_MODELS table is exhaustive for known providers", () => {
    // If a new provider is registered (claude/openai/codex/claude-code/openclaw),
    // it MUST have an entry here. This test pins the surface area.
    const knownProviders = ["claude", "claude-code", "codex", "openai", "openclaw"];
    for (const name of knownProviders) {
      expect(name in FAST_MODELS).toBe(true);
    }
  });
});

describe("getFastModelFor — snapshot-aware fallback", () => {
  test("static mapping wins when present in availableModels", () => {
    expect(getFastModelFor("claude-code", ["claude-haiku-4-5", "claude-sonnet-4-6"]))
      .toBe("claude-haiku-4-5");
  });

  test("falls back to heuristic when static mapping missing from snapshot", () => {
    // claude-code maps to "claude-haiku-4-5" but the snapshot only has the
    // dated id. Heuristic finds "haiku" substring.
    expect(getFastModelFor("claude-code", ["claude-haiku-4-5-20251022", "claude-sonnet-4-6"]))
      .toBe("claude-haiku-4-5-20251022");
  });

  test("codex with newer gpt-5.x cache: heuristic picks the mini tier", () => {
    expect(getFastModelFor("codex", ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"]))
      .toBe("gpt-5.4-mini");
  });

  test("no heuristic match → null (caller falls back to provider default)", () => {
    expect(getFastModelFor("claude-code", ["claude-sonnet-4-6", "claude-opus-4-7"]))
      .toBeNull();
  });

  test("empty availableModels → trust static mapping", () => {
    expect(getFastModelFor("openai", [])).toBe("gpt-4o-mini");
  });

  test("openclaw stays null regardless of availableModels", () => {
    expect(getFastModelFor("openclaw", ["any-model"])).toBeNull();
  });
});

describe("findFastModelHeuristic", () => {
  test("haiku takes priority over mini", () => {
    expect(findFastModelHeuristic(["gpt-4o-mini", "claude-haiku-4-5"]))
      .toBe("claude-haiku-4-5");
  });

  test("mini matches when no haiku", () => {
    expect(findFastModelHeuristic(["gpt-5.5", "gpt-5.4-mini"]))
      .toBe("gpt-5.4-mini");
  });

  test("flash matches when neither haiku nor mini", () => {
    expect(findFastModelHeuristic(["gemini-2.0-pro", "gemini-2.0-flash"]))
      .toBe("gemini-2.0-flash");
  });

  test("no match → null", () => {
    expect(findFastModelHeuristic(["gpt-4", "claude-sonnet"])).toBeNull();
  });

  test("empty list → null", () => {
    expect(findFastModelHeuristic([])).toBeNull();
  });

  test("case-insensitive matching", () => {
    expect(findFastModelHeuristic(["Claude-Haiku-4.5"])).toBe("Claude-Haiku-4.5");
  });
});
