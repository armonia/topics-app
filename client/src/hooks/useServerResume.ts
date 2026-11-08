import { useEffect, useState } from 'react';
import type { WSMessage } from '../types';

/**
 * IS THE SERVER RESUMING THIS CHAT RIGHT NOW?
 *
 * THE REPORT (card 1929291c): "if this resumes on its own, with that banner
 * and no sort of progress, you cannot tell whether it really is resuming".
 * allow-italian: the report is quoted in the card, translated here
 *
 * What happens without this hook: the boot resends the last user message
 * (`server/lib/ripresa-boot.ts`), the turn starts, and the chat keeps showing
 * the amber "Response interrupted ... Retry" banner unchanged until the first
 * new token lands. On a long turn that is a minute of a screen whose only
 * advice is to press Retry, and pressing it starts a SECOND turn on a chat
 * that already has one running.
 *
 * WHY A HOOK OF ITS OWN, and not a flag inside `useChat`. Same reason as
 * `useRealContext`: `useChat` is mounted once for the whole app and its state
 * redraws every open pane, while this fact is read by one strip of eleven
 * pixels. It also travels through no prop chain: the composer subscribes to
 * the socket it is already handed.
 */

/**
 * The rule, pure: the state after this frame, given the state before it.
 *
 * The three answers are the three moments of a resume. It BEGINS on a
 * `stream:start` that names the server as the author - a turn a person
 * resumed by pressing Retry is not this case, and the marker says so. It ENDS
 * at the first token, because from there the answer itself is the proof that
 * something is happening, and the banner has nothing left to add. And it ends
 * at `stream:end` too, whatever the ending: a resume that failed goes back to
 * the interrupted banner, with the cause and the Retry button, which is
 * `liveInterruptionBlock`'s job on the row.
 */
export function resumeStateAfter(current: boolean, event: WSMessage, sessionKey: string): boolean {
  const key = (event as { sessionKey?: string }).sessionKey;
  // Frames of another chat say nothing about this one. `useChat` is global,
  // so without this a resume in a background topic would light the banner
  // under whatever composer is on screen.
  if (key !== undefined && key !== sessionKey) return current;
  switch (event.type) {
    case 'stream:start':
      return (event as { resumedBy?: string }).resumedBy === 'server';
    case 'stream:content_chunk':
    case 'stream:thinking_chunk':
    case 'stream:end':
    case 'stream:error':
      return false;
    default:
      return current;
  }
}

/** The same rule, subscribed to the socket, for one session. */
export function useServerResume(
  sessionKey: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): boolean {
  /**
   * The session travels WITH the answer, and the comparison happens in render.
   *
   * The pane is not keyed on the session (a project window swaps the active
   * topic in place), so a resume announced for chat A must not survive the
   * swap to chat B: it would be a banner promising a resume nobody started.
   * Clearing it from an effect would be a render more, and a `setState` inside
   * an effect body, which is the cascade the lint rule is about.
   */
  const [seen, setSeen] = useState<{ key: string; resuming: boolean } | null>(null);

  useEffect(() => {
    if (!sessionKey || !onMessage) return;
    return onMessage((msg) => {
      setSeen((prev) => {
        const before = prev?.key === sessionKey ? prev.resuming : false;
        const after = resumeStateAfter(before, msg, sessionKey);
        return after === before && prev?.key === sessionKey ? prev : { key: sessionKey, resuming: after };
      });
    });
  }, [sessionKey, onMessage]);

  return seen !== null && seen.key === sessionKey && seen.resuming;
}
