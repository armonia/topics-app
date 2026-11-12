import { useEffect, useState } from 'react';
import type { MachineOverview } from '../../../shared/machine-overview';
import { readJson } from '../lib/readJson';
import { startVisibleInterval } from '../state/documentVisibility';

const POLL_MS = 15_000;

/** Every machine Topics knows, with gauges and provider extras, again every 15 s while the page is visible. */
export function useMachinesOverview(enabled = true): MachineOverview | null {
  const [overview, setOverview] = useState<MachineOverview | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      const next = (await readJson('/api/machines/overview')) as MachineOverview | null;
      if (alive && next && Array.isArray(next.machines)) setOverview(next);
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, POLL_MS);
    return () => { alive = false; stop(); };
  }, [enabled]);
  return overview;
}
