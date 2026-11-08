/**
 * ONE AUTOMATION, OPENED: its state and the sources behind it, what it is and
 * when it runs with every fact the hub knows (AutomationFacts), the commands
 * of a Jarvis job, «Risolvi tu» on what is broken or waits on you, your
 * vote and your notes (HUBBR-15), its scheme step by step, its runs and the
 * technical details. Beside the list on a wide pane, as a sheet from the
 * bottom on a narrow one.
 *
 * Votes and notes are written to the hub's feedback log and the section then
 * shows the model as the hub reads it back: a vote that did not land does not
 * look pressed. For 5 seconds after each one the undo button takes it back. The
 * letters v c n s m vote from the keyboard, as on the hub.
 *
 * A workflow step waiting for your ok carries neither the fix button nor the
 * link to write to Jarvis: no agent can give that ok.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, BellOff, CircleCheck, CircleX, Hand, MessageCircle, MessageSquare, Play, ThumbsDown, ThumbsUp, Trash2, Undo2, WandSparkles, X, Flag, PenLine,
} from 'lucide-react';
import { useT } from '../../hooks/useT';
import { automationJarvisText, jarvisHref } from '../../lib/hubSystem';
import { useJarvisLinks } from '../../hooks/useJarvisLinks';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { FEEDBACK_NEEDS_TEXT, feedbackBody, type AutomationRow, type FeedbackAction, type JobCommand } from '../../lib/automations';
import type { FeedbackResult } from './useAutomationsData';
import { BUTTON, BUTTON_ON, BUTTON_PRIMARY, SYSTEM_ICON, type Clock } from './automationsUi';
import { Facts, TechPart } from './AutomationFacts';
import { GraphPart } from './AutomationGraphPart';
import { RunsPart } from './AutomationRunsPart';
import { ProjectMark } from './AutomationMarks';

/** How long the undo button stays after a vote, a note or a silence. */
const UNDO_MS = 5_000;

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
  /** The gate's sentence when it holds an agent sent on this automation. */
  brake: string | null;
  onClose(): void;
  onCommand(c: JobCommand): void;
  feedback(body: Record<string, unknown>): Promise<FeedbackResult>;
  undo(ref: string): Promise<string | null>;
  fix(key: string): Promise<{ ok: boolean; already: boolean; why: string | null }>;
}

export function AutomationDetail({ row, now, clock, hubDown, gatewayDown, fixing, brake, onClose, onCommand, feedback, undo, fix }: DetailProps) {
  const tr = useT();
  const Icon = SYSTEM_ICON[row.system];
  const status = row.enabled === false
    ? { tone: 'text-app-text-secondary', text: tr('auto.status.off'), icon: <BellOff size={13} /> }
    : row.level === 'va' && row.warn
      ? { tone: WARNING_TEXT, text: row.warn, icon: <AlertTriangle size={13} /> }
      : row.level === 'va'
        ? { tone: SUCCESS_TEXT, text: tr('auto.status.ok'), icon: <CircleCheck size={13} /> }
        : {
        tone: row.level === 'rotto' ? DANGER_TEXT : WARNING_TEXT,
        text: row.since !== null && row.reason ? tr('auto.status.since', { reason: row.reason, time: clock.dayTime(row.since) }) : row.reason ?? '',
        icon: row.level === 'rotto' ? <CircleX size={13} /> : row.gate ? <Hand size={13} /> : <AlertTriangle size={13} />,
      };
  const chip = row.level === 'rotto' ? { cls: `bg-red-500/10 ${DANGER_TEXT}`, text: tr('auto.level.rotto') }
    : row.level === 'te' ? { cls: `bg-amber-500/10 ${WARNING_TEXT}`, text: tr('auto.level.te') }
      : { cls: `bg-emerald-500/10 ${SUCCESS_TEXT}`, text: tr('auto.level.va') };
  const off = gatewayDown || row.enabled === null;
  return (
    <div data-testid="automation-detail" data-key={row.key} className="flex min-h-0 flex-col">
      <div className={PART}>
        <div className="flex items-center gap-2 text-mini text-app-text-muted">
          <span className={`rounded-xs px-1.5 py-px text-mini font-medium ${chip.cls}`} data-testid="automation-level">{chip.text}</span>
          <Icon size={13} aria-hidden="true" />
          <span data-testid="automation-source">{tr(`auto.source.${row.system}`)}{row.sources.length > 1 ? ` · ${tr('auto.sources', { n: row.sources.length })}` : ''}</span>
          <button type="button" onClick={onClose} aria-label={tr('auto.close')} title={tr('auto.close')} className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-xs text-app-text-muted hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11" data-testid="automation-detail-close">
            <X size={14} />
          </button>
        </div>
        <h2 className="m-0 mb-0.5 mt-2 flex items-center gap-1.5 text-title font-semibold text-app-text-heading"><ProjectMark project={row.project} />{row.title}</h2>
        <div className={`flex items-start gap-1.5 text-compact ${status.tone}`} data-testid="automation-status">
          <span className="mt-0.5 flex-none">{status.icon}</span><span>{status.text}</span>
        </div>
        {brake && <p className="m-0 mt-1 text-mini text-primary" data-testid="automation-detail-brake">{brake}</p>}
        <Facts row={row} now={now} clock={clock} />
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
      {row.votable && row.level !== 'va' && !row.gate && <FixPart row={row} fixing={fixing} disabled={hubDown} fix={fix} />}
      {row.gate && <p className={`${PART} m-0 text-mini text-app-text-secondary`} data-testid="automation-gate">{tr('auto.gate.note')}</p>}
      {row.votable && <VotePart key={row.key} row={row} clock={clock} disabled={hubDown} feedback={feedback} undo={undo} />}
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
      <GraphPart key={`g-${row.key}`} row={row} clock={clock} part={PART} partTitle={PART_TITLE} partRest={PART_REST} />
      <RunsPart key={`r-${row.key}`} row={row} now={now} clock={clock} part={PART} partTitle={PART_TITLE} partRest={PART_REST} />
      <TechPart row={row} part={PART} partTitle={PART_TITLE} />
    </div>
  );
}

function FixPart({ row, fixing, disabled, fix }: { row: AutomationRow; fixing: boolean; disabled: boolean; fix: DetailProps['fix'] }) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const jarvis = jarvisHref(useJarvisLinks(), automationJarvisText(row.title, row.key, row.reason));
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
          {jarvis && (
            <a href={jarvis} target="_blank" rel="noopener noreferrer" className={BUTTON} data-testid="automation-jarvis">
              <MessageCircle size={13} />{tr('auto.jarvis')}
            </a>
          )}
          <span className="text-mini text-app-text-muted" data-testid="automation-fix-said">{said ?? tr('auto.fix.where')}</span>
        </div>
      </div>
    </div>
  );
}

const VOTES: Array<{ action: FeedbackAction; icon: typeof ThumbsUp; key: string }> = [
  { action: 'ok', icon: ThumbsUp, key: 'v' },
  { action: 'cambia', icon: ThumbsDown, key: 'c' },
  { action: 'nota', icon: PenLine, key: 'n' },
  { action: 'segnala', icon: Flag, key: 's' },
  { action: 'muta', icon: BellOff, key: 'm' },
];

function VotePart({ row, clock, disabled, feedback, undo }: { row: AutomationRow; clock: Clock; disabled: boolean; feedback: DetailProps['feedback']; undo: DetailProps['undo'] }) {
  const tr = useT();
  const [open, setOpen] = useState<FeedbackAction | null>(null);
  const [text, setText] = useState('');
  const [days, setDays] = useState<number | null>(7);
  const [state, setState] = useState<{ busy: boolean; said: string | null; bad: boolean }>({ busy: false, said: null, bad: false });
  const [undoRef, setUndoRef] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const vote = row.feedback.vote;
  const mute = row.feedback.mute;
  const pressed = (a: FeedbackAction) => ((a === 'ok' || a === 'cambia') && vote?.v === a) || (a === 'muta' && mute !== null);
  useEffect(() => {
    if (!undoRef) return;
    const t = window.setTimeout(() => setUndoRef(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undoRef]);
  const submit = async (action: FeedbackAction) => {
    const body = feedbackBody(action, row, text, Date.now(), days);
    if (!body) return;
    setState({ busy: true, said: tr('auto.saving'), bad: false });
    setUndoRef(null);
    const r = await feedback(body);
    setState({ busy: false, said: r.error ? tr('auto.saveFailed', { why: r.error }) : tr('auto.saved'), bad: r.error !== null });
    if (!r.error) { setOpen(null); setText(''); setUndoRef(r.ref); }
  };
  const press = (action: FeedbackAction) => {
    if (FEEDBACK_NEEDS_TEXT.has(action)) { setOpen((o) => (o === action ? null : action)); return; }
    void submit(action);
  };
  // The vote letters, as on the hub: only with the focus in the view (or nowhere), never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const pane = root.current?.closest('[data-testid="automations-pane"]');
      if (t && t !== document.body && !pane?.contains(t)) return;
      const v = VOTES.find((x) => x.key === e.key.toLowerCase());
      if (!v) return;
      e.preventDefault();
      press(v.action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const lines = [
    vote ? tr('auto.vote.said', { vote: tr(vote.v === 'ok' ? 'auto.vote.ok' : 'auto.vote.cambia').toLowerCase(), date: vote.at ? clock.date(Date.parse(vote.at)) : '' }) + (vote.note ? `: «${vote.note}»` : '') : null,
    row.feedback.changedSinceVote ? tr('auto.vote.changed') : null,
    row.feedback.open > 0 ? tr(row.feedback.open === 1 ? 'auto.vote.openOne' : 'auto.vote.open', { n: row.feedback.open }) : null,
  ].filter((x): x is string => !!x);
  return (
    <div className={PART} data-testid="automation-votes" ref={root}>
      <h3 className={PART_TITLE}>
        {tr('auto.vote.title')}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {VOTES.map(({ action, icon: I, key }) => (
          <button
            key={action}
            type="button"
            disabled={disabled || state.busy}
            aria-pressed={pressed(action)}
            aria-keyshortcuts={key}
            data-testid={`automation-vote-${action}`}
            className={`${BUTTON} ${pressed(action) ? BUTTON_ON : ''}`}
            onClick={() => press(action)}
          >
            <I size={13} />{tr(`auto.vote.${action}`)}
            <kbd aria-hidden="true" className="rounded-xs border border-app-border-subtle px-1 text-mini uppercase text-app-text-faint coarse:hidden">{key}</kbd>
          </button>
        ))}
      </div>
      {lines.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5 text-mini text-app-text-secondary" data-testid="automation-vote-lines">
          {lines.map((l) => <span key={l}>{l}</span>)}
        </div>
      )}
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
      {state.said && (
        <p role="status" className={`m-0 mt-2 flex items-center gap-2 text-mini ${state.bad ? DANGER_TEXT : 'text-app-text-muted'}`}>
          <span data-testid="automation-vote-said">{state.said}</span>
          {undoRef && (
            <button
              type="button"
              className={BUTTON}
              data-testid="automation-vote-undo"
              onClick={() => {
                const ref = undoRef;
                setUndoRef(null);
                setState({ busy: true, said: tr('auto.saving'), bad: false });
                void undo(ref).then((why) => setState({ busy: false, said: why ? tr('auto.saveFailed', { why }) : tr('auto.undone'), bad: why !== null }));
              }}
            >
              <Undo2 size={13} />{tr('auto.undo')}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
