/**
 * The jobs Topics runs itself, read from `/api/scheduled-jobs` and nowhere
 * else: no hub and no jarvis-channels in the way. The list is read when the
 * view opens, every few seconds while it is visible, and again after each
 * write, so the screen shows what the server answered.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { startVisibleInterval } from '../../state/documentVisibility';
import { scheduledJobsApi, type JobInput, type JobRun, type ScheduledJob } from '../../lib/scheduledJobs';

const REFRESH_MS = 4000;

export interface ScheduledJobsData {
  jobs: ScheduledJob[] | null;
  /** The server did not answer the list. */
  failing: boolean;
  /** Reason the last write was refused, in the server's words. */
  error: string | null;
  create(input: JobInput): Promise<boolean>;
  update(id: string, input: Partial<JobInput>): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  runNow(id: string): Promise<boolean>;
  runs(id: string): Promise<JobRun[]>;
  clearError(): void;
}

export function useScheduledJobs(): ScheduledJobsData {
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);
  const [failing, setFailing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const { jobs: list } = await scheduledJobsApi.list();
      if (!alive.current) return;
      setJobs(list); setFailing(false);
    } catch {
      if (alive.current) setFailing(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first read on mount: the state is set after the fetch resolves
    void read();
    const stop = startVisibleInterval(() => { void read(); }, REFRESH_MS);
    return () => { alive.current = false; stop(); };
  }, [read]);

  const write = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); } catch (cause) { setError((cause as Error).message); await read(); return false; }
    await read();
    return true;
  }, [read]);

  const runs = useCallback((id: string) => scheduledJobsApi.runs(id).catch(() => [] as JobRun[]), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    jobs, failing, error,
    create: (input) => write(() => scheduledJobsApi.create(input)),
    update: (id, input) => write(() => scheduledJobsApi.update(id, input)),
    remove: (id) => write(() => scheduledJobsApi.remove(id)),
    runNow: (id) => write(() => scheduledJobsApi.runNow(id)),
    runs,
    clearError,
  };
}
