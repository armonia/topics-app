/**
 * The scheme of one automation, in its detail: what really happens on a run,
 * step by step, as the hub reads it from the definition, the script and the
 * log. Each step says its kind (when, reads, step, answers, delivers), its
 * outcome and time; the model step tells who answered and why, the queue of
 * models behind it and what happens if it fails; behind a fold, what it was
 * asked, what it answered, its error and the exact command.
 *
 * Read when the detail opens (`/api/hub/automations/graph`); a read that
 * fails offers «Riprova», a row with no scheme shows nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { modelStory, readGraph, type AutomationGraph, type GraphNode, type GraphOption, type GraphOutcome } from '../../lib/automationGraph';
import { prettyModel } from '../../lib/automationRuns';
import { BUTTON, secondsWords, tokenWords, type Clock } from './automationsUi';
import { BrandMark } from './AutomationMarks';

const PRE = 'm-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-app-border-subtle bg-app-inset p-2 font-mono text-mini text-app-text-body';
const TONE: Record<GraphOutcome, string> = { ok: SUCCESS_TEXT, error: DANGER_TEXT, skipped: 'text-app-text-muted', unused: 'text-app-text-faint' };

function optionName(o: GraphOption, all: GraphOption[], tr: ReturnType<typeof useT>): string {
  const pretty = o.model ? prettyModel(o.model) : o.name ?? tr('auto.graph.model');
  const name = o.name && !pretty.toLowerCase().startsWith(o.name.toLowerCase()) ? `${o.name} ${pretty}` : pretty;
  // The account matters only when the queue repeats the same model on several accounts.
  if (!o.account || all.filter((x) => x.model === o.model).length < 2) return name;
  const acc = o.account.replace(/^anthropic-?/, '');
  return `${name} ${acc ? tr('auto.graph.account', { account: acc }) : tr('auto.graph.mainAccount')}`;
}

function Outcome({ outcome, inferred, ms }: { outcome: GraphOutcome | null; inferred?: boolean; ms?: number | null }) {
  const tr = useT();
  const locale = useLocale();
  return (
    <span className="ml-auto inline-flex flex-none items-center gap-1.5 tabular-nums">
      <span className={outcome ? TONE[outcome] : 'text-app-text-faint'} title={inferred ? tr('auto.graph.inferred') : undefined}>
        {outcome ? tr(`auto.graph.out.${outcome}`) : '-'}{inferred ? '*' : ''}
      </span>
      {ms != null && <span className="text-app-text-muted">{secondsWords(ms, locale)}</span>}
    </span>
  );
}

function ModelBody({ n }: { n: GraphNode }) {
  const tr = useT();
  const locale = useLocale();
  const s = modelStory(n);
  const name = (o: GraphOption) => optionName(o, n.options, tr);
  const did = (o: GraphOption) => tr(`auto.graph.did.${o.outcome ?? 'none'}`);
  const why = s.kind === 'noneAnswered' ? s.tried.map((o) => `${name(o)} ${did(o)}${o.note ? ` (${o.note})` : ''}`).join(', ')
    : s.kind === 'likely' ? tr('auto.graph.likelyWhy')
      : s.kind === 'answered' ? (s.before.length === 0
        ? tr(n.options.length > 1 ? 'auto.graph.firstWorked' : 'auto.graph.only')
        : tr('auto.graph.before', { list: s.before.map((o) => `${name(o)} ${did(o)}${o.note ? ` (${o.note})` : ''}`).join(', ') }))
        : '';
  const next = s.winner ? (s.after.length ? tr('auto.graph.after', { who: name(s.winner), list: s.after.map(name).join(', ') })
    : tr(n.options.length > 1 ? 'auto.graph.lastOne' : 'auto.graph.noFallback')) : '';
  return (
    <div className="mt-1 flex flex-col gap-1">
      {why && <p className="m-0 text-app-text-secondary" data-testid="automation-graph-why">{why}</p>}
      {next && <p className="m-0 text-app-text-muted">{next}</p>}
      {n.options.length > 1 && (
        <ol aria-label={tr('auto.graph.queue')} className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="automation-graph-queue">
          {n.options.map((o, i) => (
            <li key={i} className="flex items-center gap-1.5 rounded-sm bg-app-inset px-1.5 py-0.5">
              <BrandMark brand={o.exec} kind="model" />
              <span className="min-w-0 truncate text-app-text-body">{name(o)}</span>
              <span className={`ml-auto flex-none tabular-nums ${o.outcome ? TONE[o.outcome] : 'text-app-text-faint'}`}>
                {n.whoUnknown && o.outcome === 'ok' ? tr('auto.graph.probable') : tr(`auto.graph.q.${o.outcome ?? (n.whoUnknown ? 'unlogged' : 'untried')}`)}
                {o.ms != null ? `, ${secondsWords(o.ms, locale)}` : ''}{o.tokens != null ? `, ${tr('auto.run.tokens', { n: tokenWords(o.tokens, locale) })}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function headOf(n: GraphNode, tr: ReturnType<typeof useT>): string {
  if (n.kind !== 'model') return n.label;
  const s = modelStory(n);
  const who = s.winner ? optionName(s.winner, n.options, tr) : '';
  return tr(`auto.graph.head.${s.kind}`, { who });
}

function Node({ n, clock }: { n: GraphNode; clock: Clock }) {
  const tr = useT();
  const more = !!(n.asked || n.answered || n.error || n.command) || n.kind === 'model';
  return (
    <li className="relative border-l-2 border-app-border-subtle pb-2 pl-3 last:pb-0" data-testid="automation-graph-node" data-kind={n.kind}>
      <span className={`absolute -left-[5px] top-1 h-2 w-2 rounded-full ${n.outcome === 'error' ? 'bg-red-500 dark:bg-red-400' : n.outcome === 'ok' ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-app-border'}`} aria-hidden="true" />
      <div className="flex items-baseline gap-2">
        <span className="w-[62px] flex-none text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary">{tr(`auto.graph.kind.${n.kind}`)}</span>
        <span className="min-w-0 text-app-text">{headOf(n, tr)}</span>
        {n.kind === 'deliver' && <Outcome outcome={n.outcome} />}
        {n.kind === 'deliver' && n.at !== null && <span className="flex-none tabular-nums text-app-text-muted">{clock.time(n.at)}</span>}
        {n.kind === 'step' && <Outcome outcome={n.outcome} inferred={n.inferred} ms={n.ms} />}
      </div>
      <div className="ml-[70px] flex flex-col gap-1">
        {n.params.length > 0 && (
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 text-app-text-secondary">
            {n.params.flatMap((p, i) => [
              <dt key={`k${i}`} className="text-app-text-muted">{p.k}</dt>,
              <dd key={`v${i}`} className="m-0">{p.v}</dd>,
            ])}
          </dl>
        )}
        {n.about && <p className="m-0 text-app-text-secondary">{n.about}</p>}
        {n.notes.length > 0 && <ul className="m-0 list-disc pl-4 text-app-text-muted">{n.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        {n.detail && n.kind !== 'sources' && <p className="m-0 break-words font-mono text-app-text-muted">{n.detail}</p>}
        {n.items.length > 0 && (
          <span className="flex flex-wrap gap-1">{n.items.map((x, i) => <span key={i} title={x.detail ?? undefined} className="rounded-sm border border-app-border-subtle px-1.5 text-app-text-secondary">{x.label}</span>)}</span>
        )}
        {n.kind === 'model' && <ModelBody n={n} />}
        {more && (
          <details className="group" data-testid="automation-graph-more">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-primary">
              <ChevronRight size={12} className="group-open:rotate-90" aria-hidden="true" />
              {tr(n.kind === 'model' ? 'auto.graph.open.model' : n.error ? (n.command ? 'auto.graph.open.errorCmd' : 'auto.graph.open.error') : 'auto.graph.open.cmd')}
            </summary>
            {n.asked && <div><span className="text-app-text-muted">{tr('auto.graph.asked')}</span><pre className={PRE} tabIndex={0}>{n.asked}</pre></div>}
            {n.answered ? <div><span className="text-app-text-muted">{tr('auto.graph.answered')} <i>{n.answeredBy ?? ''}</i></span><pre className={PRE} tabIndex={0}>{n.answered}</pre></div>
              : n.kind === 'model' && <p className="m-0 text-app-text-muted">{tr('auto.graph.notLogged')}</p>}
            {n.error && <div><span className={DANGER_TEXT}>{tr('auto.run.errorFull')}</span><pre className={PRE} tabIndex={0}>{n.error}</pre></div>}
            {n.command && <div><span className="text-app-text-muted">{tr('auto.graph.command')}</span><pre className={PRE} tabIndex={0} data-testid="automation-graph-command">{n.command}</pre></div>}
          </details>
        )}
      </div>
    </li>
  );
}

export function GraphPart({ row, clock, part, partTitle, partRest }: { row: { key: string; votable: boolean }; clock: Clock; part: string; partTitle: string; partRest: string }) {
  const tr = useT();
  const locale = useLocale();
  const [g, setG] = useState<AutomationGraph | null | 'reading' | 'failed'>('reading');
  const read = useCallback(() => {
    let alive = true;
    setG('reading');
    apiFetch(`/api/hub/automations/graph?key=${encodeURIComponent(row.key)}`)
      .then(async (r) => (r.status === 404 ? 'none' : r.ok ? r.json() : 'failed'))
      .catch(() => 'failed')
      .then((b: unknown) => { if (alive) setG(b === 'failed' ? 'failed' : b === 'none' ? null : readGraph(b)); });
    return () => { alive = false; };
  }, [row.key]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the read starts when the detail opens; the state is set when the fetch resolves
  useEffect(() => (row.votable ? read() : undefined), [read, row.votable]);
  if (!row.votable || g === null) return null;
  const run = g !== 'reading' && g !== 'failed' ? g.run : null;
  const rest = run ? [run.at !== null ? clock.dayTime(run.at) : tr('auto.graph.never'), run.ms !== null ? secondsWords(run.ms, locale) : null, run.outcome ? tr(`auto.graph.out.${run.outcome}`) : null].filter(Boolean).join(' · ') : '';
  return (
    <div className={part} data-testid="automation-graph">
      <h3 className={partTitle}>{tr('auto.graph.title')}{rest && <span className={partRest}>{tr('auto.graph.lastRun', { what: rest })}</span>}</h3>
      {g === 'reading' && <p className="m-0 text-mini text-app-text-muted">{tr('auto.graph.reading')}</p>}
      {g === 'failed' && (
        <p className="m-0 flex items-center gap-2 text-mini text-app-text-muted" data-testid="automation-graph-failed">
          <span className="min-w-0 flex-1">{tr('auto.graph.failed')}</span>
          <button type="button" className={BUTTON} onClick={() => { read(); }}>{tr('auto.retry')}</button>
        </p>
      )}
      {g !== 'reading' && g !== 'failed' && (
        <>
          <ol className="m-0 flex list-none flex-col p-0 pl-1 text-mini">{g.nodes.map((n) => <Node key={n.id} n={n} clock={clock} />)}</ol>
          {g.nodes.some((n) => n.kind === 'step' && n.inferred) && <p className={`m-0 mt-1.5 text-mini ${WARNING_TEXT}`}>{tr('auto.graph.inferredNote')}</p>}
          {g.from.length > 0 && <p className="m-0 mt-1 text-mini text-app-text-faint">{tr('auto.graph.from', { list: g.from.join(' · ') })}</p>}
        </>
      )}
    </div>
  );
}
