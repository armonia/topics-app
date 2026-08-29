/**
 * useSignalsSync — single place that feeds the signals store from every raw
 * input. Mounted once at App level. Keeping all population here means there's
 * one wiring diagram to reason about, and consumers only ever read the facade.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Topic, ClaudeSessionState, TerminalSessionInfo, WSMessage } from '../types';
import { signalsActions, derivePhaseTerminals, deriveSessionActivity, deriveSessionLastActivity, setsEqual, useSignalsStore, type TerminalPhaseLite } from './signals';
import { NOTABLE_CLAUDE_PHASES, deriveAwaitingFeedbackTopics, deriveAwaitingInputTopics } from './signals';

/** Insieme vuoto condiviso: identità stabile, così il primo giro non fa churn. */
const EMPTY_TOPIC_SET: Set<string> = new Set();

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
  // Chat FERME ad aspettare una risposta (ask_user_question a schermo), come le
  // riporta il server nello snapshot degli stream. Fuori dalla chat il turno
  // sospeso si leggeva come uno che macina: stesso pallino, stesso spinner.
  // Confluisce nell'insieme 'input' qui sotto, quello ambra del «tocca a te».
  const [askWaitingTopics, setAskWaitingTopics] = useState(EMPTY_TOPIC_SET);
  // Specchio per i gestori WS: leggono l'insieme corrente senza rilegarsi a
  // ogni cambio (l'effetto della poll si monta una volta sola).
  const askWaitingRef = useRef(askWaitingTopics);
  const setAskWaiting = useCallback((next: Set<string>) => {
    if (setsEqual(next, askWaitingRef.current)) return;
    askWaitingRef.current = next;
    setAskWaitingTopics(next);
  }, []);

  // Claude "needs you" phases → attention by topic.
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of Object.values(topics)) {
      const st = t.sessionKey ? claudeSessions.get(t.sessionKey) : undefined;
      if (st && NOTABLE_CLAUDE_PHASES.has(st.phase)) ids.add(t.id);
    }
    signalsActions.setClaudeAttentionTopics(ids);
  }, [topics, claudeSessions]);

  // Claude "stopped, waiting for YOU" phases → awaiting-feedback fill by topic
  // (the UNION set: amber 'input' + blue 'done'). Subset of the attention set
  // above (drops `error`); kept as its own signal so the fill is decoupled from
  // the badge. Also feed the LOUD 'input' subset (awaiting-approval) so the UI
  // can pick amber vs blue.
  useEffect(() => {
    const awaiting = deriveAwaitingFeedbackTopics(topics, claudeSessions);
    // Due sorgenti, un solo insieme: le fasi del terminale (awaiting-approval) e
    // le chat sospese su una domanda. Per chi guarda la sidebar è la stessa cosa
    // (la palla è sua) quindi è giusto che sia lo stesso colore.
    const input = deriveAwaitingInputTopics(topics, claudeSessions);
    for (const id of askWaitingTopics) input.add(id);
    // The "seen" flag is cleared on the rising edge of EVERYTHING that wants
    // you, so the union goes in: a chat parked on an in-app ask_user_question
    // is only ever in `input` (its phase stays tool-running), and feeding just
    // `awaiting` left it seen, hence with no amber fill. applyNewAttention
    // keeps its own copy of this union, so the call order no longer matters.
    signalsActions.applyNewAttention(new Set([...awaiting, ...input]));
    signalsActions.setAwaitingFeedbackTopics(awaiting);
    signalsActions.setAwaitingInputTopics(input);
  }, [topics, claudeSessions, askWaitingTopics]);

  // L'aura smorzata per la fase `watching` (Monitor armato) non ha piu' un
  // segnale suo: `watching` e' una fase ATTIVA e passa da
  // `derivePhaseTerminals` (signals.ts, `active`) come running/tool-running.
  // Qui restava un `useEffect` col corpo VUOTO, che a ogni cambio di `topics` o
  // `claudeSessions` faceva girare React per non fare niente.

  // "What is each session doing" → the activity map (keyed by topicId/terminalId).
  // Drives the SessionActivity label on sidebar rows + the mobile activity view.
  useEffect(() => {
    signalsActions.setSessionActivity(deriveSessionActivity(topics, terminalSessions, claudeSessions));
  }, [topics, terminalSessions, claudeSessions]);

  // "When did each session last actually do something" → unfiltered twin of
  // the activity map above (includes idle/finished sessions). Drives sidebar
  // ORDERING for claude-code terminals — see deriveSessionLastActivity.
  useEffect(() => {
    signalsActions.setSessionLastActivity(deriveSessionLastActivity(topics, terminalSessions, claudeSessions));
  }, [topics, terminalSessions, claudeSessions]);

  // Live chat streams (useChat) → by topic.
  useEffect(() => {
    const ids = new Set<string>();
    for (const t of Object.values(topics)) {
      if (t.sessionKey && isSessionStreaming(t.sessionKey)) ids.add(t.id);
    }
    signalsActions.setLiveStreamTopics(ids);
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
        const res = await fetch('/api/topics/streaming');
        if (!res.ok) return;
        const body = (await res.json()) as { sessions?: { topicId?: string; sessionKey?: string; state?: string }[] };
        if (cancelled) return;
        const ids = new Set<string>();
        const sessionKeys = new Set<string>();
        const waiting = new Set<string>();
        for (const s of body.sessions ?? []) {
          // `waiting` è un turno APERTO, non uno finito: va tenuto qui dentro o
          // il self-heal qui sotto spegnerebbe la chat ferma su una domanda.
          // Cambia solo come la si racconta, non se è viva.
          if (s.state !== 'streaming' && s.state !== 'waiting') continue;
          if (s.topicId) ids.add(s.topicId);
          if (s.sessionKey) sessionKeys.add(s.sessionKey);
          if (s.state === 'waiting' && s.topicId) waiting.add(s.topicId);
        }
        signalsActions.setHydratedStreamTopics(ids);
        setAskWaiting(waiting);
        // Self-heal: this server snapshot is authoritative, so any chat we still
        // show as streaming but the server doesn't is an orphaned flag (lost
        // stream:end). reconcileServerStreams clears it after ≥2 such polls.
        reconcileServerStreams(sessionKeys);
      } catch { /* live WS still drives in-session transitions */ }
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    // Domande aperte per topic (topicId → toolCallId). Un topic può averne più
    // di una in volo: si spegne l'attesa quando si chiude l'ULTIMA, non la prima.
    const openAsks = new Map<string, Set<string>>();
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; refresh(); }, 400);
    };
    const unsub = onWSMessage((msg) => {
      if (msg.type === 'stream:start' || msg.type === 'stream:end') {
        // Turno finito ⇒ nessuna domanda può essergli sopravvissuta. Si spegne
        // subito invece di aspettare la poll: 400ms di "ti aspetta" su una chat
        // che ha già chiuso sono 400ms di bugia.
        if (msg.type === 'stream:end' && msg.topicId && openAsks.delete(msg.topicId)) {
          const next = new Set(askWaitingRef.current);
          next.delete(msg.topicId);
          setAskWaiting(next);
        }
        schedule();
        return;
      }
      // La domanda a schermo accende il segnale SUBITO: aspettare la poll
      // vorrebbe dire fino a 15s di sidebar che dice "sta lavorando" mentre in
      // realtà aspetta te. La poll poi conferma (o corregge).
      if (msg.type === 'stream:tool_user_input_required' && msg.topicId) {
        let open = openAsks.get(msg.topicId);
        if (!open) { open = new Set(); openAsks.set(msg.topicId, open); }
        open.add(msg.toolCallId);
        setAskWaiting(new Set(askWaitingRef.current).add(msg.topicId));
        return;
      }
      // …e si spegne allo stesso modo: quando il tool che aspettava si chiude.
      // Si tiene il conto delle domande aperte per topic invece di richiedere la
      // fotografia al server, perché una poll in più qui alimenterebbe il
      // self-heal (due giri "assente" e spegne uno stream vivo) — e comunque il
      // giro dei 15s è già lì a fare da giudice.
      if (msg.type === 'stream:tool_result' && msg.topicId) {
        const open = openAsks.get(msg.topicId);
        if (!open?.delete(msg.toolCallId) || open.size > 0) return;
        openAsks.delete(msg.topicId);
        const next = new Set(askWaitingRef.current);
        next.delete(msg.topicId);
        setAskWaiting(next);
      }
    });
    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [onWSMessage, reconcileServerStreams, setAskWaiting]);

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
        // The server's "finished" is a crude PTY-quiet proxy (1.5s lull) and
        // fires even mid-turn (a sub-agent running quietly, the model thinking).
        // When the authoritative phase is known, trust IT: don't raise a
        // finished badge for a session that is phase-active (running/tool-running)
        // or phase-resting (awaiting-user/paused/completed/…) — those drive
        // attention via the phase path. Only genuinely phase-less sessions
        // (hook-less / stuck-at-starting) fall through to the pty heuristic.
        const sig = useSignalsStore.getState();
        if (!sig.claudePhaseActiveTermIds.has(msg.id) && !sig.claudePhaseRestingTermIds.has(msg.id)) {
          signalsActions.markTerminalFinished(msg.id);
        }
      }
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
    const { active, resting, awaiting, awaitingInput } = derivePhaseTerminals(terminalSessions, byCsid);
    signalsActions.setClaudePhaseTerminals(active, resting, awaiting, awaitingInput);
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
