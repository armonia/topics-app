/**
 * Which chat the person is looking at, for the chat 'done' mark.
 *
 * A clean turn end raises the mark (`chatFinishedEdge`), and viewing the chat
 * clears it. When the chat that finished was already in front, the mark used
 * to be raised and then cleared one commit later by the chat pane's effect:
 * short enough to be invisible on the tab, long enough for the provider's
 * effects to paint +1 on the Dock and the PWA badge and take it back, at every
 * turn end (setAppBadge history 0,1,0,1,...; in Tauri two `set_app_status`
 * calls per turn). So the chat pane declares its chat here, and the turn end
 * reads it synchronously and raises no mark at all.
 */
import { useEffect } from 'react';
import { signalsActions, useSignalsStore } from './signals';
import { isWindowAwake } from './windowAwake';

/** Topic id → how many mounted panes show it as their focused chat (two
 *  windows of one page, a remount overlapping). */
const chatsInView = new Map<string, number>();

/** Declare `topicId` shown as a focused chat until the returned release runs. */
export function holdChatInView(topicId: string): () => void {
  chatsInView.set(topicId, (chatsInView.get(topicId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (chatsInView.get(topicId) ?? 1) - 1;
    if (n > 0) chatsInView.set(topicId, n);
    else chatsInView.delete(topicId);
  };
}

/** Is the person looking at this chat now: a pane shows it focused AND the
 *  window is awake (`isWindowAwake`, the predicate the seen dwell reads). A
 *  chat focused in a window behind another app is not in front of anyone. */
export function isChatInFront(topicId: string): boolean {
  return (chatsInView.get(topicId) ?? 0) > 0 && isWindowAwake();
}

/**
 * Viewing a chat clears its "finished" mark, the twin of the effect in
 * `SingleTerminalPane`. While it is viewed the chat is declared in view, so a
 * turn that ends while the person looks at it raises no mark at all. The clear
 * waits for an awake window, the same rule: a chat that finished in a window
 * behind another app keeps its mark, and it goes when the window comes back.
 */
export function useClearChatFinishedWhileViewed(topicId: string, viewing: boolean): void {
  const finished = useSignalsStore((s) => s.chatFinishedTopics.has(topicId));
  useEffect(() => (viewing ? holdChatInView(topicId) : undefined), [viewing, topicId]);
  useEffect(() => {
    if (!viewing || !finished) return;
    const clearIfAwake = () => { if (isWindowAwake()) signalsActions.clearChatFinished(topicId); };
    clearIfAwake();
    // `isWindowAwake` reads visibility and focus: either can bring the window
    // back (the same events `useSeenDwell` listens to).
    document.addEventListener('visibilitychange', clearIfAwake);
    window.addEventListener('focus', clearIfAwake);
    return () => {
      document.removeEventListener('visibilitychange', clearIfAwake);
      window.removeEventListener('focus', clearIfAwake);
    };
  }, [viewing, finished, topicId]);
}
