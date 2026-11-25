/**
 * useSignalsSync — single place that feeds the signals store from every raw
 * input. Mounted once at App level. Keeping all population here means there's
 * one wiring diagram to reason about, and consumers only ever read the facade.
 */
import { useEffect, useRef } from 'react';
import type { Topic, ClaudeSessionState, TerminalSessionInfo, WSMessage } from '../types';
import { signalsActions, derivePhaseTerminals, deriveSessionActivity, deriveSessionLastActivity, type TerminalPhaseLite } from './signals';
import { readStreamingSnapshot, type StreamingRowInput } from './backgroundWork';
import { setRunningServices } from './runningServices';
import type { TopicServices } from '../../../shared/background-work';
import { attentionActions } from './attention';
import { subscribeAllSessionFlags } from './sessionFlags';
import { apiFetch } from '../lib/shell/net';
import { agentActionActions, applyActionFrame, type ActionFrameLite } from './agentActions';

interface Args {
  topics: Record<string, Topic>;
  claudeSessions: ReadonlyMap<string, ClaudeSessionState>;
  /** Authoritative session roster (WS terminal:sessions + REST). Drives busy
   *  reconciliation so loading state self-heals from a single source of truth. */
  terminalSessions: TerminalSessionInfo[];
  isSessionStreaming: (sessionKey: string) => boolean;
  /** Reconcile useChat's local streaming flags against the server registry so a
   *  spinner stuck after a lost stream:end self-heals. Fed the server's
   *  currently-streaming sessionKeys on each /api/topics/streaming poll. */
  reconcileServerStreams: (serverStreamingSessionKeys: Set<string>) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function useSignalsSync({ topics, claudeSessions, terminalSessions, isSessionStreaming, reconcileServerStreams, onWSMessage }: Args) {
  // THE ATTENTION STATE, from its two frames and nothing else
  // (notifications-redesign). Every "needs you", "finished" and "in
  // background" mark of every surface reads the store these feed: the Claude
  // phase, the poll below, `stream:end` and the unread frames are not sources
  // of attention any more. `attention:init` replaces the store at every open
  // of the socket, so a reconnect re-syncs whatever was missed.
  useEffect(() => onWSMessage((msg) => {
    attentionActions.applyFrame(msg);
  }), [onWSMessage]);

  // "What is each session doing" → the activity map (keyed by topicId/terminalId).
  // Drives the SessionActivity label on sidebar rows + the mobile activity view.
  // The same derivation feeds the ACTION of each Claude Code terminal (the
  // loader's movement), through the dwell rule of `agentActions`. Chats are fed
  // by their stream frames below, which are finer than the hook phase.
  const fedTerminals = useRef(new Set<string>());
  useEffect(() => {
    const activity = deriveSessionActivity(topics, terminalSessions, claudeSessions);
    signalsActions.setSessionActivity(activity);
    const fed = new Set<string>();
    for (const ts of terminalSessions) {
      const a = activity.get(ts.id);
      if (!a?.action) continue;
      agentActionActions.note(ts.id, a.action);
      fed.add(ts.id);
    }
    for (const id of fedTerminals.current) if (!fed.has(id)) agentActionActions.clear(id);
    fedTerminals.current = fed;
  }, [topics, terminalSessions, claudeSessions]);

  // The action of each chat, by topic (the key of `useTopicLoading`), from ONE
  // source: the server's global `stream:action` frame. The finer stream frames
  // (tool_call, content_chunk...) are of class `topic` and reach only the
  // windows holding that chat, so the board, the sidebar, the folders and the
  // tray never saw them; the server classifies them once and tells every window
  // when a turn's action changes. `stream:end` (global too) clears it.
  // Subscribed to the raw socket, not to the chat's own handler: that one skips
  // the frames of a turn this window streams over its own SSE.
  const topicBySession = useRef(new Map<string, string>());
  useEffect(() => {
    const m = new Map<string, string>();
    for (const t of Object.values(topics)) if (t.sessionKey) m.set(t.sessionKey, t.id);
    topicBySession.current = m;
  }, [topics]);
  useEffect(() => onWSMessage((msg) => {
    applyActionFrame(msg as WSMessage & ActionFrameLite, (key) => topicBySession.current.get(key));
  }), [onWSMessage]);

  // "When did each session last actually do something" → unfiltered twin of
  // the activity map above (includes idle/finished sessions). Drives sidebar
  // ORDERING for claude-code terminals — see deriveSessionLastActivity.
  useEffect(() => {
    signalsActions.setSessionLastActivity(deriveSessionLastActivity(topics, terminalSessions, claudeSessions));
  }, [topics, terminalSessions, claudeSessions]);

  // Live chat streams (useChat) → by topic. Subscribed to the flag store from
  // here, not read in a render: this hook runs inside `App`, and a turn
  // starting in a background chat must not re-render `App` to reach the
  // sidebar row (`state/sessionFlags.ts`).
  useEffect(() => {
    const publish = () => {
      const ids = new Set<string>();
      for (const t of Object.values(topics)) {
        if (t.sessionKey && isSessionStreaming(t.sessionKey)) ids.add(t.id);
      }
      signalsActions.setLiveStreamTopics(ids);
    };
    publish();
    return subscribeAllSessionFlags(publish);
  }, [topics, isSessionStreaming]);

  // Hydrated "mid-reply" baseline — covers sessions already streaming at load
  // (the live WS stream only drives the foreground session, so a background
  // topic that was mid-reply when the page reloaded needs this to show its
  // spinner). Server reads its authoritative in-memory activeStreams registry.
  // Refetched on stream lifecycle + a slow interval.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await apiFetch('/api/topics/streaming');
        if (!res.ok) return;
        const body = (await res.json()) as { sessions?: StreamingRowInput[]; services?: TopicServices[] };
        if (cancelled) return;
        // Work a closed turn left running is not a turn: the reading rule keeps
        // it out of the streaming sets (and of the self-heal), in a state of its
        // own that the composer's Stop and the background glyphs read.
        const snap = readStreamingSnapshot(body.sessions ?? []);
        signalsActions.setHydratedStreamTopics(snap.streamingTopics);
        // The detail of the background work (a command's process, the last
        // news), for the line under the transcript only. Whether there IS work
        // is the attention state's (`attentionOf(...).background`).
        signalsActions.setBackgroundDetail(snap.backgroundTopics);
        // A chat's servers are not work it waits for: a store of their own (BGVIS-08).
        setRunningServices(body.services);
        // Self-heal: this server snapshot is authoritative, so any chat we still
        // show as streaming but the server doesn't is an orphaned flag (lost
        // stream:end). reconcileServerStreams clears it after ≥2 such polls.
        reconcileServerStreams(snap.streamingSessions);
      } catch { /* live WS still drives in-session transitions */ }
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; refresh(); }, 400);
    };
    // A task listed or gone, a Monitor armed mid-turn, a turn opened or
    // closed: the hydrated set and the line's detail follow now, not at the
    // next 15 s poll (BGVIS-06).
    const unsub = onWSMessage((msg) => {
      if (msg.type === 'background:changed' || msg.type === 'stream:start' || msg.type === 'stream:end') schedule();
    });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [onWSMessage, reconcileServerStreams]);

  // Server-tracked pty activity → terminal busy (loading). The "finished" of
  // a terminal is the attention state's now (`terminal:activity` finished is
  // an input of it on the server, for the terminals without hooks).
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type !== 'terminal:activity') return;
      signalsActions.setTerminalBusy(msg.id, msg.busy);
    });
  }, [onWSMessage]);

  // Phase-driven loading for claude-code terminals. The phase is authoritative
  // when known: an active phase (running/tool-running/watching) drives the spinner/ring, while
  // a resting phase (awaiting-user/paused/completed/…) SUPPRESSES the pty
  // heuristic. `starting` is NOT resting — a session can work while pinned there
  // (hooks never advanced it), so pty drives it; this is the fix for "sessions
  // loading but no spinner in the tabs". pty also drives shells and sessions
  // with no phase yet — see terminalLoadingFrom / RESTING_CLAUDE_PHASES.
  useEffect(() => {
    const byCsid = new Map<string, TerminalPhaseLite>();
    for (const st of claudeSessions.values()) byCsid.set(st.claudeSessionId, { phase: st.phase });
    const { active, resting } = derivePhaseTerminals(terminalSessions, byCsid);
    signalsActions.setClaudePhaseTerminals(active, resting);
  }, [terminalSessions, claudeSessions]);

  // Reconcile busy against the authoritative session roster. The
  // live deltas above are best-effort and can be lost (server hot-reload wipes
  // the in-memory activity map, WS reconnect, dropped message), which used to
  // leave a finished session spinning forever. The roster carries a fresh busy
  // snapshot on every broadcast + REST refetch (mount / reconnect), so syncing
  // from it makes loading state self-correcting.
  useEffect(() => {
    signalsActions.reconcileTerminals(terminalSessions);
  }, [terminalSessions]);
}
