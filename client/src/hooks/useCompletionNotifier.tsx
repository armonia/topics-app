import { useRef } from 'react';
import { useToast } from '../components/Shared/Toast';
import type { AppSettings, ClaudeSessionPhase, Topic, WSMessage } from '../types';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';

interface CompletionNotifierProps {
  /** WS subscription registrar from useWebSocket().onMessage. */
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  /** Live AppSettings — reads `notificationsEnabled`, `notificationsSound`,
   *  `notifyEvenWhenFocused` to gate the toast/sound. */
  settings: AppSettings;
  /** Topic map keyed by id (the shape returned by `useTopics`). Used to
   *  resolve a friendly name for the toast body. */
  topics: Record<string, Topic>;
  /** The currently-focused panel id (e.g. `chat:<topicId>`, `agents:…`).
   *  Used to suppress the toast for the topic the user is already looking
   *  at, unless `notifyEvenWhenFocused` is on. */
  focusedPanelId: string | null;
}

/**
 * Internal helper — plays a short, low-volume "ding" via WebAudio.
 *
 * We deliberately avoid bundling an mp3 asset:
 *   - keeps the bundle smaller
 *   - sidesteps autoplay-policy issues (a user gesture has already happened
 *     by the time an agent completes — they typed the prompt — so resuming
 *     a brand new AudioContext is allowed)
 *   - failures are silent (some envs lock AudioContext entirely; we never
 *     throw to the caller)
 */
function playCompletionTone(): void {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    // Two-tone descending blip — short enough to not be annoying.
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(523, ctx.currentTime + 0.18);

    // Quick attack, exponential release. Peak gain stays well below 1 so
    // even users with high system volume get a discreet cue.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    /* never propagate audio errors — they're cosmetic */
  }
}

/** Pull the topic id out of a panel id like `chat:abc-123`. Returns null
 *  for non-chat panels (agents pane, terminal, etc.) since those aren't
 *  bound to a specific topic. */
function topicIdFromPanel(panelId: string | null): string | null {
  if (!panelId) return null;
  // Panel ids are `<kind>:<rest>`. Only the chat kind has a 1:1 mapping
  // to a topic — every other kind shares a workspace.
  const [kind, rest] = panelId.split(':', 2);
  return kind === 'chat' && rest ? rest : null;
}

/**
 * Subscribes to `agents:sessions` and surfaces a toast (+ optional sound)
 * the moment a session flips `active → idle` (or into `error`).
 *
 * The hook is intentionally a no-op when `settings.notificationsEnabled`
 * is false — the master switch lives in Settings → Notifications. It also
 * suppresses the toast for the focused topic unless `notifyEvenWhenFocused`
 * is on, so a user actively watching a topic doesn't get a redundant cue
 * for what they can plainly see in the chat pane.
 *
 * Native Electron desktop notifications are dispatched separately by
 * `electron-app/main.ts` (`agents:sessions` handler). The two paths are
 * complementary: the toast covers the in-window case, the desktop notif
 * covers the "app in the background" case.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its renderless bridge component (CompletionNotifierBridge); idiomatic and the bridge is the sole consumer
export function useCompletionNotifier({
  onWSMessage,
  settings,
  topics,
  focusedPanelId,
}: CompletionNotifierProps): void {
  const { success, warning } = useToast();

  // Per-session previous status, keyed by `session.key`. We diff frames
  // here — the server publishes the full session list on every frame, so
  // detecting an `active → idle` transition is "what changed since last
  // frame" rather than a count delta. Same logic as Electron main.ts.
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  // Refs let us read the latest values inside the WS handler without
  // re-subscribing on every settings change (which would drop in-flight
  // status diffs). useRefMirror is the canonical state→ref bridge.
  const settingsRef = useRefMirror(settings);
  const topicsRef = useRefMirror(topics);
  const focusedRef = useRefMirror(focusedPanelId);

  // Per-topic cooldown (10s) so two completions in quick succession on
  // the same topic don't double-toast. Mirrors the cooldown in
  // electron-app/main.ts so the two layers stay consistent.
  const cooldownRef = useRef<Map<string, number>>(new Map());

  useWSSubscription(onWSMessage, 'agents:sessions', (msg) => {
      const sessions = msg.sessions;

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) {
        // Still update prev statuses so we don't emit a burst when the
        // user re-enables the toggle mid-session.
        const next = new Map<string, string>();
        for (const session of sessions) next.set(session.key, session.status);
        prevStatusRef.current = next;
        return;
      }

      const prev = prevStatusRef.current;
      const next = new Map<string, string>();
      const focusedTopicId = topicIdFromPanel(focusedRef.current);

      for (const session of sessions) {
        const previousStatus = prev.get(session.key);
        const justCompleted = previousStatus === 'active' && session.status === 'idle';
        const justErrored = session.status === 'error' && previousStatus !== 'error';

        if (justCompleted || justErrored) {
          const topicId = session.topicId ?? null;
          const isFocused = topicId !== null && topicId === focusedTopicId;
          const shouldShow = !isFocused || cfg.notifyEvenWhenFocused;

          if (shouldShow && topicId) {
            const now = Date.now();
            const last = cooldownRef.current.get(topicId) ?? 0;
            if (now - last >= 10_000) {
              cooldownRef.current.set(topicId, now);

              const topic = topicsRef.current[topicId];
              const label = topic?.name ?? 'Topic';
              if (justErrored) {
                warning(`${label}: agent error`);
              } else {
                success(`${label}: agent done`);
              }
              if (cfg.notificationsSound) {
                playCompletionTone();
              }
            }
          } else if (shouldShow && !topicId) {
            // Session without a topic id — still surface it, but without
            // cooldown keying since we have nothing to key on.
            if (justErrored) warning('Agent error');
            else success('Agent done');
            if (cfg.notificationsSound) playCompletionTone();
          }
        }

        next.set(session.key, session.status);
      }

      prevStatusRef.current = next;
  });

  // ── Claude Code session-state notifier ─────────────────────────────────
  // Surface a toast on the lifecycle phase transitions the user actually
  // needs to react to. The full set of phases is in client/src/types
  // (ClaudeSessionPhase); we only fire for the three that are *actionable*
  // or *terminal*:
  //   awaiting-user      → Claude finished its turn and is waiting on input
  //   awaiting-approval  → Claude wants permission to run a tool
  //   error              → the session crashed; user must intervene
  //   completed          → success ack so background work surfaces
  // Same gating rules as the agents:sessions handler above (master enable,
  // focused-pane suppression, sound toggle, 10s per-topic cooldown).
  //
  // The phase comes from claude-session-tracker (server/lib). Without this
  // bridge the WS event was being received but ignored on the client.
  const prevPhaseRef = useRef<Map<string, ClaudeSessionPhase>>(new Map());
  useWSSubscription(onWSMessage, 'session:state', (msg) => {
      const state = msg.state;
      if (!state || !msg.sessionKey) return;

      const sessionKey = msg.sessionKey;
      const phase = state.phase;
      const prev = prevPhaseRef.current.get(sessionKey);
      prevPhaseRef.current.set(sessionKey, phase);
      if (prev === phase) return; // no-op repeats

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;

      const isActionable =
        phase === 'awaiting-user' ||
        phase === 'awaiting-approval' ||
        phase === 'error' ||
        phase === 'completed';
      if (!isActionable) return;

      // Resolve the friendly topic name. The session-key convention for
      // Topics chats is `topic:<8-char-id>`; we scan the topics map for the
      // first one whose `sessionKey` matches. Falls back to a generic label.
      let topicId: string | null = null;
      let label = 'Claude';
      for (const t of Object.values(topicsRef.current)) {
        if (t.sessionKey === sessionKey) {
          topicId = t.id;
          label = t.name || 'Claude';
          break;
        }
      }

      const focusedTopicId = topicIdFromPanel(focusedRef.current);
      const isFocused = topicId !== null && topicId === focusedTopicId;
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      // 10s cooldown — keyed by sessionKey so two terminals don't collide.
      const now = Date.now();
      const last = cooldownRef.current.get(sessionKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(sessionKey, now);

      switch (phase) {
        case 'awaiting-user':
          success(`${label}: in attesa di te`);
          break;
        case 'awaiting-approval':
          warning(`${label}: serve un'approvazione`);
          break;
        case 'completed':
          success(`${label}: lavoro completato`);
          break;
        case 'error':
          warning(`${label}: errore — interventi richiesti`);
          break;
      }
      if (cfg.notificationsSound) playCompletionTone();
  });
}

/**
 * Renderless component that wires up `useCompletionNotifier`. Drop it
 * inside `<ToastProvider>` (it depends on the toast context).
 */
export function CompletionNotifierBridge(props: CompletionNotifierProps) {
  useCompletionNotifier(props);
  return null;
}
