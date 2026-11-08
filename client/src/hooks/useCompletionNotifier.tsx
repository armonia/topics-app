import { useEffect, useRef } from 'react';
import type { AppSettings, WSMessage } from '../types';
import { useRefMirror } from './useRefMirror';
import { notifyNative } from '../lib/shell/app';
import { initFocusStatus, isFocusSilencing } from '../lib/shell/focus';
import { bannerClaimant, claimMessageBanner } from '../lib/notify/messageBannerClaim';
import { announceBannerOf, createAnnounceLedger } from '../lib/notify/announceBanner';
import { isPushSubscribed } from '../state/pushDevice';

interface CompletionNotifierProps {
  /** WS subscription registrar from useWebSocket().onMessage. */
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  /** Live AppSettings: `notificationsEnabled`, `notificationsSound`,
   *  `notifyEvenWhenFocused` gate the banner and the tone. */
  settings: AppSettings;
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

/**
 * THE BANNERS OF THIS WINDOW, from the server's announces only
 * (notifications-redesign, design section 10.2, ATTN-11).
 *
 * The server decides once, at a new epoch of a subject, whether it is
 * announced, with which words and buttons (PUSH-04), and leaves out a subject
 * silenced, archived or of a board agent (MUTE-01). It writes the history row
 * too: this hook writes no row any more. What is left here:
 *   - `announceBannerOf`: live, an epoch this window has not announced, the
 *     master switch, born seen only with «notify even when focused», and the
 *     push's own voice on a device subscribed to it;
 *   - the claim between windows on `subject#epoch`: two windows, the main one
 *     hidden in the tray included, deliver ONE banner;
 *   - Do Not Disturb (QUIET-01): the shell reads the focus state, the server
 *     cannot, so the gate stays where the reading is. It stops the Mac's
 *     banner, never the push to the phone.
 *
 * Gone: the branches on `session:state`, `stream:end`, `message:new`,
 * `terminal:activity`, `task:review-ready` and `task:parked`. Each one made
 * its own decision on a different subset of the facts, and together they rang
 * "your turn" for a chat waiting on its background work and then again for
 * every woken turn (BG-2, D1), and rang the chat in front with the setting off
 * (defect D).
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its renderless bridge component (CompletionNotifierBridge); idiomatic and the bridge is the sole consumer
export function useCompletionNotifier({ onWSMessage, settings }: CompletionNotifierProps): void {
  // Arm the Focus/DND gate. Installs the push hook the native watcher calls and
  // does one eager query; idempotent and a no-op off Tauri (web keeps the safe
  // "notify normally" default). See lib/shell/focus.ts.
  useEffect(() => {
    initFocusStatus();
  }, []);

  const settingsRef = useRefMirror(settings);
  // The highest epoch this window announced, per subject. `attention:init`
  // seeds it, so a reload, a reconnect or a new window never rings.
  const ledgerRef = useRef(createAnnounceLedger());

  useEffect(() => onWSMessage((msg) => {
    if (msg.type !== 'attention:init' && msg.type !== 'attention:updated') return;
    const cfg = settingsRef.current;
    const banner = announceBannerOf(msg, {
      notificationsEnabled: !!cfg.notificationsEnabled,
      notifyEvenWhenFocused: !!cfg.notifyEvenWhenFocused,
      pushSubscribed: isPushSubscribed(),
    }, ledgerRef.current);
    if (!banner) return;
    void claimMessageBanner(banner.claimKey, bannerClaimant()).then((won) => {
      if (!won || isFocusSilencing()) return;
      notifyNative(banner.title, banner.body, { silent: true, target: banner.target, tag: banner.tag, actions: banner.actions });
      if (settingsRef.current.notificationsSound) playCompletionTone();
    });
  }), [onWSMessage, settingsRef]);
}

/**
 * Renderless component that wires up `useCompletionNotifier`.
 */
export function CompletionNotifierBridge(props: CompletionNotifierProps) {
  useCompletionNotifier(props);
  return null;
}
