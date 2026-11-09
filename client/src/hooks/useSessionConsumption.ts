/** The reads behind every place that shows the sessions' consumption: one poll, one clock. */
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { startVisibleInterval } from '../state/documentVisibility';
import { readConsumption } from '../lib/sessionConsumption';
import type { ConsumptionAnswer } from '../../../shared/session-consumption';

export interface ConsumptionReads {
  answer: ConsumptionAnswer | null;
  /** When the last answer came, epoch ms. */
  at: number | null;
  /** The last read failed (a failed read keeps the last good answer). */
  failing: boolean;
}

/** One read every `pollMs` while the page is visible; a failed read keeps the last good answer and says so. */
export function useSessionConsumption(path: string, pollMs: number, enabled = true): ConsumptionReads {
  const [reads, setReads] = useState<ConsumptionReads>({ answer: null, at: null, failing: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      let answer: ConsumptionAnswer | null = null;
      try {
        const r = await apiFetch(path);
        if (r.ok) answer = readConsumption(await r.json());
      } catch { /* the band says the read failed */ }
      if (!alive) return;
      setReads((prev) => ({ answer: answer ?? prev.answer, at: answer ? Date.now() : prev.at, failing: answer === null }));
    };
    void read();
    const stop = startVisibleInterval(() => { void read(); }, pollMs);
    return () => { alive = false; stop(); };
  }, [path, pollMs, enabled]);
  return reads;
}

/** The wall clock, once a second: what makes a session's elapsed time run. */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => startVisibleInterval(() => setNow(Date.now()), 1000), []);
  return now;
}
