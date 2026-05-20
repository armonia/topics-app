/**
 * useWSSubscription — subscribe to a specific WS message type with the
 * canonical mount/cleanup shape.
 *
 * Before this helper, every consumer hand-wrote:
 *   useEffect(() => {
 *     return onWSMessage((msg) => {
 *       if (msg.type !== 'X') return;
 *       // handle...
 *     });
 *   }, [onWSMessage]);
 *
 * The shape is identical across useMemory, useClaudeSessionState,
 * useAgents, useChat, useCompletionNotifier, etc. — only the type
 * literal and the handler body change. Centralising eliminates the
 * subscribe/unsubscribe boilerplate and guarantees the cleanup contract
 * is always honoured (the underlying `onWSMessage` thunk returns an
 * unsubscribe function that must be called on unmount — easy to forget).
 *
 * Handler stability: we intentionally do NOT add `handler` to the deps
 * array — callers pass an inline arrow function in most cases. The
 * useEffect re-runs only when `onWSMessage` or the type changes (both
 * stable in practice). If a caller needs the handler to read fresh
 * state, use `useRefMirror` to bridge — same idiom as elsewhere.
 */

import { useEffect } from 'react';
import type { WSMessage } from '../types';

/**
 * Subscribe to WS messages of a specific type. Returns void; the
 * cleanup is owned by the effect.
 *
 * @param onWSMessage — the thunk from useWebSocket / parent
 * @param type        — single WS message `type` literal to filter on
 * @param handler     — invoked with the narrowed message
 */
export function useWSSubscription<T extends WSMessage['type']>(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
  type: T,
  handler: (msg: Extract<WSMessage, { type: T }>) => void,
): void {
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type !== type) return;
      handler(msg as Extract<WSMessage, { type: T }>);
    });
    // handler intentionally omitted from deps — see file header.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWSMessage, type]);
}
