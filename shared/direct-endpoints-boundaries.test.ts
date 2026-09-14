/**
 * The two places a configured endpoint must NOT get to, and the one number it
 * must get right.
 *
 * MP-TASK-01 keeps chat connections out of the task pickers, and a configured
 * endpoint is a chat connection: one round trip, no file or bash tool, no
 * update_task. A card handed to one would never close. The rule is already
 * written as `capabilities.includes('coding-tasks')`, which a direct endpoint
 * does not declare, so this file exists to make that a failing test the day
 * somebody adds the capability by hand.
 *
 * @covers MP-DIRECT-04
 * @covers MP-DIRECT-05
 */
import { describe, expect, test } from "bun:test";
import { contextWindowFor } from "./context-window";
import { availableTaskModels, taskExecutionOptions } from "./task-coding-models";
import { isDirectProviderName, providerNameForEndpoint } from "./direct-endpoints";
import type { ProvidersSnapshot } from "./types";

type Entry = ProvidersSnapshot["providers"][number];

function entry(overrides: Partial<Entry>): Entry {
  return {
    name: "direct-local-llama",
    label: "Local llama",
    status: "ready",
    models: ["qwen38-27b-200k", "claude-sonnet-4"],
    requirements: [],
    capabilities: ["streaming", "history"],
    fetchedAt: new Date().toISOString(),
    ...overrides,
  } as Entry;
}

const snapshot = (entries: Entry[]): ProvidersSnapshot => ({ providers: entries } as ProvidersSnapshot);

describe("a configured endpoint stays out of the task pickers", () => {
  test("it is not offered as a task runtime", () => {
    const options = taskExecutionOptions(snapshot([entry({})]));
    expect(options).toEqual([]);
  });

  test("its models are not offered as task models, not even the claude-looking one", () => {
    // The name alone is not a permission: a local endpoint can serve a model
    // called `claude-sonnet-4` and it still cannot run a card.
    expect(availableTaskModels(snapshot([entry({})]))).toEqual([]);
  });

  test("a real coding runtime in the same snapshot is still offered", () => {
    const options = taskExecutionOptions(snapshot([
      entry({}),
      entry({
        name: "claude",
        label: "Claude Code",
        models: ["claude-sonnet-4"],
        capabilities: ["streaming", "history", "coding-tasks"],
      }),
    ]));
    expect(options.map((option) => option.name)).toEqual(["claude"]);
  });
});

describe("the provider name of an endpoint", () => {
  test("it is recognisable as direct and carries no colon", () => {
    const name = providerNameForEndpoint({ id: "local-llama" });
    expect(name).toBe("direct-local-llama");
    expect(name).not.toContain(":");
    expect(isDirectProviderName(name)).toBe(true);
    expect(isDirectProviderName("openai")).toBe(false);
  });
});

describe("the window shown for a model of a configured endpoint", () => {
  test("a declared window wins over the table of known models", () => {
    expect(contextWindowFor("qwen38-27b-200k", 200_192)).toEqual({ tokens: 200_192, known: true });
  });

  test("without a declared window an unknown model is a guess, not a measurement", () => {
    const guessed = contextWindowFor("qwen38-27b-200k");
    expect(guessed.known).toBe(false);
  });

  test("a nonsense declared window is ignored rather than displayed", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextWindowFor("qwen38-27b-200k", bad).known).toBe(false);
    }
  });

  test("a declared window does not disturb a model the table does know", () => {
    expect(contextWindowFor("claude-sonnet-4").known).toBe(true);
  });
});
