import { capMode, type AdmissionVerdict, type DispatchAdmission, type GlobalDispatchCap } from "../../shared/board";
import type { ResourceFloorVerdict } from "./dispatch-capacity";

export function buildDispatchAdmissionPreview(deps: {
  drainBlock(): string | null;
  floorVerdict(): ResourceFloorVerdict | null;
  globalCap(): GlobalDispatchCap;
  budgetVerdict(cap: GlobalDispatchCap): {
    verdict: AdmissionVerdict;
    mem: { ourMemGB: number; usableMemGB: number };
  } | null;
  memoryClause(
    verdict: Pick<AdmissionVerdict, "blockedBy" | "costMemGB" | "freeQuotaMemGB">,
    mem: { ourMemGB: number; usableMemGB: number },
  ): "quota" | "footprint" | null;
}): DispatchAdmission | null {
  try {
    const held = (blockedBy: "floor" | "drain", reason: string): DispatchAdmission =>
      ({ admit: false, blockedBy, firstAgentExempt: false, costCoreUnits: 0, reason });
    const drain = deps.drainBlock();
    if (drain) return held("drain", drain);
    const floor = (() => { try { return deps.floorVerdict(); } catch { return null; } })();
    if (floor?.reason) return held("floor", floor.reason);
    const exempt = floor?.memoryFirstCardExempt ?? false;
    const exemptPass: DispatchAdmission | null = exempt
      ? { admit: true, blockedBy: null, firstAgentExempt: true, costCoreUnits: 0 }
      : null;
    const cap = deps.globalCap();
    if (capMode(cap) !== "resources") return exemptPass;
    const computed = deps.budgetVerdict(cap);
    if (!computed) return exemptPass;
    const { verdict, mem } = computed;
    return {
      admit: verdict.admit,
      blockedBy: verdict.blockedBy,
      firstAgentExempt: verdict.firstAgentExempt || exempt,
      costCoreUnits: verdict.costCoreUnits,
      usedCoreUnits: verdict.usedCoreUnits,
      usableCoreUnits: verdict.usableCoreUnits,
      pendingAdmissions: verdict.pendingAdmissions,
      costMemGB: verdict.costMemGB,
      freeQuotaMemGB: verdict.freeQuotaMemGB,
      ourMemGB: mem.ourMemGB,
      usableMemGB: mem.usableMemGB,
      memClause: deps.memoryClause(verdict, mem),
    };
  } catch { return null; }
}
