/**
 * useSignalsSync — single place that feeds the signals store from every raw
 * input. Mounted once at App level. Keeping all population here means there's
 * one wiring diagram to reason about, and consumers only ever read the facade.
 */
import { useEffect } from 'react';
import type { Topic, ClaudeSessionState, WSMessage } from '../types';
import type { AgentSession } from '../hooks/useAgents';
import { signalsActions } from './signals';
import { NOTABLE_CLAUDE_PHASES } from './signals';

interface Args {
  topics: Record<string, Topic>;
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>;
  activeAgentSessions: AgentSession[];
  isSessionStreaming: (sessionKey: string) => boolean;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function useSignalsSync({ topics, claudeSessions, activeAgentSessions, isSessionStreaming, onWSMessage }: Args) {
  // Agent sessions active → by topic.
  useEffect(() => {
    const ids = new Set<string>();
    for (const s of activeAgentSessions) if (s.topicId) ids.add(s.topicId);
    signalsActions.setAgentActiveTopics(ids);
  }, [activeAgentSessions]);

  // Claude "needs you" phases → attention by topic.
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of Object.values(topics)) {
      const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
      if (st && NOTABLE_CLAUDE_PHASES.has(st.phase)) ids.add(t.id);
    }
    signalsActions.setClaudeAttentionTopics(ids);
  }, [topics, claudeSessions]);

  // Live chat streams (useChat) → by topic.
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of Object.values(topics)) {
      if (t.sessionKey && isSessionStreaming(t.sessionKey)) ids.add(t.id);
    }
    signalsActions.setLiveStreamTopics(ids);
  }, [topics, isSessionStreaming]);

  // Hydrated "mid-reply" baseline (DB partial flag) — covers sessions already
  // streaming at load. Refetched on stream lifecycle + a slow interval.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch('/api/topics/master/sessions');
        if (!res.ok) return;
        const body = (await res.json()) as { sessions?: { topicId?: string; state?: string }[] };
        if (cancelled) return;
        const ids = new Set<string>();
        for (const s of body.sessions ?? []) if (s.state === 'streaming' && s.topicId) ids.add(s.topicId);
        signalsActions.setHydratedStreamTopics(ids);
      } catch { /* live WS still drives in-session transitions */ }
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    let pending = false;
    const unsub = onWSMessage((msg) => {
      if (msg.type === 'stream:start' || msg.type === 'stream:end') {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; refresh(); }, 400);
      }
    });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [onWSMessage]);

  // Server-tracked pty activity → terminal busy (loading) + claude-code
  // finished (notification). Works for every session, mounted or not.
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type !== 'terminal:activity') return;
      signalsActions.setTerminalBusy(msg.id, msg.busy);
      if (msg.busy) {
        // A new turn started — drop any stale "finished" badge for it.
        signalsActions.clearTerminalFinished(msg.id);
      } else if (msg.finished && (msg.kind === 'claude-code' || msg.kind === 'claude-code-team')) {
        signalsActions.markTerminalFinished(msg.id);
      }
    });
  }, [onWSMessage]);
}
