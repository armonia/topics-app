import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useAgents } from '../../hooks/useAgents';
import { AgentCard } from './AgentCard';

interface AgentPanelProps {
  enabled?: boolean;
  onNavigateToTopic?: (topicId: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function AgentPanel({ enabled = true, onNavigateToTopic, onMessage }: AgentPanelProps) {
  const {
    sessions,
    loading,
    error,
    refresh,
    setVisible,
  } = useAgents({ enabled, onMessage });

  useEffect(() => {
    setVisible(enabled);
  }, [enabled, setVisible]);

  return (
    <div className="px-2 pb-2">
      {error && (
        <div className="px-2 py-1 text-[11px] text-red-500">{error}</div>
      )}

      {sessions.length > 0 ? (
        <div className="space-y-0.5">
          {sessions.map(session => (
            <AgentCard
              key={session.key}
              session={session}
              onNavigateToTopic={onNavigateToTopic}
            />
          ))}
        </div>
      ) : !loading ? (
        <div className="px-2 py-3 text-center text-[11px] text-app-text-tertiary">
          No active agents
        </div>
      ) : null}

      <button
        onClick={refresh}
        disabled={loading}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mt-1 text-[11px] text-app-text-tertiary hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        Refresh
      </button>
    </div>
  );
}
