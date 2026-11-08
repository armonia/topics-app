/**
 * The runs of one automation, in its detail. A Jarvis job's come from
 * jarvis-channels through the hub, read when the detail opens: when, how long, the
 * outcome, «lanciato a mano», whether it wrote to you (and on what) or why
 * not, and, opened, what it produced and its error in full, the report of
 * the day and the model with its tokens. The heading counts the failed ones
 * and how many times it wrote to you. A read that fails offers a retry.
 *
 * A workflow's runs carry their cost, read only when asked. Any other row
 * shows the runs of its last day as the hub keeps them.
 */
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { DANGER_TEXT, SUCCESS_TEXT } from '../../lib/popoverStyles';
import { todayRuns, type AutomationRow, type RunOutcome } from '../../lib/automations';
import { prettyModel, readCronRuns, readRunCost, runsSummary, type CronRun } from '../../lib/automationRuns';
import { noIds } from '../../lib/automationGraph';
import { BUTTON, runWhen, secondsWords, tokenWords, type Clock } from './automationsUi';

const RUN = 'grid min-h-7 grid-cols-[14px_96px_minmax(0,1fr)_auto] items-center gap-2 text-mini text-app-text-body @max-2xl:min-h-9';
const PRE = 'm-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-app-border-subtle bg-app-inset p-2 font-mono text-mini text-app-text-body';

function RunMark({ outcome }: { outcome: RunOutcome | null | 'running' }) {
  if (outcome === 'error') return <CircleX size={13} className={DANGER_TEXT} />;
  if (outcome === 'ok') return <CircleCheck size={13} className={SUCCESS_TEXT} />;
  return <CircleCheck size={13} className="text-app-text-faint" />;
}

const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', discord: 'Discord', telegram: 'Telegram' };

/** One run of a Jarvis job: a line, and when it has more to say a fold that opens on the rest. */
function CronRunRow({ r, now, clock }: { r: CronRun; now: number; clock: Clock }) {
  const tr = useT();
  const locale = useLocale();
  const said = r.wrote
    ? (r.wrote.channel && CHANNEL[r.wrote.channel] ? tr('auto.run.wroteOn', { channel: CHANNEL[r.wrote.channel]! }) : tr('auto.run.wrote'))
    : r.whyNot ? tr('auto.run.wroteNot', { why: r.whyNot }) : null;
  const head = (
    <>
      <RunMark outcome={r.outcome} />
      <span className="truncate text-app-text-muted">{runWhen(r.at, now, clock, tr)}{r.manual ? ` · ${tr('auto.run.manual')}` : ''}</span>
      <span className="min-w-0 truncate">
        {said && <span className={`mr-1.5 ${r.wrote ? 'text-primary' : 'text-app-text-muted'}`} data-testid="automation-run-said">{said}</span>}
        {r.text ? noIds(r.text) : !said ? tr(`auto.run.${r.outcome ?? 'skipped'}`) : ''}
      </span>
      <span className={`font-mono text-mini ${r.outcome === 'error' ? DANGER_TEXT : 'text-app-text-muted'}`}>{r.ms !== null ? secondsWords(r.ms, locale) : ''}</span>
    </>
  );
  const more = r.output || r.error || r.report || r.model;
  if (!more) return <div className={`${RUN} border-t border-app-border-subtle first:border-t-0`} data-testid="automation-run-row" data-outcome={r.outcome ?? 'none'}>{head}</div>;
  return (
    <details className="group border-t border-app-border-subtle first:border-t-0" data-testid="automation-run-row" data-outcome={r.outcome ?? 'none'}>
      <summary className={`${RUN} cursor-pointer list-none`}>{head}</summary>
      <div className="mb-2 ml-[22px] flex flex-col gap-1.5" data-testid="automation-run-more">
        {r.output && <div><span className="text-app-text-muted">{tr('auto.run.output')}</span><pre className={PRE}>{noIds(r.output, true)}</pre></div>}
        {r.error && <div><span className={DANGER_TEXT}>{tr('auto.run.errorFull')}</span><pre className={PRE} data-testid="automation-run-error">{noIds(r.error, true)}</pre></div>}
        {r.report && <div><span className="text-app-text-muted">{tr('auto.run.report')} <i className="font-mono not-italic text-app-text-faint">{r.report.path}</i></span><pre className={PRE} data-testid="automation-run-report">{r.report.text}</pre></div>}
        {r.model && (
          <p className="m-0 text-app-text-secondary" data-testid="automation-run-model">
            {tr('auto.run.model')}: {prettyModel(r.model)}{r.tokens !== null ? ` · ${tr('auto.run.tokens', { n: tokenWords(r.tokens, locale) })}` : ''}
          </p>
        )}
      </div>
    </details>
  );
}

export function RunsPart({ row, now, clock, part, partTitle, partRest }: { row: AutomationRow; now: number; clock: Clock; part: string; partTitle: string; partRest: string }) {
  const tr = useT();
  const locale = useLocale();
  const [runs, setRuns] = useState<CronRun[] | null | 'reading'>(row.jobId ? 'reading' : null);
  const read = useCallback(() => {
    if (!row.jobId) return () => {};
    let alive = true;
    setRuns('reading');
    apiFetch(`/api/hub/automations/runs?key=${encodeURIComponent(row.key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((b: unknown) => { if (alive) setRuns(readCronRuns(b)); });
    return () => { alive = false; };
  }, [row.key, row.jobId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the read starts when the detail opens; the state is set when the fetch resolves
  useEffect(() => read(), [read]);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = todayRuns(row.day, start.getTime());
  const cron = Array.isArray(runs) ? runs : null;
  const sum = cron ? runsSummary(cron) : null;
  const rest = sum
    ? [tr('auto.runs.last', { n: cron!.length }), sum.failed ? tr(sum.failed === 1 ? 'auto.runs.failedOne' : 'auto.runs.failedMany', { n: sum.failed }) : null,
      tr(sum.wrote === 1 ? 'auto.runs.wroteOne' : 'auto.runs.wroteMany', { n: sum.wrote })].filter(Boolean).join(' · ')
    : today.total > 0 ? tr('auto.runs.today', { n: today.total, ok: today.ok }) : '';
  const other: Array<{ at: number; outcome: RunOutcome | 'running'; text: string | null; ms: number | null; runId?: string }> =
    row.workflowRuns.length > 0
      ? row.workflowRuns.map((r) => ({ at: r.at, outcome: r.outcome, text: r.agents !== null ? tr('auto.run.agents', { n: r.agents }) : null, ms: r.durationMs, runId: r.runId }))
      : row.day.slice(0, 10).map((d) => ({ at: d.at, outcome: d.outcome, text: null, ms: null }));
  return (
    <div className={part} data-testid="automation-runs">
      <h3 className={partTitle}>
        {tr('auto.runs.title')}
        {rest && <span className={partRest} data-testid="automation-runs-summary">{rest}</span>}
      </h3>
      {runs === 'reading' && <p className="m-0 mb-1 text-mini text-app-text-muted">{tr('auto.runs.reading')}</p>}
      {row.jobId && runs === null && (
        <p className="m-0 mb-1 flex items-center gap-2 text-mini text-app-text-muted" data-testid="automation-runs-failed">
          <span className="min-w-0 flex-1">{tr('auto.runs.failed')}</span>
          <button type="button" className={BUTTON} onClick={() => { read(); }} data-testid="automation-runs-retry">{tr('auto.retry')}</button>
        </p>
      )}
      {cron ? (
        cron.length === 0 ? <p className="m-0 text-mini text-app-text-muted">{tr('auto.runs.none')}</p> : (
          <div className="flex flex-col tabular-nums">{cron.map((r) => <CronRunRow key={r.at} r={r} now={now} clock={clock} />)}</div>
        )
      ) : runs !== 'reading' && (
        other.length === 0 ? <p className="m-0 text-mini text-app-text-muted">{tr('auto.runs.none')}</p> : (
          <div className="flex flex-col tabular-nums">
            {other.map((r) => (
              <div key={`${r.at}-${r.runId ?? ''}`} className={`${RUN} border-t border-app-border-subtle first:border-t-0`} data-testid="automation-run-row" data-outcome={r.outcome}>
                <RunMark outcome={r.outcome} />
                <span className="truncate text-app-text-muted">{runWhen(r.at, now, clock, tr)}</span>
                <span className="truncate">{r.runId ? <RunCost runId={r.runId} fallback={r.text} /> : r.text ?? tr(`auto.run.${r.outcome}`)}</span>
                <span className={`font-mono text-mini ${r.outcome === 'error' ? DANGER_TEXT : 'text-app-text-muted'}`}>
                  {r.ms !== null ? secondsWords(r.ms, locale) : r.outcome === 'running' ? tr('auto.run.running') : ''}
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** A workflow run's cost, read only when asked: the hub reads its agents' transcripts for it. */
function RunCost({ runId, fallback }: { runId: string; fallback: string | null }) {
  const tr = useT();
  const locale = useLocale();
  const [cost, setCost] = useState<string | null>(null);
  if (cost !== null) return <span data-testid="automation-run-cost">{cost}</span>;
  return (
    <button
      type="button"
      className="truncate text-left text-app-text-body underline decoration-app-border underline-offset-2 hover:text-app-text"
      data-testid="automation-run-cost-ask"
      onClick={() => {
        void apiFetch(`/api/hub/automations/run/${encodeURIComponent(runId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((b: unknown) => {
            const c = readRunCost(b);
            if (!c) { setCost(tr('auto.run.costNone')); return; }
            setCost(c.weekPct === null
              ? tr('auto.run.costAgents', { agents: c.agents })
              : tr('auto.run.costValue', { agents: c.agents, pct: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(c.weekPct) }));
          });
      }}
    >
      {fallback ? `${fallback} · ` : ''}{tr('auto.run.cost')}
    </button>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
