import { useCallback, useEffect, useRef } from 'react';
import { useToast } from '../components/Shared/Toast';
import type { AppSettings, ClaudeSessionPhase, TerminalSessionInfo, Topic, WSMessage } from '../types';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import { useSignalsStore } from '../state/signals';
import { useProjectFocusStore } from '../state/projectFocus';
import { getProjectPathFromPaneId } from '../state/pane/adapters/paneConfig';

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
  /** Live terminal roster — lets the pty-`finished` notifier resolve a
   *  terminal id → its claudeSessionId (cross-path cooldown dedup) + name. */
  terminalSessions: TerminalSessionInfo[];
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

/**
 * Fire a NATIVE OS notification — the macOS/Windows banner the user sees even
 * when the Topics window is in the background. This is the "notifiche di
 * sistema" layer: the in-app toast only covers the in-window case, and the
 * Electron main process only desktop-notifies chat replies (message:new) +
 * error/approval — terminal Claude Code sessions (which store no message) got
 * no system banner at all. The Web Notification API works in BOTH the Electron
 * renderer (the main window's default session grants it) and a plain browser
 * tab, and is hot-reloadable (no Electron rebuild/restart needed).
 *
 * The toast message is "Label: status"; we split it so the banner gets a real
 * title + body. Never throws — a denied permission or locked-down env just
 * means no banner, and the toast still shows.
 *
 * Returns true iff a banner was actually posted, so the caller can drop the
 * redundant in-app toast (the OS notification already covers the "done" cue).
 */
function emitSystemNotification(message: string): boolean {
  try {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission !== 'granted') return false;
    const sep = message.indexOf(': ');
    const title = sep > 0 ? message.slice(0, sep) : 'Topics';
    const body = sep > 0 ? message.slice(sep + 2) : message;
    // silent: we play our own WebAudio tone when the sound toggle is on, so the
    // OS banner stays quiet to avoid a double chime.
    new Notification(title, { body, silent: true });
    return true;
  } catch {
    /* never propagate notification errors — they're cosmetic */
    return false;
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
  terminalSessions,
}: CompletionNotifierProps): void {
  const { success, warning } = useToast();

  // Prime OS-notification permission once on mount. In the Electron main window
  // the default session already reports 'granted'; in a browser tab this raises
  // the one-time prompt so later completions can surface a system banner.
  useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch { /* ignore — notifications simply won't show */ }
  }, []);

  // Electron desktop? The MAIN process (electron-app/main.ts) is the established
  // owner of native OS banners for the streams it already handles, so the
  // renderer must not duplicate them there — see `fire` / the `osBanner` gate.
  const isElectron = !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

  // Single fan-out for every completion/attention cue: native OS banner (the
  // primary channel, fires even when backgrounded) + in-app toast + optional
  // sound. Keeps the notifier paths below from drifting in how they surface an
  // event.
  //
  // De-dup against the OS banner: a green "done" toast is pure FYI, so when the
  // banner actually fired (granted permission — always the case in the Electron
  // desktop app) we DON'T also pop the in-app toast — the system notification
  // already covers it. The in-app toast remains the FALLBACK for a browser tab
  // with notifications denied. Warnings (approval/error) are actionable, so they
  // always toast in-window too — the redundancy is worth it for the cue you must
  // act on.
  //
  // `osBanner` (default true) lets a caller SUPPRESS the renderer's native
  // banner for a channel the Electron main process already banners — namely
  // agents:sessions, session:state(error/approval), and chat replies via
  // message:new. Without this the Electron desktop build (the primary prod
  // target) fired TWO banners per event: one from main, one from here. When
  // suppressed the renderer still shows the in-app toast (its in-window
  // complement). The pty `terminal:activity` path is genuinely uncovered by
  // main, so it keeps osBanner=true; in a plain browser tab there is no main
  // process, so everything banners (osBanner stays true everywhere).
  const fire = useCallback((level: 'ok' | 'warn', message: string, sound: boolean, osBanner = true) => {
    const banner = osBanner ? emitSystemNotification(message) : false;
    if (level === 'warn') warning(message);
    else if (!banner) success(message);
    if (sound) playCompletionTone();
  }, [success, warning]);

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
  const terminalSessionsRef = useRefMirror(terminalSessions);

  // Per-topic cooldown (10s) so two completions in quick succession on
  // the same topic don't double-toast. Mirrors the cooldown in
  // electron-app/main.ts so the two layers stay consistent.
  const cooldownRef = useRef<Map<string, number>>(new Map());

  useWSSubscription(onWSMessage, 'agents:sessions', (msg) => {
      const sessions = msg.sessions;

      // Bound cooldownRef (shared with the phase notifier below): it's keyed by
      // topic/session and was only ever written, so it grew for the lifetime of
      // this always-mounted hook. The cooldown window is 10s, so evicting
      // entries older than 5 min never drops a live one. This tick (one per
      // agents:sessions broadcast) is a natural place to prune.
      {
        const cutoff = Date.now() - 300_000;
        for (const [k, t] of cooldownRef.current) {
          if (t < cutoff) cooldownRef.current.delete(k);
        }
      }

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
      // First frame after load/reconnect = baseline only (no prior status to
      // diff). The roster watcher re-broadcasts the full list, so a stale
      // `error` row would otherwise toast on load. Mirrors the badge path in
      // useTabNotifications. A later transition into error still requires a
      // KNOWN non-error predecessor.
      const isFirstFrame = prev.size === 0;

      for (const session of sessions) {
        const previousStatus = prev.get(session.key);
        const justCompleted = previousStatus === 'active' && session.status === 'idle';
        const justErrored = previousStatus !== undefined && previousStatus !== 'error' && session.status === 'error';

        if (!isFirstFrame && (justCompleted || justErrored)) {
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
              // osBanner off in Electron — main.ts already banners agents:sessions.
              fire(justErrored ? 'warn' : 'ok', `${label}: ${justErrored ? 'agent error' : 'agent done'}`, cfg.notificationsSound, !isElectron);
            }
          } else if (shouldShow && !topicId) {
            // Session without a topic id — still surface it, but without
            // cooldown keying since we have nothing to key on.
            fire(justErrored ? 'warn' : 'ok', justErrored ? 'Agent error' : 'Agent done', cfg.notificationsSound, !isElectron);
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
      if (!state) return;

      // Two flavours of Claude session reach here:
      //   - WEBCHAT chats: carry `sessionKey` (`topic:<id>`). Their replies are
      //     also surfaced by the Electron main process via `message:new`.
      //   - TERMINAL Claude Code sessions (a pane running `claude`): carry NO
      //     sessionKey, only `state.claudeSessionId`. They store no chat message,
      //     so main.ts NEVER banners their turn completion — that gap is the
      //     "no native notification when Claude replies in a coding session"
      //     bug. We resolve them off the live terminal roster and banner here.
      const sessionKey = msg.sessionKey ?? state.sessionKey ?? null;
      const claudeSessionId = state.claudeSessionId || null;
      const phaseKey = sessionKey || claudeSessionId;
      if (!phaseKey) return;

      const phase = state.phase;
      const prev = prevPhaseRef.current.get(phaseKey);
      if (prev === phase) return; // no-op repeats
      // Record for the next diff, but PRUNE terminal/dormant phases so the map
      // doesn't accumulate one dead entry per session for the lifetime of this
      // always-mounted hook (each terminal session gets a fresh claudeSessionId).
      // Mirrors main.ts CLAUDE_GONE_PHASES + the cooldownRef pruning above.
      if (phase === 'completed' || phase === 'dormant' || phase === 'error') {
        prevPhaseRef.current.delete(phaseKey);
      } else {
        prevPhaseRef.current.set(phaseKey, phase);
      }

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;

      const isActionable =
        phase === 'awaiting-user' ||
        phase === 'awaiting-approval' ||
        phase === 'error' ||
        phase === 'completed';
      if (!isActionable) return;

      // Resolve a friendly label + owning topic. First try a webchat topic whose
      // `sessionKey` matches; otherwise match a terminal session by
      // claudeSessionId (its `name` is the user-renameable tab title).
      let topicId: string | null = null;
      let label = 'Claude';
      let isTerminal = false;
      let terminalId: string | null = null;
      if (sessionKey) {
        for (const t of Object.values(topicsRef.current)) {
          if (t.sessionKey === sessionKey) {
            topicId = t.id;
            label = t.name || 'Claude';
            break;
          }
        }
      }
      if (!topicId && claudeSessionId) {
        const ts = terminalSessionsRef.current.find((t) => t.claudeSessionId === claudeSessionId);
        if (ts) {
          isTerminal = true;
          terminalId = ts.id;
          const tn = ts.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
          label = ts.name || tn || 'Claude Code';
          topicId = ts.topicId ?? null;
        }
      }

      // Focus suppression. A focused CHAT panel id is `chat:<topicId>`; a focused
      // TERMINAL panel id contains the terminal session id (`terminal:<id>`).
      // topicIdFromPanel only resolves chats, so the terminal case needs its own
      // check — without it a Claude Code terminal you're actively watching would
      // still banner+ding every turn, ignoring notifyEvenWhenFocused (matches the
      // pty `terminal:activity` path's own focus check).
      const focusedTopicId = topicIdFromPanel(focusedRef.current);
      const focusedPanel = focusedRef.current;
      // A terminal nested INSIDE a project window keeps the App-level focus on
      // the `project:<path>` pane — its active inner pane is tracked separately
      // in useProjectFocusStore. So also treat the terminal as focused when it
      // is the active inner pane of the currently-focused project (otherwise a
      // Claude Code terminal you're watching inside a project still dings).
      const focusedProjectPath = focusedPanel ? getProjectPathFromPaneId(focusedPanel) : null;
      const projectInnerActive = focusedProjectPath
        ? useProjectFocusStore.getState().activePaneByProject[focusedProjectPath]
        : null;
      const isFocused =
        (topicId !== null && topicId === focusedTopicId) ||
        (isTerminal && !!terminalId && (
          (!!focusedPanel && focusedPanel.includes(terminalId)) ||
          projectInnerActive === `terminal:${terminalId}`
        ));
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      // 10s cooldown. For a TERMINAL, key by claudeSessionId so this collapses
      // with the pty `terminal:activity` fallback (which keys by claudeSessionId)
      // into ONE cue. For a webchat, key by topicId FIRST so it collapses with the
      // agents:sessions completion (which keys by topicId). Both fall back through
      // the remaining identifiers.
      const cooldownKey = isTerminal
        ? (claudeSessionId || topicId || sessionKey!)
        : (topicId || claudeSessionId || sessionKey!);
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(cooldownKey, now);

      // Native-banner ownership (avoid the double banner AUDIT F283 flagged):
      //   - webchat awaiting-user/completed → main.ts banners via message:new.
      //   - error / awaiting-approval (chat OR terminal) → main.ts banners via
      //     its own session:state handler.
      //   - terminal awaiting-user/completed → NOBODY else banners, so the
      //     renderer owns it (osBanner true even in Electron).
      const rendererOwnsBanner = isTerminal && (phase === 'awaiting-user' || phase === 'completed');
      const osBanner = rendererOwnsBanner ? true : !isElectron;
      // Sound de-dup: when main.ts owns the native banner (Electron + osBanner
      // false), it ALSO plays the OS chime (showNotification silent:false). Don't
      // also play the renderer's WebAudio tone there, or one event makes TWO
      // sounds. The renderer keeps the tone only when IT owns the banner (which
      // it posts silent), or in a plain browser tab where there is no main.
      const playSound = cfg.notificationsSound && !(isElectron && !osBanner);
      switch (phase) {
        case 'awaiting-user':
          fire('ok', `${label}: in attesa di te`, playSound, osBanner);
          break;
        case 'awaiting-approval':
          fire('warn', `${label}: serve un'approvazione`, playSound, osBanner);
          break;
        case 'completed':
          fire('ok', `${label}: lavoro completato`, playSound, osBanner);
          break;
        case 'error':
          fire('warn', `${label}: errore — interventi richiesti`, playSound, osBanner);
          break;
      }
  });

  // ── pty-`finished` notifier (the safety net) ───────────────────────────
  // The authoritative completion cue is the `session:state` awaiting-user /
  // completed path above, driven by Claude Code's hooks. This pty path is ONLY
  // a fallback for genuinely hook-less sessions: the server emits a pty-derived
  // `terminal:activity { finished:true, kind:'claude-code' }` after ~1.5s of
  // output silence, which is a CRUDE proxy — a session pauses mid-turn many
  // times (a sub-agent running quietly, the model thinking), and each lull used
  // to fire a false "lavoro completato" (the Japan-with-shells symptom).
  //
  // Guard: trust the phase machine. If it currently classes this session as
  // actively working (running/tool-running), the pty going quiet is a MID-TURN
  // pause — suppress. Only when the phase is NOT active (hook-less session stuck
  // at `starting`, or already resting) do we let the pty signal through. Dedup
  // is keyed by claudeSessionId, the SAME key the phase path uses, so a hooked
  // session that emits BOTH only notifies once.
  useWSSubscription(onWSMessage, 'terminal:activity', (msg) => {
      if (!msg.finished) return;
      if (msg.kind !== 'claude-code' && msg.kind !== 'claude-code-team') return;

      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;

      // Trust the phase machine whenever it has an authoritative opinion on this
      // session — the pty path is ONLY for genuinely hook-less sessions.
      //   - active (running/tool-running): the pty quieting is a mid-turn lull
      //     (sub-agent / thinking), NOT a finished turn — the `Stop` hook drives
      //     the real notification via session:state. Suppress.
      //   - resting (awaiting-user/completed/paused/error/dormant): the turn
      //     already ended and session:state already notified (or it's a plain
      //     idle repaint) — a pty blip here is the "Japan fires a second random
      //     toast" symptom. Suppress.
      // Only a session in NEITHER set (no phase signal at all / stuck at
      // `starting`) falls through to this crude pty fallback.
      const sig = useSignalsStore.getState();
      if (sig.claudePhaseActiveTermIds.has(msg.id) || sig.claudePhaseRestingTermIds.has(msg.id)) return;

      const ts = terminalSessionsRef.current.find((t) => t.id === msg.id);
      // Focus suppression: the focused panel id for a terminal contains its id
      // (`terminal:<id>`); skip the toast if the user is staring at it already.
      const focused = focusedRef.current;
      const isFocused = !!focused && focused.includes(msg.id);
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      // Longer cooldown than the authoritative paths (10s). This pty-silence
      // proxy is the ONLY signal for genuinely hook-less sessions, where a
      // single Claude turn has several >1.5s mid-turn lulls — each used to fire
      // a fresh "lavoro completato" (the random-dings bug). With the phase guard
      // above plus auto-installed Claude Code hooks this path rarely runs at all;
      // when it does, a 30s window caps it to at most one cue per session per
      // 30s instead of one per lull. Shares cooldownRef with the phase path so a
      // session that briefly lacked a phase signal still dedups against it.
      const cooldownKey = ts?.claudeSessionId || `terminal:${msg.id}`;
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 30_000) return;
      cooldownRef.current.set(cooldownKey, now);

      const topicName = ts?.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
      const label = ts?.name || topicName || 'Claude Code';
      fire('ok', `${label}: lavoro completato`, cfg.notificationsSound);
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
