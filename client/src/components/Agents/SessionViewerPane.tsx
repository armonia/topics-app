import { useMemo } from 'react';
import { SessionDetail, type UnifiedSession } from './SessionHistory';

interface SessionViewerPaneProps {
  sessionKey: string;
  onNavigateToTopic?: (topicId: string) => void;
}

export function SessionViewerPane({ sessionKey, onNavigateToTopic }: SessionViewerPaneProps) {
  // Build a minimal UnifiedSession from the sessionKey
  const session = useMemo<UnifiedSession>(() => ({
    id: sessionKey,
    sessionKey,
    topicId: null,
    topicName: null,
    agentName: sessionKey,
    agentAvatar: null,
    agentRole: null,
    status: 'active',
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalTokens: 0,
    errorMessage: null,
    taskId: null,
    lastHeartbeat: null,
    isLive: true,
  }), [sessionKey]);

  return (
    <SessionDetail
      session={session}
      onNavigateToTopic={onNavigateToTopic}
    />
  );
}
