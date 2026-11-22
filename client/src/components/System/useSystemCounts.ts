/**
 * The numbers next to the System column entries: servers and skills, memory
 * stores. Read once when the page opens; the sections themselves stay live.
 */
import { useEffect, useState } from 'react';
import { readJson } from '../../lib/readJson';

export interface SystemCounts {
  servers: number | null;
  skills: number | null;
  stores: number | null;
}

export function useSystemCounts(): SystemCounts {
  const [counts, setCounts] = useState<SystemCounts>({ servers: null, skills: null, stores: null });
  useEffect(() => {
    let alive = true;
    void readJson('/api/agent-tools').then((b) => {
      const inventory = b as { mcp?: unknown[]; skills?: unknown[] } | null;
      if (alive && inventory) setCounts((c) => ({ ...c, servers: inventory.mcp?.length ?? 0, skills: inventory.skills?.length ?? 0 }));
    });
    void readJson('/api/memory-stores').then((b) => {
      const stores = (b as { stores?: unknown[] } | null)?.stores;
      if (alive && stores) setCounts((c) => ({ ...c, stores: stores.length }));
    });
    return () => { alive = false; };
  }, []);
  return counts;
}
