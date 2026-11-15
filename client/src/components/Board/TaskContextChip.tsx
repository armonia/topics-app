import { useTaskContext } from '../../hooks/useTaskContext';
import { ContextShare } from './ContextShare';

/** The context share of the session behind a card in progress. */
export function TaskContextChip({ assignedTopicId }: { assignedTopicId: string | null | undefined }) {
  return <ContextShare measure={useTaskContext(assignedTopicId)} />;
}
