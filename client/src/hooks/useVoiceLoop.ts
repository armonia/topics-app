/**
 * The voice loop board: when a task reaches review, announce it out loud and
 * — outside `off` — listen for a spoken reply (approve / feedback / close).
 *
 * Reuses, doesn't reinvent:
 *  · `task:review-ready` — the same WS edge `useCompletionNotifier` banners
 *    on, subscribed independently here (a second `useWSSubscription` on the
 *    same event, not a second copy of its cooldown/mute logic — this loop
 *    has its own anti-crowding, see `lib/voice/announceQueue.ts`).
 *  · `useTextToSpeech` — for the announcement (ElevenLabs, falling back to
 *    native `speechSynthesis`).
 *  · `recordUtterance` — one VAD-bounded turn of the reply, transcribed via
 *    `/api/stt` (Whisper). Same recipe as `useVoiceCall`, standalone.
 *  · `classifyVoiceIntent` → `/api/voice/intent` (Groq, keyword fallback).
 *  · `runNotificationAction` + `boardNotificationDeps` — the SAME executor
 *    already wired to the notification banners' buttons: approve/feedback
 *    ride `/api/boards/:p/tasks/:t/review`, zero new board endpoints.
 *
 * `close` never calls the board — it only stops this turn's loop. Deciding a
 * task is done stays a human gesture on the card; "close" here means "stop
 * talking to me".
 *
 * Renderless orchestrator, no UI: call it once, with the `mode` and the shared
 * `onWSMessage` thunk. Off unless a mode is passed, so it never opens a
 * microphone the person didn't ask for. No control sets it today: the
 * `voiceMode` preference left `AppSettings` because nothing could change it
 * (USERMENU-06), and App passes `'off'`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useWSSubscription } from './useWSSubscription';
import { useRefMirror } from './useRefMirror';
import { useTextToSpeech } from './useSpeech';
import type { AnnounceQueueState } from '../lib/voice/announceQueue';

/**
 * The empty queue, written here instead of imported, so that NOTHING of
 * `announceQueue` is pulled into the eager bundle just to seed a ref. The
 * module itself arrives with the rest of the voice machinery, on the first
 * turn that actually speaks (see `drain`). One object literal is a cheaper
 * price than a module.
 */
const EMPTY_ANNOUNCE_QUEUE: AnnounceQueueState = { items: [] };
import { runNotificationAction } from '../lib/notify/notificationAction';
import { boardNotificationDeps } from '../lib/notify/boardActionDeps';
import type { WSMessage } from '../types';

/**
 *  · `off` — no announcement, no mic opened on its own.
 *  · `always` — every `task:review-ready` is announced and, right after, the
 *    app listens for the reply.
 *  · `wake-word` — still announces, but the reply is only recorded if the
 *    transcript contains the activation phrase (`lib/voice/wakeWord.ts`).
 */
export type VoiceLoopMode = 'off' | 'always' | 'wake-word';

export interface VoiceLoopProps {
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  mode: VoiceLoopMode;
}

export function useVoiceLoop({ onWSMessage, mode }: VoiceLoopProps): void {
  const { speak, stop: stopSpeaking } = useTextToSpeech();
  const modeRef = useRefMirror(mode);
  const queueRef = useRef<AnnounceQueueState>(EMPTY_ANNOUNCE_QUEUE);
  const drainingRef = useRef(false);

  // One item processed at a time: two `task:review-ready` a second apart
  // must never overlap two spoken turns. `drainingRef` is the sole guard —
  // a second call while draining just returns, the loop below keeps pulling
  // from `queueRef` until it's empty.
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    // The voice machinery is loaded HERE, not at module level. It is dead
    // weight for everybody who never speaks to the board (`mode: 'off'`
    // is the default) and it was 26 KB of the eager entry, which is what
    // `check:bundle` measured. Fetched once per drain, after the first
    // `speak()` has already started - no turn waits on it. Destructured on
    // purpose: `.then((m) => m.default)` is the form that makes the module a
    // blind spot for knip (see the same note in `i18n.ts`).
    const [
      { recordUtterance },
      { extractAfterWakePhrase },
      { classifyVoiceIntent },
      { nextAnnouncement, announceText, rollupText },
    ] = await Promise.all([
      import('../lib/voice/recordUtterance'),
      import('../lib/voice/wakeWord'),
      import('../lib/voice/classifyIntent'),
      import('../lib/voice/announceQueue'),
    ]);
    try {
      for (;;) {
        if (modeRef.current === 'off') {
          queueRef.current = EMPTY_ANNOUNCE_QUEUE;
          return;
        }
        const { announcement, rest } = nextAnnouncement(queueRef.current);
        queueRef.current = rest;
        if (!announcement) return;

        if (announcement.kind === 'rollup') {
          // A rollup only names what's waiting; there is no single task to
          // reply to, so no mic turn follows it.
          await speak(rollupText(announcement.items));
          continue;
        }

        const item = announcement.item;
        await speak(announceText(item));

        const transcript = await recordUtterance();
        // Switched off while the mic was listening: what it heard is not for
        // the board. Checked here and after the classifier, the two awaits a
        // flip to `off` can land in, not only at the top of the round.
        if (modeRef.current === 'off') continue;
        if (!transcript.trim()) continue; // silence / no reply in time: skip, task untouched

        const heard =
          modeRef.current === 'wake-word' ? extractAfterWakePhrase(transcript) : transcript;
        // wake-word mode and the phrase was never said: this turn wasn't
        // meant for the board, skip it.
        if (heard === null) continue;
        const toClassify = heard.trim() || transcript.trim();

        const result = await classifyVoiceIntent(toClassify);
        if (modeRef.current === 'off') continue;
        if (result.intent === 'close') continue; // stop listening, task stays as it is

        const actionId = result.intent === 'approve' ? 'approve' : `answer:${encodeURIComponent(result.text ?? toClassify)}`;
        await runNotificationAction(item.taskId, actionId, boardNotificationDeps());
      }
    } finally {
      drainingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modeRef is a stable ref object (useRefMirror), reading `.current` needs no re-subscription
  }, [speak]);

  // Async on purpose: the enqueue lives in the same lazy module as the rest of
  // the voice machinery, so it arrives a microtask later. Nothing observes the
  // difference - `drain` was already async and is guarded by `drainingRef`.
  useWSSubscription(onWSMessage, 'task:review-ready', (msg) => {
    if (modeRef.current === 'off') return;
    if (!msg.taskId || !msg.projectId) return;
    void (async () => {
      const { enqueueAnnouncement } = await import('../lib/voice/announceQueue');
      if (modeRef.current === 'off') return;
      queueRef.current = enqueueAnnouncement(queueRef.current, {
        taskId: msg.taskId!,
        projectId: msg.projectId!,
        title: (msg.taskTitle || 'Task').slice(0, 140),
        questionText: msg.question?.text,
      });
      void drain();
    })();
  });

  // Flip to `off` mid-loop: stop talking, drop whatever is queued. The mic
  // turn already in flight (inside `recordUtterance`) still finishes on its
  // own VAD timeout, but the loop above does not act on it: it re-checks the
  // mode right after the turn and again after the classifier.
  useEffect(() => {
    if (mode === 'off') {
      stopSpeaking();
      queueRef.current = EMPTY_ANNOUNCE_QUEUE;
    }
  }, [mode, stopSpeaking]);
}
