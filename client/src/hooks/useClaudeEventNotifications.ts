/**
 * useClaudeEventNotifications — native desktop banner for P0/P1 Claude session
 * events, replacing the `osascript` banner the stop-hook used to fire.
 *
 * Pipeline: scripts/hooks/claude-stop.ts appends to ~/.topics/events.jsonl →
 * server claude-events-watcher broadcasts a `claude-event` WS message → here we
 * turn P0/P1 (non-suppressed) events into a banner via the Tauri `notify`
 * command (which posts through UserNotifications / terminal-notifier — no Apple
 * Events, so no "control iTunes/Music" prompt). Web builds have no native tray,
 * so this is Tauri-only.
 */
import { useEffect } from 'react';
import type { WSMessage } from '../types';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

interface ClaudeEventMsg {
  type?: string;
  suppressed?: boolean;
  event?: { severity?: string; payload?: { reason?: string; cwd?: string } };
}

export function useClaudeEventNotifications(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): void {
  useEffect(() => {
    if (!onMessage || !isTauri) return;
    return onMessage((msg) => {
      const m = msg as ClaudeEventMsg;
      if (m.type !== 'claude-event' || m.suppressed) return;
      const sev = m.event?.severity;
      if (sev !== 'P0' && sev !== 'P1') return;

      const title = sev === 'P0' ? 'Topics · Blocker' : 'Topics · Awaiting Review';
      const reason = m.event?.payload?.reason;
      const cwd = m.event?.payload?.cwd;
      const body = reason || (cwd ? `in ${cwd}` : 'Session update');

      // Native banner via the existing Tauri command (UserNotifications /
      // terminal-notifier under the hood — no Apple Events).
      void tauriInvoke('notify', { title, body })
        .catch(() => { /* best-effort: never surface a hook notification failure */ });
    });
  }, [onMessage]);
}
