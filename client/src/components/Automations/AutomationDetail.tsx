/**
 * ONE AUTOMATION, OPENED: what it is and when it runs, the commands of an
 * OpenClaw job, «Risolvi tu» on what is broken or waits on you, your vote and
 * your notes (HUBBR-15), and its runs. Beside the list on a wide pane, as a
 * sheet from the bottom on a narrow one.
 *
 * Votes and notes are written to the hub's feedback log and the section then
 * shows the model as the hub reads it back: a vote that did not land does not
 * look pressed.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle, BellOff, CircleCheck, CircleX, MessageSquare, Play, ThumbsDown, ThumbsUp, Trash2, WandSparkles, X, Flag, PenLine,
} from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import {
  FEEDBACK_NEEDS_TEXT, feedbackBody, readCronRuns, readRunCost, todayRuns,
  type AutomationRow, type CronRun, type FeedbackAction, type JobCommand,
} from '../../lib/automations';
import { BUTTON, BUTTON_ON, BUTTON_PRIMARY, SYSTEM_ICON, durationWords, runWhen, secondsWords, type Clock } from './automationsUi';

const PART = 'border-b border-app-border-subtle px-4 py-3 last:border-b-0';
const PART_TITLE = 'mb-2 flex items-center gap-1.5 text-mini font-semibold uppercase tracking-[0.04em] text-app-text-tertiary';
const PART_REST = 'ml-auto font-normal normal-case tracking-normal text-app-text-muted tabular-nums';

interface DetailProps {
  row: AutomationRow;
  now: number;
  clock: Clock;
  hubDown: boolean;
  gatewayDown: boolean;
  fixing: boolean;
  onClose(): void;
  onCommand(c: JobCommand): void;
  feedback(body: Record<string, unknown>): Promise<string | null>;
  fix(key: string): Promise<{ ok: boolean; already: boolean; why: string | null }>;
}

export function AutomationDetail({ row, now, clock, hubDown, gatewayDown, fixing, onClose, onCommand, feedback, fix }: DetailProps) {
  const tr = useT();
  const Icon = SYSTEM_ICON[row.system];
  const status = row.enabled === false
    ? { tone: 'text-app-text-secondary', text: tr('auto.status.off'), icon: <BellOff size={13} /> }
    : row.level === 'va'
      ? { tone: SUCCESS_TEXT, text: tr('auto.status.ok'), icon: <CircleCheck size={13} /> }
      : {
        tone: row.level === 'rotto' ? DANGER_TEXT : WARNING_TEXT,
        text: row.since !== null && row.reason ? tr('auto.status.since', { reason: row.reason, time: clock.dayTime(row.since) }) : row.reason ?? '',
        icon: row.level === 'rotto' ? <CircleX size={13} /> : <AlertTriangle size={13} />,
      };
  const off = gatewayDown || row.enabled === null;
  return (
    <div data-testid="automation-detail" data-key={row.key} className="flex min-h-0 flex-col">
      <div className={PART}>
        <div className="flex items-center gap-2 text-mini text-app-text-muted">
          <Icon size={13} aria-hidden="true" />
          <span>{tr(`auto.source.${row.system}`)}</span>
          <button type="button" onClick={onClose} aria-label={tr('auto.close')} title={tr('auto.close')} className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-xs text-app-text-muted hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11" data-testid="automation-detail-close">
            <X size={14} />
          </button>
        </div>
        <h2 className="m-0 mb-0.5 mt-2 text-title font-semibold text-app-text-heading">{row.title}</h2>
        <div className={`flex items-start gap-1.5 text-compact ${status.tone}`} data-testid="automation-status">
          <span className="mt-0.5 flex-none">{status.icon}</span><span>{status.text}</span>
        </div>
        <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-mini">
          {row.when && <><dt className="text-app-text-muted">{tr('auto.facts.when')}</dt><dd className="m-0 text-app-text-body">{row.when}</dd></>}
          {row.what && <><dt className="text-app-text-muted">{tr('auto.facts.what')}</dt><dd className="m-0 text-app-text-body">{row.what}</dd></>}
          {row.next !== null && row.next > now && row.enabled !== false && (
            <><dt className="text-app-text-muted">{tr('auto.facts.next')}</dt><dd className="m-0 tabular-nums text-app-text-body">{tr('auto.facts.nextIn', { time: clock.dayTime(row.next), dur: durationWords(row.next - now, tr) })}</dd></>
          )}
        </dl>
        {row.jobId !== null && (
          <div className="mt-3 flex flex-wrap gap-1.5" data-testid="automation-detail-commands">
            <button type="button" className={`${BUTTON} @max-2xl:flex-1`} disabled={off} onClick={() => onCommand({ kind: 'run' })} data-testid="automation-detail-run">
              <Play size={13} />{tr('auto.cmd.run')}
            </button>
            <span className={`${BUTTON} gap-1 @max-2xl:flex-1 ${off ? 'opacity-50' : ''}`}>
              <Switch checked={row.enabled !== false} disabled={off} label={tr('auto.cmd.toggle', { title: row.title })} testId="automation-detail-toggle" onChange={(on) => onCommand({ kind: 'enable', on })} />
              {row.enabled === false ? tr('auto.cmd.offLabel') : tr('auto.cmd.on')}
            </span>
            <button type="button" className={`${BUTTON} @max-2xl:flex-1 ${DANGER_TEXT}`} disabled={off} onClick={() => onCommand({ kind: 'remove' })} data-testid="automation-detail-remove">
              <Trash2 size={13} />{tr('auto.cmd.remove')}
            </button>
          </div>
        )}
      </div>
      {row.votable && row.level !== 'va' && <FixPart row={row} fixing={fixing} disabled={hubDown} fix={fix} />}
      {row.votable && <VotePart key={row.key} row={row} clock={clock} disabled={hubDown} feedback={feedback} />}
      {row.feedback.notes.length > 0 && (
        <div className={PART} data-testid="automation-notes">
          <h3 className={PART_TITLE}><MessageSquare size={12} />{tr('auto.notes.title')}<span className={PART_REST}>{row.feedback.notes.length}</span></h3>
          <div className="flex flex-col gap-1.5">
            {row.feedback.notes.map((n, i) => (
              <div key={i} className="min-h-[52px] rounded-sm border border-app-border-input bg-app-input px-2.5 py-2 text-compact leading-[1.45] text-app-text-body" data-testid="automation-note">
                {n.note}
                <span className="mt-1 block text-mini tabular-nums text-app-text-muted">
                  {n.kind === 'complaint' ? `${tr('auto.notes.complaint')} · ` : ''}{n.at ? clock.date(Date.parse(n.at)) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <RunsPart row={row} now={now} clock={clock} />
    </div>
  );
}

function FixPart({ row, fixing, disabled, fix }: { row: AutomationRow; fixing: boolean; disabled: boolean; fix: DetailProps['fix'] }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className={PART} data-testid="automation-fix">
      <h3 className={PART_TITLE}><WandSparkles size={12} />{tr('auto.fix.title')}</h3>
      <div className="rounded bg-primary/10 px-3 py-2.5">
        <p className="m-0 text-compact leading-[1.45] text-app-text">{row.reason}</p>
        <p className="m-0 mt-1 text-mini text-app-text-secondary">{tr('auto.fix.hint')}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {fixing && !said ? (
            <span className="text-compact text-primary" data-testid="automation-fix-state">{tr('auto.fix.already')}</span>
          ) : (
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={busy || disabled || said !== null}
              data-testid="automation-fix-go"
              onClick={() => {
                setBusy(true);
                void fix(row.key).then((r) => setSaid(r.ok ? tr(r.already ? 'auto.fix.already' : 'auto.fix.queued') : tr('auto.fix.failed', { why: r.why ?? '' }))).finally(() => setBusy(false));
              }}
            >
              <WandSparkles size={13} />{tr('auto.fix.go')}
            </button>
          )}
          <span className="text-mini text-app-text-muted" data-testid="automation-fix-said">{said ?? tr('auto.fix.where')}</span>
        </div>
      </div>
    </div>
  );
}

const VOTES: Array<{ action: FeedbackAction; icon: typeof ThumbsUp }> = [
  { action: 'ok', icon: ThumbsUp },
  { action: 'cambia', icon: ThumbsDown },
  { action: 'nota', icon: PenLine },
  { action: 'segnala', icon: Flag },
  { action: 'muta', icon: BellOff },
];

function VotePart({ row, clock, disabled, feedback }: { row: AutomationRow; clock: Clock; disabled: boolean; feedback: DetailProps['feedback'] }) {
  const tr = useT();
  const [open, setOpen] = useState<FeedbackAction | null>(null);
  const [text, setText] = useState('');
  const [days, setDays] = useState<number | null>(7);
  const [state, setState] = useState<{ busy: boolean; said: string | null; bad: boolean }>({ busy: false, said: null, bad: false });
  const vote = row.feedback.vote;
  const mute = row.feedback.mute;
  const pressed = (a: FeedbackAction) => ((a === 'ok' || a === 'cambia') && vote?.v === a) || (a === 'muta' && mute !== null);
  const submit = async (action: FeedbackAction) => {
    const body = feedbackBody(action, row, text, Date.now(), days);
    if (!body) return;
    setState({ busy: true, said: tr('auto.saving'), bad: false });
    const why = await feedback(body);
    setState({ busy: false, said: why ? tr('auto.saveFailed', { why }) : tr('auto.saved'), bad: why !== null });
    if (!why) { setOpen(null); setText(''); }
  };
  return (
    <div className={PART} data-testid="automation-votes">
      <h3 className={PART_TITLE}>
        {tr('auto.vote.title')}
        <span className={PART_REST}>{vote?.at ? tr('auto.vote.given', { date: clock.date(Date.parse(vote.at)) }) : ''}</span>
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {VOTES.map(({ action, icon: I }) => (
          <button
            key={action}
            type="button"
            disabled={disabled || state.busy}
            aria-pressed={pressed(action)}
            data-testid={`automation-vote-${action}`}
            className={`${BUTTON} ${pressed(action) ? BUTTON_ON : ''}`}
            onClick={() => {
              if (FEEDBACK_NEEDS_TEXT.has(action)) { setOpen(open === action ? null : action); return; }
              void submit(action);
            }}
          >
            <I size={13} />{tr(`auto.vote.${action}`)}
          </button>
        ))}
      </div>
      {mute && (
        <p className="m-0 mt-2 text-mini text-app-text-secondary" data-testid="automation-muted">
          {mute.until ? tr('auto.muted.until', { date: clock.date(Date.parse(mute.until)) }) : tr('auto.muted.never')}
        </p>
      )}
      {open && (
        <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(open); }} data-testid="automation-vote-form">
          {open === 'muta' && (
            <div className="flex flex-wrap gap-3 text-compact text-app-text-body">
              {([7, 30, null] as const).map((d) => (
                <label key={String(d)} className="inline-flex items-center gap-1.5">
                  <input type="radio" name="mute-days" checked={days === d} onChange={() => setDays(d)} />
                  {tr(d === null ? 'auto.mute.never' : `auto.mute.${d}`)}
                </label>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(open); }
              if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); }
            }}
            placeholder={tr(`auto.ph.${open}`)}
            data-testid="automation-vote-text"
            className="w-full resize-none rounded-sm border border-app-border-input bg-app-input px-2.5 py-2 text-compact text-app-text outline-none placeholder:text-app-placeholder focus:border-primary"
          />
          <div className="flex gap-1.5">
            <button type="submit" className={BUTTON_PRIMARY} disabled={!text.trim() || state.busy} data-testid="automation-vote-save">{tr('auto.save')}</button>
            <button type="button" className={BUTTON} onClick={() => setOpen(null)}>{tr('auto.cancel')}</button>
          </div>
        </form>
      )}
      {state.said && <p role="status" className={`m-0 mt-2 text-mini ${state.bad ? DANGER_TEXT : 'text-app-text-muted'}`} data-testid="automation-vote-said">{state.said}</p>}
    </div>
  );
}

function RunMark({ outcome }: { outcome: CronRun['outcome'] | 'running' }) {
  if (outcome === 'error') return <CircleX size={13} className={DANGER_TEXT} />;
  if (outcome === 'ok') return <CircleCheck size={13} className={SUCCESS_TEXT} />;
  return <CircleCheck size={13} className="text-app-text-faint" />;
}

const RUN = 'grid h-7 grid-cols-[14px_96px_minmax(0,1fr)_auto] items-center gap-2 border-t border-app-border-subtle text-mini text-app-text-body first:border-t-0 @max-2xl:h-9';

function RunsPart({ row, now, clock }: { row: AutomationRow; now: number; clock: Clock }) {
  const tr = useT();
  const locale = useLocale();
  const [runs, setRuns] = useState<CronRun[] | null | 'reading'>(row.jobId ? 'reading' : null);
  useEffect(() => {
    if (!row.jobId) return;
    let alive = true;
    apiFetch(`/api/hub/automations/runs?key=${encodeURIComponent(row.key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((b: unknown) => { if (alive) setRuns(readCronRuns(b)); });
    return () => { alive = false; };
  }, [row.key, row.jobId]);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = todayRuns(row.day, start.getTime());
  const list: Array<{ at: number; outcome: CronRun['outcome'] | 'running'; text: string | null; ms: number | null; runId?: string }> =
    row.workflowRuns.length > 0
      ? row.workflowRuns.map((r) => ({ at: r.at, outcome: r.outcome, text: r.agents !== null ? tr('auto.run.agents', { n: r.agents }) : null, ms: r.durationMs, runId: r.runId }))
      : Array.isArray(runs) ? runs : row.day.slice(0, 10).map((d) => ({ at: d.at, outcome: d.outcome, text: null, ms: null }));
  return (
    <div className={PART} data-testid="automation-runs">
      <h3 className={PART_TITLE}>
        {tr('auto.runs.title')}
        {today.total > 0 && <span className={PART_REST}>{tr('auto.runs.today', { n: today.total, ok: today.ok })}</span>}
      </h3>
      {runs === 'reading' && <p className="m-0 mb-1 text-mini text-app-text-muted">{tr('auto.runs.reading')}</p>}
      {row.jobId && runs === null && <p className="m-0 mb-1 text-mini text-app-text-muted">{tr('auto.runs.failed')}</p>}
      {list.length === 0 && runs !== 'reading' ? (
        <p className="m-0 text-mini text-app-text-muted">{tr('auto.runs.none')}</p>
      ) : (
        <div className="flex flex-col tabular-nums">
          {list.map((r) => (
            <div key={`${r.at}-${r.runId ?? ''}`} className={RUN} data-testid="automation-run-row" data-outcome={r.outcome ?? 'none'}>
              <RunMark outcome={r.outcome} />
              <span className="truncate text-app-text-muted">{runWhen(r.at, now, clock, tr)}</span>
              <span className="truncate">{r.runId ? <RunCost runId={r.runId} fallback={r.text} /> : r.text ?? tr(`auto.run.${r.outcome ?? 'skipped'}`)}</span>
              <span className={`font-mono text-mini ${r.outcome === 'error' ? DANGER_TEXT : 'text-app-text-muted'}`}>
                {r.ms !== null ? secondsWords(r.ms, locale) : r.outcome === 'running' ? tr('auto.run.running') : ''}
              </span>
            </div>
          ))}
        </div>
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
