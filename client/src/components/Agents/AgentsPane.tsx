import { AgentPanel } from './AgentPanel';

interface AgentsPaneProps {
  onNavigateToTopic?: (topicId: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function AgentsPane({ onNavigateToTopic, onMessage }: AgentsPaneProps) {
  return <AgentPanel enabled onNavigateToTopic={onNavigateToTopic} onMessage={onMessage} />;
}
