import { useState, useEffect } from 'react';
import { useAgents } from '../../hooks/useAgents';
import { AgentRoster } from './AgentRoster';
import { SessionHistory } from './SessionHistory';

interface AgentsPaneProps {
  onNavigateToTopic?: (topicId: string) => void;
  onOpenSessionViewer?: (sessionKey: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

const TABS = [
  { id: 'sessions' as const, label: 'Sessions' },
  { id: 'roster' as const, label: 'Roster' },
] as const;

type TabId = typeof TABS[number]['id'];

export function AgentsPane({ onNavigateToTopic, onOpenSessionViewer, onMessage }: AgentsPaneProps) {
  const [tab, setTab] = useState<TabId>('sessions');

  const { sessions: liveSessions, setVisible } = useAgents({
    enabled: true,
    onMessage,
  });

  useEffect(() => {
    setVisible(tab === 'sessions');
  }, [tab, setVisible]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 pt-1.5 pb-1 border-b border-app-border/40">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-[11px] px-3 py-1 rounded transition-colors ${
              tab === t.id
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'sessions' && (
          <SessionHistory
            liveSessions={liveSessions}
            onNavigateToTopic={onNavigateToTopic}
            onOpenSessionViewer={onOpenSessionViewer}
          />
        )}
        {tab === 'roster' && (
          <div className="h-full overflow-y-auto">
            <AgentRoster />
          </div>
        )}
      </div>
    </div>
  );
}
