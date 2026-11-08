/**
 * THE SPEND, AND THE TWO CAPS THAT ARE BORN OFF, on the wire.
 *
 * This is the read and the write of `/api/all-boards/settings` for everything
 * that is money. It lives beside `tasks.ts` and not inside it because that file
 * was already at its `check:bloat` ceiling, and this is the piece that comes out
 * whole: four functions that turn a service call into the field names the client
 * knows, and nothing else.
 *
 * THE SPEND TRAVELS WITH THE CAPS, and it is read even when the caps are off.
 * The figure in dollars is the reason the counter exists; the cap line is an
 * extra that shows up only if somebody set one. `agentUnpricedCostTokens24h`
 * says how much of that figure could not be priced, so the total does not
 * pretend to be complete.
 *
 * ZERO CLEARS A CAP, and zero is also the value a fresh install is born with:
 * no suggested value, no default switched on.
 */
import type { TaskService } from "../services/tasks";

/** The two caps, named the way the wire names them. */
export interface SpendCapFields {
  agentCostCapCents: number;
  agentCostCapCents24h: number;
}

/** The caps plus the two cuts of the ledger: what a GET answers. */
export interface SpendSnapshot extends SpendCapFields {
  agentSpendCents24h: number;
  agentSpendCentsTotal: number;
  agentUnpricedCostTokens24h: number;
  agentUnpricedCostTokensTotal: number;
}

/** The caps alone: what the PATCH answer and the broadcast carry. */
export function spendCapFields(svc: TaskService): SpendCapFields {
  const caps = svc.getSpendCaps();
  return { agentCostCapCents: caps.perTaskCents, agentCostCapCents24h: caps.perDayCents };
}

export function spendSnapshot(svc: TaskService): SpendSnapshot {
  const spend = svc.agentSpend();
  return {
    ...spendCapFields(svc),
    agentSpendCents24h: spend.cents24h,
    agentSpendCentsTotal: spend.centsTotal,
    agentUnpricedCostTokens24h: spend.unpricedCostTokens24h,
    agentUnpricedCostTokensTotal: spend.unpricedCostTokensTotal,
  };
}

/** Whether this PATCH body is asking to write a cap at all. */
export function hasSpendCapPatch(body: unknown): boolean {
  const b = body as { agentCostCapCents?: unknown; agentCostCapCents24h?: unknown } | null | undefined;
  return Number.isFinite(b?.agentCostCapCents) || Number.isFinite(b?.agentCostCapCents24h);
}

/**
 * Writes the caps a PERSON asked for, and only those: a field the body does not
 * carry is left alone rather than reset, so writing one cap never clears the
 * other.
 */
export function applySpendCapPatch(svc: TaskService, body: unknown): void {
  const b = body as { agentCostCapCents?: number; agentCostCapCents24h?: number } | null | undefined;
  svc.setSpendCaps({
    perTaskCents: Number.isFinite(b?.agentCostCapCents) ? b!.agentCostCapCents : undefined,
    perDayCents: Number.isFinite(b?.agentCostCapCents24h) ? b!.agentCostCapCents24h : undefined,
  });
}
