import { dispatchResourceVerdict, type MemoryFloorHold, type ResourceFloorVerdict } from "./dispatch-capacity";
import type { HeldMemory } from "./mem-signal";
import type { MemoryFamily } from "./memory-owners";

export interface DispatchResourceBlockDeps {
  worktreesPath(): string;
  heldMemory(): HeldMemory;
  isCliRuntime(): boolean;
  readFreeGB?(path: string): number | null;
  memoryOwners?(): readonly MemoryFamily[];
}

export function createDispatchResourceBlock(
  deps: DispatchResourceBlockDeps,
): (hold: MemoryFloorHold) => ResourceFloorVerdict {
  return (hold) =>
    dispatchResourceVerdict(
      deps.worktreesPath(),
      deps.readFreeGB,
      deps.heldMemory,
      deps.isCliRuntime(),
      hold,
      deps.memoryOwners?.() ?? [],
    );
}
