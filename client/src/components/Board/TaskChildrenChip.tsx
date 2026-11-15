import { Bot } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useChildrenOf } from '../../state/childWork';
import { foldChildren } from '../../../../shared/task-countdown';
import { fmtTok } from './format';

/** The sub-agents a card's session launched and is waiting on, with what they spent so far; nothing while there are none. */
export function TaskChildrenChip({ assignedTopicId }: { assignedTopicId: string | null | undefined }) {
  const tr = useT();
  const rows = useChildrenOf(assignedTopicId);
  if (rows.length === 0) return null;
  const kids = foldChildren(rows.map((c) => ({ billableTokens: c.weight?.billableTokens ?? 0, costCents: c.weight?.costCents ?? 0 })));
  return (
    <span data-testid="card-children" title={tr('board.card.childrenTitle', { n: kids.count })} className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums text-app-text-secondary">
      <Bot size={11} aria-hidden="true" />{kids.billableTokens > 0 ? tr('board.card.children', { n: kids.count, tok: fmtTok(kids.billableTokens) }) : kids.count}
    </span>
  );
}
