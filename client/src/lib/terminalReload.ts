/**
 * Restarting a terminal session, in ONE place.
 *
 * The gesture lived in three copies — the tab's context menu, and two buttons inside the terminal
 * pane itself — each with its own `markTerminalReloading` plus a 15s timeout, and two of them
 * ending in `.catch(() => {})`. That swallow is what a person reads as "the restart hangs": the
 * overlay says «Riavvio…» for fifteen seconds and then leaves, and nothing ever happened. The
 * server refuses in three distinct ways (409 already reloading, 404 unknown session, 500 spawn
 * failed — see `server/routes/terminal.ts`) and none of them reached the screen.
 *
 * Curing one copy left the other two lying, which is why this is a function and not a third fix.
 * The 15s timeout stays what it always was: the safety net for a reconnect that never arrives,
 * NOT the way to find out it went wrong.
 *
 * `toast` and `tr` are passed in because both are React hooks at the call sites; keeping them as
 * parameters is what lets the one implementation serve all three.
 */
import { signalsActions } from '../state/signals';

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
      giveUp(said.trim() || tr('tab.restartSessionFailed'));
    })
    .catch(() => giveUp(tr('tab.restartSessionUnreachable')));
}
