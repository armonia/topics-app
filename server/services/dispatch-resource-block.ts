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
): (hold: MemoryFloorHold, noCheckReservationGB?: number) => ResourceFloorVerdict {
  return (hold, noCheckReservationGB = 0) =>
    dispatchResourceVerdict(
      deps.worktreesPath(),
      deps.readFreeGB,
      () => {
        const memory = deps.heldMemory();
        return noCheckReservationGB > 0 && memory.heldGB != null
          ? { ...memory, heldGB: Math.max(0, memory.heldGB - noCheckReservationGB) }
          : memory;
      },
      deps.isCliRuntime(),
      hold,
      deps.memoryOwners?.() ?? [],
    );
}
