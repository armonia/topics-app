/**
 * useGlobalBoardCount — live count of ACTIVE (non-done) tasks across all
 * projects, for the "Board generale" sidebar affordance.
 *
 * Sources the global board feed (boardApi.listAll) once on mount, then refreshes
 * on any task:* WebSocket event. "Active" = anything not yet done (archived rows
 * are already excluded server-side). The sidebar shows its Board-generale row
 * only when this is > 0, so the count doubles as the visibility gate.
 */
import { useCallback, useEffect, useState } from 'react';
import type { WSMessage } from '../types';
import { boardApi } from '../lib/board';

export function useGlobalBoardCount(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const tasks = await boardApi.listAll();
      setCount(tasks.filter((t) => t.status !== 'done').length);
    } catch {
      /* leave the last known count on a transient failure */
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'task:created' || t === 'task:updated' || t === 'task:deleted') refresh();
    });
  }, [onMessage, refresh]);

  return count;
}
