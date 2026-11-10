/**
 * Simulated work with visible progress (a test run, sending a PEC, a filing):
 * each step takes its time, a failing step stops the job, and `onDone` hands
 * the result to the area that started it. Jobs live in memory only: a reload
 * in the middle drops the job, the result of a finished one is in the state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobInput, JobState } from './kit';

export function useJobs(speed: number) {
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const startJob = useCallback((job: JobInput) => {
    const total = job.steps.length;
    setJobs((all) => ({ ...all, [job.id]: { id: job.id, title: job.title, progress: 0, current: job.steps[0]?.label, status: 'running', done: [] } }));
    let elapsed = 0;
    for (let i = 0; i < total; i++) {
      const step = job.steps[i];
      elapsed += Math.max(60, step.ms * speed);
      const t = window.setTimeout(() => {
        setJobs((all) => {
          const prev = all[job.id];
          if (!prev || prev.status !== 'running') return all;
          if (step.fails) {
            return { ...all, [job.id]: { ...prev, status: 'failed', failed: step.label, current: undefined } };
          }
          const done = [...prev.done, step.label];
          const last = i === total - 1;
          return {
            ...all,
            [job.id]: { ...prev, done, progress: done.length / total, current: last ? undefined : job.steps[i + 1]?.label, status: last ? 'done' : 'running' },
          };
        });
        if (step.fails) job.onDone?.(false);
        else if (i === total - 1) job.onDone?.(true);
      }, elapsed);
      timers.current.push(t);
      /* A failing step ends the job: later steps are never scheduled. */
      if (step.fails) break;
    }
    if (!total) job.onDone?.(true);
  }, [speed]);

  const job = useCallback((id: string) => jobs[id], [jobs]);
  /** Drops every job and its pending steps (the demo reset). */
  const clearJobs = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setJobs({});
  }, []);
  return { startJob, job, clearJobs };
}
