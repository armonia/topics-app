/**
 * useMachines — Phase D · client cache for the Machine entity.
 * Mirrors useProjects/useWorktrees: REST list on mount + WS subscription.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Machine, WSMessage } from '../types';
import { machinesApi } from '../lib/api';

interface UseMachinesOptions {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

interface UseMachinesResult {
  machines: Machine[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  byId: (id: string) => Machine | undefined;
  /** Helper: the machine where the local server runs. Detected by status==='online' + most-recent heartbeat. */
  local: Machine | undefined;
}

export function useMachines(options: UseMachinesOptions = {}): UseMachinesResult {
  const { onMessage } = options;
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const result = await machinesApi.list();
      if (mountedRef.current) setMachines(result.machines);
    } catch (err: any) {
      if (mountedRef.current) setError(err?.message ?? 'Failed to load machines');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => { mountedRef.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (msg.type === 'machine:upserted' || msg.type === 'machine:updated') {
        const m = (msg as any).machine as Machine | undefined;
        if (!m) return;
        setMachines((prev) => {
          const idx = prev.findIndex((x) => x.id === m.id);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = m;
            return next;
          }
          return [m, ...prev];
        });
      } else if (msg.type === 'machine:deleted') {
        const id = (msg as any).machine?.id ?? (msg as any).id;
        if (!id) return;
        setMachines((prev) => prev.filter((m) => m.id !== id));
      }
    });
    return unsub;
  }, [onMessage]);

  const byId = useCallback(
    (id: string) => machines.find((m) => m.id === id),
    [machines],
  );
  const local = machines
    .filter((m) => m.status === 'online')
    .sort((a, b) => Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt))[0];

  return { machines, loading, error, refresh, byId, local };
}
