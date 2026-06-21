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
 * Handler stability: the subscription is created once per (onWSMessage, type)
 * and the LATEST handler is invoked through a ref updated each render. So an
 * inline arrow closing over reactive props/state always reads fresh values —
 * no `useRefMirror` discipline required at the call site, and no stale-closure
 * footgun hidden behind an eslint-disable.
 */

import { useEffect } from 'react';
import { useRefMirror } from './useRefMirror';
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
  // Keep the latest handler in a ref so the stable subscription below always
  // calls the freshest closure without re-subscribing on every render.
  const handlerRef = useRefMirror(handler);
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type !== type) return;
      handlerRef.current(msg as Extract<WSMessage, { type: T }>);
    });
  }, [onWSMessage, type, handlerRef]);
}
