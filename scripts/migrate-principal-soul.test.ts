// @covers AGENTS-PERSONA-01
import { describe, test, expect } from "bun:test";
import { planSoulSplit } from "../server/agents/soul-sections";
import { toPersonaSplit } from "./migrate-principal-soul";

const base = "# Base soul\n\nintro\n\n## Tone\nbe direct\n\n## Act vs ask\nact\n";
const soul = "# Soul\n\nintro\n\n## Tone\nbe direct\n\n## Language\nAlways answer in Italian.\n\n## Permissions\nMay read DMs.\n";

describe("planSoulSplit", () => {
  test("generic sections drop, kept headings stay, the rest are directives", () => {
    const plan = planSoulSplit(soul, base, ["Permissions"]);
    expect(plan.dropped.map((s) => s.heading)).toEqual(["", "tone"]);
    expect(plan.kept.map((s) => s.heading)).toEqual(["permissions"]);
    expect(plan.moved.map((s) => s.heading)).toEqual(["language"]);
    const split = toPersonaSplit(plan);
    expect(split.directives).toContain("Always answer in Italian.");
    expect(split.directives).not.toContain("be direct");
    expect(split.agentAdditions).toContain("May read DMs.");
  });

  test("without --keep nothing stays in the agent's SOUL", () => {
    expect(toPersonaSplit(planSoulSplit(soul, base, [])).agentAdditions).toBe("");
  });
});
