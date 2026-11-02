/**
 * The contract an agent card must meet to finish by itself.
 * @covers KANBAN-05
 */
import { test, expect } from "bun:test";
import { missingForAgentCard } from "./agent-card-contract";

const full = { createdBy: "agent:jarvis", description: "x".repeat(50), bar: "bun test", source: "discord", originTopicId: undefined, projectId: "proj" };

test("a complete agent card misses nothing", () => {
  expect(missingForAgentCard(full)).toEqual([]);
});

test("an agent card with no context says what is missing", () => {
  const m = missingForAgentCard({ createdBy: "agent:api", description: "", bar: undefined, source: undefined, originTopicId: undefined, projectId: "_auto" });
  expect(m.length).toBe(5);
});

test("a BARRA line in the description counts as the bar, a chat id as the source", () => {
  expect(missingForAgentCard({ ...full, bar: undefined, description: `${"x".repeat(50)}\nBARRA: bun test` })).toEqual([]);
  expect(missingForAgentCard({ ...full, source: undefined, originTopicId: "t1" })).toEqual([]);
});
