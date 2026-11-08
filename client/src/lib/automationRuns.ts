/**
 * The runs of one automation, for its detail: the Jarvis job's runs as the
 * hub's `automations/runs` reads them from jarvis-channels (when, how long, the
 * outcome, whether it was launched by hand, whether it wrote to you or why
 * not, what it produced or its error in full, the report of the day, the
 * model and its tokens), and the cost of a workflow run.
 *
 * Pure reads: no fetch, no React. The view formats every word.
 */
import { asRecord, num, str } from './automationsHead';
import type { RunOutcome } from './automations';

export interface CronRun {
  at: number;
  ms: number | null;
  outcome: RunOutcome | null;
  /** First line of what it produced or of its error, or of the day's report. */
  text: string | null;
  /** What it produced, whole. */
  output: string | null;
  /** Its error, whole. */
  error: string | null;
  manual: boolean;
  /** It wrote to you, on that channel (null when the scheduler does not say which). */
  wrote: { channel: string | null } | null;
  /** Why it did not write to you, in the hub's words. */
  whyNot: string | null;
  report: { path: string; text: string } | null;
  model: string | null;
  tokens: number | null;
}

function firstLine(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // A report opens with a heading or a table rule: its first real line says more.
  const line = s.split('\n').map((l) => l.trim()).find((l) => l && !/^#|^\|?-{3}|^\|/.test(l)) ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line || null;
}

function outcomeOf(v: unknown): RunOutcome | null {
  return v === 'ok' || v === 'error' || v === 'skipped' ? v : null;
}

/** The runs of a Jarvis job, as the hub's `automations/runs` answers them. */
export function readCronRuns(raw: unknown): CronRun[] | null {
  const runs = asRecord(raw)?.runs;
  if (!Array.isArray(runs)) return null;
  return runs.flatMap((r): CronRun[] => {
    const o = asRecord(r);
    const at = o && num(o.at);
    if (!o || at === null) return [];
    const oc = outcomeOf(o.outcome);
    const rep = asRecord(o.report);
    const repPath = rep && str(rep.path);
    const repText = rep && str(rep.text);
    const wrote = asRecord(o.wrote);
    const error = str(o.error);
    const output = str(o.text);
    return [{
      at, ms: num(o.ms), outcome: oc,
      text: (oc === 'error' ? firstLine(error) ?? firstLine(output) : firstLine(output)) ?? (repText ? firstLine(repText) : null),
      output, error: oc === 'error' ? error : null,
      manual: o.manual === true,
      wrote: wrote ? { channel: str(wrote.channel) } : null,
      whyNot: str(o.whyNot),
      report: repPath && repText ? { path: repPath, text: repText } : null,
      model: str(o.model),
      tokens: num(o.tokens),
    }];
  });
}

/** How many of the runs wrote to you, and how many failed: the heading of the list. */
export function runsSummary(runs: CronRun[]): { wrote: number; failed: number } {
  return { wrote: runs.filter((r) => r.wrote).length, failed: runs.filter((r) => r.outcome === 'error').length };
}

/** «claude-sonnet-5-5» reads «Sonnet 5.5», «muse-spark-1.3» «Muse Spark 1.3», «gpt-5.6-sol» «GPT-5.6 Sol». */
export function prettyModel(model: string): string {
  const m = model.replace(/^[a-z-]+\//, '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  if (/^gpt-/i.test(m)) {
    const [head, ...rest] = m.split('-').slice(1);
    return [`GPT-${head ?? ''}`, ...rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1))].join(' ');
  }
  return m.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The hub's estimate of a workflow run's cost: agents and share of the week. */
export function readRunCost(raw: unknown): { agents: number; weekPct: number | null } | null {
  const o = asRecord(raw);
  if (!o || o.ok !== true) return null;
  return { agents: num(o.agents) ?? 0, weekPct: num(o.weekPct) };
}

