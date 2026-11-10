import { Play } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Select } from '../primitives/Field';
import { ProgressBar, Spinner } from '../primitives/Progress';
import { ErrorState } from '../primitives/States';
import { TONE_TEXT } from '../tone';
import type { JobView, TryResult, TryRow } from './model';

function Rows({ rows }: { rows: TryRow[] }) {
  return (
    <dl className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0">
          <dt className="text-mini font-medium uppercase tracking-[0.06em] text-app-text-tertiary">{r.label}</dt>
          <dd className={`text-prose leading-5 ${r.tone ? TONE_TEXT[r.tone] : 'text-app-text'}`}>
            {r.value}
            {r.source && (
              r.source.onOpen ? (
                <button
                  type="button"
                  onClick={r.source.onOpen}
                  className="ml-1.5 inline-flex h-5 items-center rounded bg-sky-500/10 px-1.5 align-[1px] text-mini font-medium text-sky-700 hover:bg-sky-500/20 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-sky-300"
                >
                  {r.source.label}
                </button>
              ) : <span className="ml-1.5 text-mini text-app-text-tertiary">{r.source.label}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * «Prova questo passo» on a real case: pick the case, run (a job with its (allow-italian: quotes the Italian interface)
 * progress), then what the step read and what it returned, each with the
 * words it comes from. A failed job says why and offers to run again.
 */
export function TryPanel({ copy, cases, caseId, onCase, onRun, onClose, job, result, busy, runDisabledTitle, emptyText }: {
  copy: UiCopy;
  cases: Array<{ value: string; label: string }>;
  caseId: string;
  onCase: (id: string) => void;
  onRun: (() => void) | false;
  onClose?: () => void;
  job?: JobView;
  result?: TryResult;
  busy: boolean;
  runDisabledTitle?: string;
  emptyText: string;
}) {
  const c = copy.flowRun.tryIt;
  return (
    <Card title={c.title} icon={Play} tone={job?.status === 'failed' ? 'red' : undefined} actions={onClose ? <Button size="sm" variant="ghost" onClick={onClose}>{c.close}</Button> : undefined}>
      {cases.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p>{c.lead}</p>
          <div className="flex flex-wrap items-end gap-2">
            <Select label={c.pickCase} className="min-w-[240px] flex-1" value={caseId} options={cases} onChange={onCase} disabled={busy} />
            <Button variant="primary" icon={Play} onClick={busy ? false : onRun} title={runDisabledTitle}>{c.run}</Button>
          </div>
          {job && job.status === 'running' && (
            <div className="flex flex-col gap-2 rounded-lg bg-black/[0.03] p-3 dark:bg-white/[0.04]">
              <ProgressBar value={job.progress} label={job.current ?? job.title} detail={c.progress(Math.round(job.progress * 100))} />
              <ul className="flex flex-col gap-0.5 text-compact text-app-text-tertiary">
                {job.done.map((d) => <li key={d}>{d}</li>)}
                <li className="flex items-center gap-1.5 text-app-text-secondary"><Spinner size={11} />{job.current}</li>
              </ul>
            </div>
          )}
          {job && job.status === 'failed' && <ErrorState title={c.failedTitle} body={job.failed ?? c.failedBody} action={<Button onClick={onRun}>{c.again}</Button>} className="!min-h-0 !py-4" />}
          {result && (!job || job.status !== 'running') && (
            <div className="grid gap-4 border-t border-app-border pt-3 md:grid-cols-2">
              <section aria-label={c.readTitle}>
                <h4 className="mb-2 text-compact font-semibold text-app-text">{c.readTitle}</h4>
                <Rows rows={result.input} />
              </section>
              <section aria-label={c.returnedTitle}>
                <h4 className="mb-2 text-compact font-semibold text-app-text">{c.returnedTitle}</h4>
                <Rows rows={result.output} />
              </section>
              <p className="text-compact text-app-text-tertiary md:col-span-2">{result.note ?? c.sameInput} · {c.tried(result.caseTitle, result.at)}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
