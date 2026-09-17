/**
 * The number the context assembler budgets against, for a model the static
 * table has never heard of.
 *
 * The bug this pins: `qwen38-27b-200k` is not in the table, so it fell on
 * DEFAULT_CONTEXT_WINDOW = 1M and the budget bar read ~18% when it was ~90%.
 *
 * @covers MP-DIRECT-03
 */
import { afterEach, describe, expect, test } from "bun:test";
import { contextWindowFor } from "./context-window";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/context-thresholds";
import {
  declaredWindowForModel,
  publishDeclaredWindows,
  resetDeclaredWindows,
} from "./declared-windows";

afterEach(() => { resetDeclaredWindows(); });

describe("a window the provider declared", () => {
  test("wins over the default the table falls back on", () => {
    // Before anybody declares anything: the 1M default, and it says so.
    const guessed = contextWindowFor("qwen38-27b-200k");
    expect(guessed.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(guessed.known).toBe(false);

    publishDeclaredWindows("direct-local", { "qwen38-27b-200k": 200192 });

    const declared = contextWindowFor("qwen38-27b-200k");
    expect(declared.tokens).toBe(200192);
    // `known` is what stops the UI prefixing the number with a tilde.
    expect(declared.known).toBe(true);
  });

  test("an explicit argument still beats the registry", () => {
    publishDeclaredWindows("direct-local", { "qwen38-27b-200k": 200192 });
    expect(contextWindowFor("qwen38-27b-200k", 32768).tokens).toBe(32768);
  });

  test("is matched regardless of the case the name is written in", () => {
    publishDeclaredWindows("direct-local", { "Qwen38-27B-200K": 200192 });
    expect(declaredWindowForModel("qwen38-27b-200k")).toBe(200192);
  });

  test("does not outlive the endpoint that declared it", () => {
    publishDeclaredWindows("direct-local", { "qwen38-27b-200k": 200192 });
    publishDeclaredWindows("direct-local", null);

    expect(declaredWindowForModel("qwen38-27b-200k")).toBeUndefined();
    expect(contextWindowFor("qwen38-27b-200k").tokens).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("a model the endpoint stops offering stops answering", () => {
    publishDeclaredWindows("direct-local", { "one": 1000, "two": 2000 });
    publishDeclaredWindows("direct-local", { "one": 1000 });

    expect(declaredWindowForModel("one")).toBe(1000);
    expect(declaredWindowForModel("two")).toBeUndefined();
  });

  test("one endpoint going away leaves the others alone", () => {
    publishDeclaredWindows("direct-a", { "model-a": 1000 });
    publishDeclaredWindows("direct-b", { "model-b": 2000 });
    publishDeclaredWindows("direct-a", null);

    expect(declaredWindowForModel("model-a")).toBeUndefined();
    expect(declaredWindowForModel("model-b")).toBe(2000);
  });

  test("a nonsense window is ignored rather than believed", () => {
    publishDeclaredWindows("direct-local", { "zero": 0, "negative": -5, "nan": Number.NaN });

    expect(declaredWindowForModel("zero")).toBeUndefined();
    expect(declaredWindowForModel("negative")).toBeUndefined();
    expect(declaredWindowForModel("nan")).toBeUndefined();
  });

  test("a model nobody declared is left to the table", () => {
    publishDeclaredWindows("direct-local", { "qwen38-27b-200k": 200192 });
    // Opus is in the table; the registry must not shadow it.
    expect(contextWindowFor("claude-opus-4-20250514").known).toBe(true);
    expect(declaredWindowForModel("claude-opus-4-20250514")).toBeUndefined();
  });
});
