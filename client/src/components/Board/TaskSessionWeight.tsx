import { useTaskContext } from '../../hooks/useTaskContext';
import { SessionWeight } from './SessionWeight';
import type { SessionWeightInput } from '../../../../shared/task-countdown';

/** The weight block of a card, with the exact context of its assigned topic's session filled in when the provider has measured one. */
export function TaskSessionWeight({ assignedTopicId, ...rest }: Omit<SessionWeightInput, 'usedTokens' | 'windowTokens' | 'estimated'> & { assignedTopicId: string | null | undefined; locale?: string }) {
  const m = useTaskContext(assignedTopicId);
  return <SessionWeight {...rest} usedTokens={m?.usedTokens ?? null} windowTokens={m?.windowTokens ?? null} estimated={m?.estimated} />;
}
