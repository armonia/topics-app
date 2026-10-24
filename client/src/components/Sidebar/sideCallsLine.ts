import type { SideCallUsage } from '@/hooks/useProjectUsage';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The side-call line of the usage panel: "N calls, M not measured, K without a
 * price, J failed, $X". A count shows only when above zero. The dollars are the
 * priced calls alone, so naming the others is what keeps them from reading as
 * free.
 */
export function sideCallsLine(c: SideCallUsage, cost: string, tr: Translate): string {
  const parts = [tr('usage.sideCalls', { n: c.calls })];
  if (c.unmeasured > 0) parts.push(tr('usage.sideCallsUnmeasured', { m: c.unmeasured }));
  if (c.unpriced > 0) parts.push(tr('usage.sideCallsUnpriced', { m: c.unpriced }));
  if (c.failed > 0) parts.push(tr('usage.sideCallsFailed', { m: c.failed }));
  parts.push(cost);
  return parts.join(', ');
}
