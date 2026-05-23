/**
 * useSignalsSync — single place that feeds the signals store from every raw
 * input. Mounted once at App level. Keeping all population here means there's
 * one wiring diagram to reason about, and consumers only ever read the facade.
 */
import { useEffect } from 'react';
import type { Topic, ClaudeSessionState, TerminalSessionInfo, WSMessage } from '../types';
import type { AgentSession } from '../hooks/useAgents';
import { signalsActions, derivePhaseTerminals, type TerminalPhaseLite } from './signals';
import { NOTABLE_CLAUDE_PHASES } from './signals';

interface Args {
  topics: Record<string, Topic>;
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>;
  activeAgentSessions: AgentSession[];
  /** Authoritative session roster (WS terminal:sessions + REST). Drives busy
   *  reconciliation so loading state self-heals from a single source of truth. */
  terminalSessions: TerminalSessionInfo[];
  isSessionStreaming: (sessionKey: string) => boolean;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function useSignalsSync({ topics, claudeSessions, activeAgentSessions, terminalSessions, isSessionStreaming, onWSMessage }: Args) {
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

  // Phase-driven loading for claude-code terminals. The phase is authoritative
  // when known: an active phase (running/tool-running) drives the spinner, while
  // a resting phase (starting/awaiting-user/…) SUPPRESSES the pty heuristic so a
  // freshly-opened session's startup paint doesn't flash "loading". pty still
  // drives shells and sessions with no phase yet — see terminalLoadingFrom.
  useEffect(() => {
    const byCsid = new Map<string, TerminalPhaseLite>();
    for (const st of claudeSessions.values()) byCsid.set(st.claudeSessionId, { phase: st.phase });
    const { active, resting } = derivePhaseTerminals(terminalSessions, byCsid);
    signalsActions.setClaudePhaseTerminals(active, resting);
  }, [terminalSessions, claudeSessions]);

  // Reconcile busy/finished against the authoritative session roster. The
  // live deltas above are best-effort and can be lost (server hot-reload wipes
  // the in-memory activity map, WS reconnect, dropped message), which used to
  // leave a finished session spinning forever. The roster carries a fresh busy
  // snapshot on every broadcast + REST refetch (mount / reconnect), so syncing
  // from it makes loading state self-correcting.
  useEffect(() => {
    signalsActions.reconcileTerminals(terminalSessions);
  }, [terminalSessions]);
}
