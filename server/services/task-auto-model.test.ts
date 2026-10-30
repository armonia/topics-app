/** @covers AGPT-01 */
import { expect, test } from "bun:test";
import type { ProvidersSnapshot } from "../../shared/types";
import { automaticTaskModels } from "./task-auto-model";

const CLAUDE_CODE_MODELS = [
  "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]",
  "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]",
  "claude-haiku-5-5", "claude-haiku-4-5", "claude-fable-5-1",
];

const TOPICS_MODELS = [
  "claude-opus-5-5[1m]", "claude-opus-5-5", "claude-opus-5[1m]", "claude-opus-5",
  "claude-sonnet-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5",
  "claude-fable-5-1", "claude-fable-5", "claude-opus-4-8[1m]", "claude-opus-4-8",
  "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5-20251001",
];

const snapshot = {
  defaultProvider: "topics",
  providers: [
    { name: "claude-code", status: "ready", models: CLAUDE_CODE_MODELS },
    { name: "topics", status: "ready", models: TOPICS_MODELS },
  ],
} as unknown as ProvidersSnapshot;

test("automatic Claude candidates include only the newest catalog generation", () => {
  const candidates = automaticTaskModels(snapshot, []);
  const slugs = [...new Set(candidates.map(({ slug }) => slug))].sort();

  expect(slugs).toEqual([
    "claude-fable-5-1",
    "claude-haiku-5-5",
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "claude-sonnet-5-5",
    "claude-sonnet-5-5[1m]",
  ]);
  expect(slugs.some(slug => /-(3|4)-/.test(slug))).toBe(false);
});
