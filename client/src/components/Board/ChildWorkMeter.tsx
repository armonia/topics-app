import { useChildRow } from '../../state/childWork';
import { WorkMeter } from './WorkMeter';

/**
 * Countdown and weight of the sub-agent with this id (a terminal's id or a
 * chat's topic id), for any list that names sessions: the agents list, the
 * bell. Nothing for a session that is not a sub-agent at work.
 */
export function ChildWorkMeter({ id, className = '' }: { id: string; className?: string }) {
  const child = useChildRow(id);
  if (!child) return null;
  return <WorkMeter startedAt={child.startedAt} estimateMs={child.estimateMs} estimateHistoryMs={child.estimateHistoryMs} weight={child.weight} className={className} />;
}
