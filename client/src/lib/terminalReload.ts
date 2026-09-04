/**
 * Restarting a terminal session, in ONE place.
 *
 * The gesture lived in three copies — the tab's context menu, and two buttons inside the terminal
 * pane itself — each with its own `markTerminalReloading` plus a 15s timeout, and two of them
 * ending in `.catch(() => {})`. That swallow is what a person reads as "the restart hangs": the
 * overlay says «Riavvio…» for fifteen seconds and then leaves, allow-italian: quoted UI string
 * and nothing ever happened. The server refuses in three distinct ways (409 already reloading,
 * 404 unknown session, 500 spawn failed — see `server/routes/terminal.ts`) and none of them
 * reached the screen.
 *
 * Curing one copy left the other two lying, which is why this is a function and not a third fix.
 * The 15s timeout stays what it always was: the safety net for a reconnect that never arrives,
 * NOT the way to find out it went wrong.
 *
 * `toast` and `tr` are passed in because both are React hooks at the call sites; keeping them as
 * parameters is what lets the one implementation cover all three call sites.
 *
 * The first cure showed the server's answer RAW, and `errorResponse` always serialises
 * `{"error": "..."}`: what a person read was `{"error":"Reload already in progress for this
 * session"}`, braces included, in English, and on a 500 with an internal exception message inside.
 * So the reason now comes from `terminalErrorText` — the status, translated, one sentence.
 */
import { signalsActions } from '../state/signals';
import { terminalErrorText, terminalUnreachableText } from './terminalActions';

type ErrorReporter = { error: (message: string, duration?: number) => void };

export function restartTerminalSession(
  sessionId: string,
  toast: ErrorReporter,
  tr: (key: string) => string,
): void {
  signalsActions.markTerminalReloading(sessionId);
  const net = window.setTimeout(() => signalsActions.clearTerminalReloading(sessionId), 15000);
  const giveUp = (reason: string) => {
    window.clearTimeout(net);
    signalsActions.clearTerminalReloading(sessionId);
    toast.error(reason);
  };
  void fetch(`/api/terminal/sessions/${encodeURIComponent(sessionId)}/reload`, { method: 'POST' })
    .then(async (res) => {
      if (res.ok) return;
      const said = await res.text().catch(() => '');
      giveUp(terminalErrorText('restart', res.status, said, tr));
    })
    .catch(() => giveUp(terminalUnreachableText('restart', tr)));
}
