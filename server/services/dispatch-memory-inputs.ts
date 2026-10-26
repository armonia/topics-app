import type { DispatchMemoryHistoryPoint } from "./dispatch-memory-history";
import type { HeldMemory } from "./mem-signal";
import type { MemoryFamily } from "./memory-owners";
import { createDispatchResourceBlock, type DispatchResourceBlockDeps } from "./dispatch-resource-block";

export interface DispatchMemoryInputs {
  heldMemory(): HeldMemory;
  isCliRuntime(): boolean;
  memoryReading(): { freeGB: number | null; at: number | null };
  memoryHistory(): DispatchMemoryHistoryPoint[];
  memoryConsumers(): Array<{ label: string; gb: number }>;
}

/** Compose the server floor from the same readers exposed to the dispatcher. */
export function createDispatchResourceBlockFromInputs(deps: {
  worktreesPath(): string;
  readFreeGB?: DispatchResourceBlockDeps["readFreeGB"];
  inputs: Pick<DispatchMemoryInputs, "heldMemory" | "isCliRuntime">;
  memoryOwners?(): readonly MemoryFamily[];
}) {
  return createDispatchResourceBlock({
    worktreesPath: deps.worktreesPath,
    readFreeGB: deps.readFreeGB,
    heldMemory: deps.inputs.heldMemory,
    isCliRuntime: deps.inputs.isCliRuntime,
    memoryOwners: deps.memoryOwners,
  });
}

/** Keep dispatcher and resource-floor memory inputs on the same live readers. */
export function createDispatchMemoryInputs(deps: {
  heldMemory: () => HeldMemory;
  runtime: () => string;
  memoryReading: () => { freeGB: number | null; at: number | null };
  memoryHistory: () => DispatchMemoryHistoryPoint[];
  memoryOwners: () => readonly MemoryFamily[];
}): DispatchMemoryInputs {
  return {
    heldMemory: deps.heldMemory,
    isCliRuntime: () => deps.runtime() === "cli",
    memoryReading: deps.memoryReading,
    memoryHistory: deps.memoryHistory,
    memoryConsumers: () => deps.memoryOwners().map(({ name, gb }) => ({
      label: memoryConsumerLabel(name),
      gb,
    })),
  };
}

function memoryConsumerLabel(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "claude") return "app Claude";
  if (normalized === "claude-code" || normalized === "claude code" || normalized === "claude-cli") {
    return "sessione Claude";
  }
  if (normalized.includes("openclaw") || normalized.includes("jarvis")) return "Jarvis";
  return `app ${name.trim()}`;
}
