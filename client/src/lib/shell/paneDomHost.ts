/**
 * The native pane's half of the DOM mirror (lib/nativeDomHost.ts), bound to the
 * shell: the page is reached with `browser_eval_js`, the recorder comes from the
 * server, and the server's first ack tells every pane it relays mirrors.
 */
import { createNativeDomHost, type NativeDomHost, type NativeDomHostOptions } from '../nativeDomHost';
import { noteDomHostAccepted } from '../domHostSupport';
import { isTauriWindows } from './index';
import { apiFetch } from './net';
import { tauriInvoke } from './tauri';

/**
 * macOS only: there `browser_eval_js` hands the page's string back as it is,
 * while WebView2 and WebKitGTK quote it, and those hosts are outside this change.
 */
const canHostDomMirror =
  !isTauriWindows && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

export function createPaneDomHost(
  id: string,
  wiring: Pick<NativeDomHostOptions, 'sendText' | 'navigate' | 'onRecordingChange' | 'setViewport'>,
): NativeDomHost | null {
  if (!canHostDomMirror) return null;
  return createNativeDomHost({
    evalInPage: (js, preserveFocus) =>
      tauriInvoke<string>('browser_eval_js', { id, js, ...(preserveFocus ? { preserveFocus: true } : {}) }),
    loadRecorder: async () => {
      const res = await apiFetch('/api/browser/recorder.js');
      if (!res.ok) throw new Error(`recorder ${res.status}`);
      return res.text();
    },
    onAccepted: noteDomHostAccepted,
    ...wiring,
  });
}
