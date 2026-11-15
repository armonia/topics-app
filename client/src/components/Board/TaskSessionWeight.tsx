import { useTaskContext } from '../../hooks/useTaskContext';
import { useChildrenOf } from '../../state/childWork';
import { foldChildren, ownOfCounter } from '../../../../shared/task-countdown';
import { SessionWeight } from './SessionWeight';

/**
 * The weight block of a card: the exact context of its assigned topic's session
 * (when the provider measured one) and the sub-agents it launched, counted in.
 *
 * The card's counters (`agentTokens`, `agentCostCents`) already carry the
 * children, so the own share is the counter minus what the live children
 * spent, and the total printed is the counter again: no token counted twice.
 */
export function TaskSessionWeight({ assignedTopicId, counterTokens, cacheReadTokens, costCents, locale }: {
  assignedTopicId: string | null | undefined;
  counterTokens: number;
  cacheReadTokens: number;
  costCents: number;
  locale?: string;
}) {
  const m = useTaskContext(assignedTopicId);
  const kids = foldChildren(useChildrenOf(assignedTopicId).map((c) => ({ billableTokens: c.weight?.billableTokens ?? 0, costCents: c.weight?.costCents ?? 0 })));
  return (
    <SessionWeight
      usedTokens={m?.usedTokens ?? null} windowTokens={m?.windowTokens ?? null} estimated={m?.estimated}
      billableTokens={ownOfCounter(counterTokens, kids.billableTokens)} cacheReadTokens={cacheReadTokens}
      costCents={ownOfCounter(costCents, kids.costCents)}
      subAgents={kids.count > 0 ? kids : undefined} locale={locale}
    />
  );
}
