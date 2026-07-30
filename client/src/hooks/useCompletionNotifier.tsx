import { useCallback, useEffect, useRef } from 'react';
import type { AppSettings, ClaudeSessionPhase, TerminalSessionInfo, Topic, WSMessage } from '../types';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import { useSignalsStore } from '../state/signals';
import { notifyNative } from '../lib/shell/app';
import { shellKind } from '../lib/shell';
import { decideTerminalBanner, statusBody, terminalPanelId, isTabActivelyVisible } from '../lib/notify/terminalNotify';
import { isAgentTurnNoise } from '../lib/notify/dispatchedTopic';
import type { TopicTaskResolver } from './useTaskTopicIndex';

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
  /** Resolve a topic id → the dispatched task it works, if any. When a
   *  completion banner is for a dispatched-task topic, the taskId rides into the
   *  notification so a click opens that task's drawer (openTaskInApp) — e il suo
   *  `dispatchState` dice se l'agente sta lavorando ADESSO, che è la condizione
   *  per zittire la fine turno (isAgentTurnNoise). */
  taskForTopic?: TopicTaskResolver;
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

    // Closing exactly once, whatever happens. `onended` is the happy path, but it
    // is NOT guaranteed: if the context never leaves `suspended` (autoplay policy,
    // a machine with no audio device, the window backgrounded at the wrong moment)
    // the oscillator never runs and the callback never fires — and an unclosed
    // AudioContext is not garbage: WebKit keeps a live RemoteAudioDestinationProxy
    // render thread per context, forever. One ding per agent completion means a
    // long session quietly accumulates them. The timer is the backstop; whichever
    // arrives first wins and the other becomes a no-op.
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(fallback); // sempre inizializzato: `close` non parte mai sincrono
      ctx.close().catch(() => {});
    };
    const fallback = setTimeout(close, 1000);
    osc.onended = close;
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
 * Superficie unica: il banner nativo del sistema. La seconda via — il main
 * process di Electron, che bannerizzava per conto suo `agents:sessions` — non
 * esiste piu' (guscio archiviato in v2.0.0), e con lei il parametro che serviva
 * solo a non raddoppiare il banner.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its renderless bridge component (CompletionNotifierBridge); idiomatic and the bridge is the sole consumer
export function useCompletionNotifier({
  onWSMessage,
  settings,
  topics,
  focusedPanelId,
  terminalSessions,
  taskForTopic,
}: CompletionNotifierProps): void {
  // Prime OS-notification permission once on mount. In a browser tab this raises
  // the one-time prompt so later completions can surface a system banner.
  //
  // NOT under Tauri: there the native `notify` command owns delivery AND its own
  // UNUserNotification authorization — the WKWebView web Notification permission
  // is never used for delivery, and (unlike a real browser) its `permission`
  // does NOT persist across launches, so requesting it re-raised the prompt on
  // EVERY app start for nothing. That spurious repeat is the "chiede sempre i
  // permessi" symptom; skip the web prompt entirely in the native shell.
  useEffect(() => {
    if (shellKind === 'tauri') return;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch { /* ignore — notifications simply won't show */ }
  }, []);

  // UNICA via d'uscita per ogni segnale: banner nativo del sistema (l'unica
  // superficie — niente toast in-app, preferenza dell'utente) piu' il suono.
  //
  // Titolo e corpo arrivano SEPARATI. Prima si impacchettava tutto in
  // «Etichetta: stato» e si riseparava sul primo ": " — con un topic chiamato
  // «Fix: login rotto» il banner diventava titolo «Fix», corpo «login rotto:
  // in attesa di te». Il nome del topic tagliato a meta' e lo stato appiccicato
  // dentro il corpo. Il formato non c'e' piu', e con lui quella classe di bug.
  //
  // `silent`: il tono lo suoniamo noi in WebAudio quando l'interruttore del
  // suono e' acceso, cosi' il banner del sistema resta muto e non si sente due
  // volte. `taskId` (quando la topic lavora un task dispatchato) rende il
  // banner cliccabile → apre il drawer di quel task.
  const fire = useCallback((
    _level: 'ok' | 'warn',
    title: string,
    body: string,
    sound: boolean,
    taskId?: string | null,
  ) => {
    notifyNative(title, body, { silent: true, taskId: taskId ?? undefined });
    if (sound) playCompletionTone();
  }, []);

  // Per-session previous status, keyed by `session.key`. We diff frames
  // here — the server publishes the full session list on every frame, so
  // detecting an `active → idle` transition is "what changed since last
  // frame" rather than a count delta.
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  // Refs let us read the latest values inside the WS handler without
  // re-subscribing on every settings change (which would drop in-flight
  // status diffs). useRefMirror is the canonical state→ref bridge.
  const settingsRef = useRefMirror(settings);
  const topicsRef = useRefMirror(topics);
  const focusedRef = useRefMirror(focusedPanelId);
  const terminalSessionsRef = useRefMirror(terminalSessions);
  const taskForTopicRef = useRefMirror(taskForTopic);

  // Per-topic cooldown (10s) so two completions in quick succession on
  // the same topic don't double-banner.
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
          // Actively-visible = this topic's tab selected AND window focused; a
          // backgrounded window must still banner (see isTabActivelyVisible).
          const isFocused = isTabActivelyVisible(
            topicId !== null && topicId === focusedTopicId,
            typeof document !== 'undefined' ? document.hasFocus() : true,
          );
          const shouldShow = !isFocused || cfg.notifyEvenWhenFocused;

          if (shouldShow && topicId) {
            const now = Date.now();
            const last = cooldownRef.current.get(topicId) ?? 0;
            if (now - last >= 10_000) {
              cooldownRef.current.set(topicId, now);

              const topic = topicsRef.current[topicId];
              const label = topic?.name ?? 'Topic';
              // Dispatched-task topic → carry the taskId so a click opens the task.
              const taskId = taskForTopicRef.current?.(topicId)?.taskId ?? null;
              // Il nome della topic resta INTERO nel titolo, comunque sia fatto.
              fire(justErrored ? 'warn' : 'ok', label, justErrored ? 'Errore agente' : 'Agente: lavoro finito', cfg.notificationsSound, taskId);
            }
          } else if (shouldShow && !topicId) {
            // Session without a topic id — still surface it, but without
            // cooldown keying since we have nothing to key on.
            fire(justErrored ? 'warn' : 'ok', 'Topics', justErrored ? 'Errore agente' : 'Agente: lavoro finito', cfg.notificationsSound);
          }
        }

        next.set(session.key, session.status);
      }

      prevStatusRef.current = next;
  });

  // ── End-of-task notifier ───────────────────────────────────────────────
  // A board task entering review is the "the task you asked for is done" cue.
  // Unlike the session-idle inference above, this rides the task's OWN terminal
  // state (server broadcasts `task:review-ready` only on the review edge), so it
  // fires reliably for a clean self-delivery AND the system-delivered review
  // after a timeout — the case that was previously silent. Deliberately NOT
  // focus-gated: a task landing in review is actionable no matter which tab is
  // open; the 10s per-task cooldown is the only spam guard. `taskId` makes the
  // banner clickable → opens that task's drawer.
  useWSSubscription(onWSMessage, 'task:review-ready', (msg) => {
      const cfg = settingsRef.current;
      if (!cfg.notificationsEnabled) return;
      const taskId = msg.taskId;
      if (!taskId) return;
      const key = `task-review:${taskId}`;
      const now = Date.now();
      const last = cooldownRef.current.get(key) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(key, now);
      const title = (msg.taskTitle || 'Task').slice(0, 140);
      fire('ok', 'Task pronto per la review', title, cfg.notificationsSound, taskId);
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
  // Terminal-session phase tracking (sessionKey is null for these — the chat
  // handler below early-returns on them). Keyed by claudeSessionId, which is
  // STABLE across WS reconnect / roster churn (the terminal id can be reused).
  const prevTermPhaseRef = useRef<Map<string, ClaudeSessionPhase>>(new Map());
  // Fired-banner ledger for terminals, keyed by `<terminalId>:<phase>:<rev>`.
  // The dedupe guard so a reconnect bootstrap re-broadcasting the same state
  // (session:state is transition-only, but the bootstrap replays the snapshot)
  // never re-banners an event we already showed. Bounded below on each event.
  const firedTermBannersRef = useRef<Set<string>>(new Set());
  useWSSubscription(onWSMessage, 'session:state', (msg) => {
      const state = msg.state;
      if (!state) return;

      // ── Terminal Claude Code sessions (sessionKey === null) ──────────────
      // These publish state keyed off claudeSessionId; the chat resolution
      // below can't find them (it scans topics by sessionKey). Route them
      // through the terminal notifier so they get the SAME OS-banner semantics
      // as chats: "your turn"/approval/completed/error, with the tab name as
      // title and the approval question as body. All the suppression/dedupe
      // lives in the pure `decideTerminalBanner` + the ledger below.
      if (!msg.sessionKey) {
        const csid = state.claudeSessionId;
        if (!csid) return;
        const cfg = settingsRef.current;
        if (!cfg.notificationsEnabled) {
          // Keep the baseline current so re-enabling mid-session doesn't burst.
          prevTermPhaseRef.current.set(csid, state.phase);
          return;
        }

        // Resolve the roster entry for this claude session → terminal id, name,
        // owning topic. Without a roster row we can't attribute the banner (no
        // id to key focus/dedupe on, no name) — skip; the pty fallback still
        // covers a genuinely hook-less session.
        const ts = terminalSessionsRef.current.find((t) => t.claudeSessionId === csid);
        if (!ts) {
          prevTermPhaseRef.current.set(csid, state.phase);
          return;
        }

        const prevPhase = prevTermPhaseRef.current.get(csid);
        prevTermPhaseRef.current.set(csid, state.phase);

        // Focus suppression: the terminal's panel id is `terminal:<id>`. Only
        // suppress on an EXACT active-panel match (not a loose substring) so an
        // unrelated pane whose id happens to contain this id can't mute it — AND
        // only when the Topics window actually has OS focus. `focusedPanelId` is
        // just "which tab is selected" and never clears when the app goes to the
        // background, so without the hasFocus() gate a backgrounded window whose
        // active tab happened to be this terminal would swallow the very banner
        // the user needs. A backgrounded window is never "actively visible".
        const focused = focusedRef.current;
        const isFocusedAndVisible = isTabActivelyVisible(
          focused === terminalPanelId(ts.id),
          typeof document !== 'undefined' ? document.hasFocus() : true,
        );

        const topicName = ts.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
        const decision = decideTerminalBanner({
          terminalId: ts.id,
          phase: state.phase,
          prevPhase,
          rev: state.rev,
          pendingApproval: state.pendingApproval,
          name: ts.name,
          fallbackTitle: topicName,
          isFocusedAndVisible,
          notifyEvenWhenFocused: cfg.notifyEvenWhenFocused,
        });
        if (!decision) return;

        // Dedupe ledger — the last guard against a reconnect replay re-firing an
        // event we already showed (decideTerminalBanner suppresses same-phase
        // repeats, but a bootstrap can present the same transition afresh with a
        // reset prevPhase). Bound the set so it can't grow unboundedly on a
        // long-lived always-mounted hook.
        const ledger = firedTermBannersRef.current;
        if (ledger.has(decision.dedupeKey)) return;
        ledger.add(decision.dedupeKey);
        if (ledger.size > 500) {
          // Evict oldest ~half (insertion order) — cheap and rare.
          const keep = Array.from(ledger).slice(-250);
          ledger.clear();
          for (const k of keep) ledger.add(k);
        }

        fire(decision.level === 'warn' ? 'warn' : 'ok', decision.title, decision.body, cfg.notificationsSound);
        return;
      }

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

      // Il task che questo topic sta lavorando, se ce n'è uno. Serve due volte:
      // per zittire la fine turno di un agente di board (subito sotto) e per far
      // viaggiare il `taskId` dentro al banner (più giù), così un click apre il
      // drawer del task.
      const task = topicId ? (taskForTopicRef.current?.(topicId) ?? null) : null;

      // Un agente di board al lavoro: la fine di un suo turno non è un evento per
      // l'umano — o il dispatcher rilancia, o arriva `task:review-ready` col suo
      // banner, più informativo. Senza questo, una consegna sola ne produceva
      // due quasi identici (il nome del topic È il testo del task).
      // Il taglio sta PRIMA della cooldown di proposito: scrivere la chiave qui
      // mangerebbe il banner di review che nella consegna di sistema arriva
      // DOPO. Vedi lib/notify/dispatchedTopic.ts.
      if (isAgentTurnNoise(phase, task?.dispatchState)) return;

      const focusedTopicId = topicIdFromPanel(focusedRef.current);
      // Only suppress when the user is ACTIVELY looking at this chat — its tab is
      // selected AND the window has OS focus. focusedPanelId doesn't clear on
      // window blur, so gate on document.hasFocus() (same fix as the terminal
      // path) or a backgrounded window with this tab active would eat the banner.
      const isFocused = isTabActivelyVisible(
        topicId !== null && topicId === focusedTopicId,
        typeof document !== 'undefined' ? document.hasFocus() : true,
      );
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      // 10s cooldown. Key by topicId FIRST so this phase notification and the
      // agents:sessions completion (which keys by topicId) collapse into ONE
      // toast for the same chat instead of double-firing. Fall back to
      // claudeSessionId / sessionKey when no topic resolved. (This handler only
      // runs for chats — it early-returns on a null sessionKey above — so the
      // pty `terminal:activity` path never collides here.)
      const cooldownKey = topicId || state.claudeSessionId || sessionKey;
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(cooldownKey, now);

      // Dispatched-task topic → the banner carries the taskId so a click opens it.
      const taskId = task?.taskId ?? null;
      // Il corpo lo scrive `statusBody`, la stessa funzione del ramo terminale:
      // una frase sola per due superfici.
      switch (phase) {
        case 'awaiting-user':
          fire('ok', label, statusBody('awaiting-user'), cfg.notificationsSound, taskId);
          break;
        case 'awaiting-approval':
          fire('warn', label, statusBody('awaiting-approval'), cfg.notificationsSound, taskId);
          break;
        case 'completed':
          fire('ok', label, statusBody('completed'), cfg.notificationsSound, taskId);
          break;
        case 'error':
          fire('warn', label, statusBody('error'), cfg.notificationsSound, taskId);
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
      // (`terminal:<id>`); skip the toast if the user is staring at it already —
      // but only when the window has OS focus, so a backgrounded window whose
      // active tab is this terminal still surfaces the banner (isTabActivelyVisible).
      const focused = focusedRef.current;
      const isFocused = isTabActivelyVisible(
        !!focused && focused.includes(msg.id),
        typeof document !== 'undefined' ? document.hasFocus() : true,
      );
      if (isFocused && !cfg.notifyEvenWhenFocused) return;

      const cooldownKey = ts?.claudeSessionId || `terminal:${msg.id}`;
      const now = Date.now();
      const last = cooldownRef.current.get(cooldownKey) ?? 0;
      if (now - last < 10_000) return;
      cooldownRef.current.set(cooldownKey, now);

      const topicName = ts?.topicId ? topicsRef.current[ts.topicId]?.name : undefined;
      const label = ts?.name || topicName || 'Claude Code';
      fire('ok', label, statusBody('completed'), cfg.notificationsSound);
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
