import { isCiEvidenceCheck, type ReviewCheck } from "../../shared/board";
import { CLI_AGENT_PEAK_GB, NATIVE_NO_LOCAL_CHECK_RESERVATION_GB } from "./dispatch-capacity";

export const NO_LOCAL_CHECK_EMERGENCY_FLOOR_GB = 2;

export function reservationForRuntime(isCliRuntime: boolean): number {
  return isCliRuntime ? CLI_AGENT_PEAK_GB : NATIVE_NO_LOCAL_CHECK_RESERVATION_GB;
}

export function boardHasNoLocalChecks(checks: readonly ReviewCheck[]): boolean {
  return checks.every(isCiEvidenceCheck);
}

export function canStartNoCheckExemption(input: {
  boardHasNoLocalChecks: boolean;
  heldGB: number | null;
  reservationGB: number;
}): boolean {
  const { heldGB, reservationGB } = input;
  return input.boardHasNoLocalChecks
    && heldGB !== null
    && Number.isFinite(heldGB)
    && Number.isFinite(reservationGB)
    && reservationGB > 0
    && heldGB >= NO_LOCAL_CHECK_EMERGENCY_FLOOR_GB
    && heldGB - reservationGB >= NO_LOCAL_CHECK_EMERGENCY_FLOOR_GB;
}

export class NoCheckExemptionLedger {
  private readonly reservations = new Map<string, number>();

  hasAny(): boolean {
    return this.reservations.size > 0;
  }

  reservationGB(): number {
    return [...this.reservations.values()].reduce((sum, value) => sum + value, 0);
  }

  reserve(taskId: string, reservationGB: number): boolean {
    if (this.hasAny()) return false;
    this.reservations.set(taskId, reservationGB);
    return true;
  }

  restore(taskId: string, reservationGB: number): boolean {
    return this.reserve(taskId, reservationGB);
  }

  release(taskId: string): boolean {
    return this.reservations.delete(taskId);
  }

  has(taskId: string): boolean {
    return this.reservations.has(taskId);
  }

  get(taskId: string): number | null {
    return this.reservations.get(taskId) ?? null;
  }

  untrackedCount(trackedTaskIds: ReadonlySet<string>): number {
    return [...this.reservations.keys()].filter((taskId) => !trackedTaskIds.has(taskId)).length;
  }
}
