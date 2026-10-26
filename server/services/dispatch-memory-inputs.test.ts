/**
 * @covers KANBAN-97
 */
import { describe, expect, test } from "bun:test";
import { createDispatchMemoryInputs, createDispatchResourceBlockFromInputs } from "./dispatch-memory-inputs";
import type { HeldMemory } from "./mem-signal";

describe("createDispatchMemoryInputs", () => {
  test("keeps the held-memory reading live and resolves CLI runtime on each read", () => {
    let runtime = "native";
    let heldGB = 4.7;
    const heldMemory = (): HeldMemory => ({
      measurable: true,
      latestGB: heldGB,
      heldGB,
      coveredMs: 120_000,
    });
    const inputs = createDispatchMemoryInputs({
      heldMemory,
      runtime: () => runtime,
      memoryReading: () => ({ freeGB: heldMemory().latestGB, at: 1234 }),
      memoryHistory: () => [],
      memoryOwners: () => [],
    });

    expect(inputs.heldMemory().heldGB).toBe(4.7);
    expect(inputs.isCliRuntime()).toBe(false);

    heldGB = 6.5;
    runtime = "cli";
    expect(inputs.heldMemory().heldGB).toBe(6.5);
    expect(inputs.isCliRuntime()).toBe(true);
  });

  test("wires the shared live readers into the server memory floor", () => {
    let runtime = "native";
    let heldGB = 4.7;
    const inputs = createDispatchMemoryInputs({
      heldMemory: () => ({ measurable: true, latestGB: heldGB, heldGB, coveredMs: 120_000 }),
      runtime: () => runtime,
      memoryReading: () => ({ freeGB: heldGB, at: 1234 }),
      memoryHistory: () => [],
      memoryOwners: () => [],
    });
    const floor = createDispatchResourceBlockFromInputs({
      worktreesPath: () => "/tmp",
      readFreeGB: () => 500,
      inputs,
    });

    const hold = { cardGB: 4, reservedGB: 0, reservedCards: 0, spendingHere: true, ourWorkRunning: true };
    expect(floor(hold).startGB).toBe(10);
    heldGB = 4.7;
    runtime = "cli";
    expect(floor(hold).startGB).toBe(16);
  });

  test("turns cached process families into readable labels without identifiers", () => {
    const inputs = createDispatchMemoryInputs({
      heldMemory: () => ({ measurable: false, latestGB: null, heldGB: null, coveredMs: 0 }),
      runtime: () => "native",
      memoryReading: () => ({ freeGB: 4.7, at: 1234 }),
      memoryHistory: () => [],
      memoryOwners: () => [
        { name: "Claude", gb: 1.4, procs: 2 },
        { name: "claude-code", gb: 0.8, procs: 1 },
        { name: "openclaw", gb: 0.6, procs: 3 },
      ],
    });

    expect(inputs.memoryConsumers()).toEqual([
      { label: "app Claude", gb: 1.4 },
      { label: "sessione Claude", gb: 0.8 },
      { label: "Jarvis", gb: 0.6 },
    ]);
  });
});
