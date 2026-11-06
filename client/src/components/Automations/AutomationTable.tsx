/**
 * The rows of one section, as a table on a wide pane and as small cards on a
 * narrow one: name (with the project's icon, the brake or the remark of a row
 * in order, where it runs and its steps), the next run, the last 24 hours led
 * by the row's state, the tokens of 7 days, the last run, your vote and, on an
 * OpenClaw job only, the three commands. A launchd or GitHub row says it is
 * read-only instead: nothing here can run or stop it.
 *
 * A row's steps open inside the row (the chevron, or «p» on the row).
 */
import { ChevronRight, CircleX, Hand, ListTree, MessageSquare, Play, ThumbsDown, ThumbsUp, Trash2, BellOff } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { dayStrip, type AutomationRow, type JobCommand, type StripCell } from '../../lib/automations';
import { usageTotal } from '../../lib/automationsHead';
import { ICON_BUTTON, lastRunWords, modelBrands, nextRunWords, providerName, tokenWords, type Clock } from './automationsUi';
import { BrandMark, FlowSteps, ProjectMark } from './AutomationMarks';

const GRID = 'grid grid-cols-[minmax(0,1fr)_96px_166px_62px_86px_44px_82px] items-center gap-x-2.5 px-3 @max-2xl:grid-cols-[minmax(0,1fr)_auto] @max-2xl:gap-y-1.5';

const CELL: Record<StripCell, string> = {
  ok: 'bg-emerald-500/75 dark:bg-emerald-400/70',
  error: 'bg-red-500 dark:bg-red-400',
  skipped: 'bg-app-text-faint/50',
  none: 'bg-app-hover',
  ahead: 'bg-transparent border border-dashed border-app-border-subtle',
  next: 'bg-transparent border border-primary',
};

/**
 * The row's state at the head of its strip: a hand when it waits on you, a
 * cross when broken, otherwise a dot that tells the last run (failed, went
 * well, none yet), so a row the hub keeps in order after a failed run does
 * not look green.
 */
function StateGlyph({ row }: { row: AutomationRow }) {
  const tr = useT();
  if (row.enabled === false) return <span className="h-2 w-2 flex-none rounded-full bg-app-text-faint" title={tr('auto.glyph.off')} data-glyph="off" />;
  if (row.level === 'te') return <Hand size={13} className={`flex-none ${WARNING_TEXT}`} aria-label={tr('auto.glyph.te')} data-glyph="te" />;
  if (row.level === 'rotto') return <CircleX size={13} className={`flex-none ${DANGER_TEXT}`} aria-label={tr('auto.glyph.rotto')} data-glyph="rotto" />;
  const o = row.last.outcome;
  const tone = o === 'error' ? 'bg-red-500 dark:bg-red-400' : o === 'ok' ? 'bg-emerald-500 dark:bg-emerald-400' : 'border border-app-text-faint bg-transparent';
  const word = tr(o === 'error' ? 'auto.glyph.lastFailed' : o === 'ok' ? 'auto.glyph.lastOk' : 'auto.glyph.none');
  return <span role="img" aria-label={word} title={word} className={`h-2 w-2 flex-none rounded-full ${tone}`} data-glyph={o === 'error' ? 'lastFailed' : o === 'ok' ? 'ok' : 'none'} />;
}

export function DayStrip({ row, now, className = '', glyph = false }: { row: AutomationRow; now: number; className?: string; glyph?: boolean }) {
  const tr = useT();
  const strip = dayStrip(row.day, now, row.enabled === false ? null : row.next);
  const label = strip.runs === 0 ? tr('auto.strip.none')
    : `${tr(strip.runs === 1 ? 'auto.strip.runsOne' : 'auto.strip.runs', { n: strip.runs })}${strip.failed ? `, ${tr(strip.failed === 1 ? 'auto.strip.failedOne' : 'auto.strip.failed', { n: strip.failed })}` : ''}`;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${className}`} title={label} data-testid="automation-strip-box">
      {glyph && <StateGlyph row={row} />}
      <span role="img" aria-label={label} className="grid h-3.5 min-w-0 flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px]" data-testid="automation-strip" data-runs={strip.runs} data-failed={strip.failed}>
        {strip.cells.map((c, i) => (
          <i key={i} data-cell={c} className={`rounded-[2px] ${CELL[c]} ${i === strip.nowIndex ? 'outline outline-1 outline-offset-1 outline-app-text-muted' : ''}`} />
        ))}
      </span>
    </span>
  );
}

function UsageCell({ row }: { row: AutomationRow }) {
  const tr = useT();
  const locale = useLocale();
  const u = row.usage;
  if (!u) return <span />;
  if (u.kind === 'script') return <span className="truncate text-mini text-app-text-faint" data-testid="automation-usage" data-usage="script">{tr('auto.usage.script')}</span>;
  if (u.kind === 'unmeasured') {
    return <span className="truncate text-mini text-app-text-faint" title={tr('auto.usage.unmeasuredWhy')} data-testid="automation-usage" data-usage="unmeasured">{tr('auto.usage.unmeasured')}</span>;
  }
  const per = (k: 'd1' | 'd7') => Object.entries(u[k]).map(([p, n]) => `${providerName(p)} ${tokenWords(n, locale)}`).join(', ') || tr('auto.usage.nothing');
  return (
    <span className="truncate text-mini tabular-nums text-app-text-secondary" title={tr('auto.usage.tip', { d1: per('d1'), d7: per('d7') })} data-testid="automation-usage" data-usage="tokens">
      {tokenWords(usageTotal(u), locale)}
    </span>
  );
}

/** Under the name: where it runs and its steps in short, the models by their mark. */
function RowMeta({ row, open, onFlow }: { row: AutomationRow; open: boolean; onFlow(): void }) {
  const tr = useT();
  const f = row.flow;
  if (!row.where && !f) return null;
  const brands = f?.ai ? modelBrands(row) : [];
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-mini text-app-text-muted">
      {row.where && <span className="truncate" title={tr('auto.where', { where: row.where })}>{row.where}</span>}
      {f && (
        <span
          className="inline-flex flex-none cursor-pointer items-center gap-1 rounded-xs hover:text-app-text"
          title={tr(open ? 'auto.flow.hide' : 'auto.flow.show')}
          data-testid="automation-flow"
          data-open={open}
          onClick={(e) => { e.stopPropagation(); onFlow(); }}
        >
          <ListTree size={12} aria-hidden="true" />
          {tr(f.steps === 1 ? 'auto.flow.stepsOne' : 'auto.flow.steps', { n: f.steps })}
          {f.ai && (brands.length ? <span className="inline-flex items-center gap-0.5">{brands.map((b) => <BrandMark key={b} brand={b} kind="model" />)}</span> : ` · ${tr('auto.flow.ai')}`)}
          <ChevronRight size={12} aria-hidden="true" className={open ? 'rotate-90' : ''} />
        </span>
      )}
    </span>
  );
}

export function VoteMark({ row }: { row: AutomationRow }) {
  const f = row.feedback;
  return (
    <span className="inline-flex items-center gap-1 text-app-text-faint" data-testid="automation-vote" data-vote={f.vote?.v ?? 'none'}>
      {f.vote?.v === 'ok' ? <ThumbsUp size={13} className="text-emerald-600 dark:text-emerald-400" />
        : f.vote ? <ThumbsDown size={13} className={DANGER_TEXT} />
          : row.votable ? <ThumbsUp size={13} /> : null}
      {f.notes.length > 0 && <MessageSquare size={13} className="text-app-text-secondary" />}
      {f.mute && <BellOff size={13} className="text-app-text-secondary" />}
    </span>
  );
}

interface RowProps {
  row: AutomationRow;
  now: number;
  clock: Clock;
  selected: boolean;
  gatewayDown: boolean;
  ran: boolean;
  brake: string | null;
  flowOpen: boolean;
  onFlow(): void;
  onSelect(): void;
  onCommand(c: JobCommand): void;
}

function TableRow({ row, now, clock, selected, gatewayDown, ran, brake, flowOpen, onFlow, onSelect, onCommand }: RowProps) {
  const tr = useT();
  const last = lastRunWords(row, clock, tr);
  const bad = row.last.outcome === 'error';
  const job = row.jobId !== null;
  const off = gatewayDown || row.enabled === null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const note = brake ?? row.warn;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-keyshortcuts={row.flow ? 'p' : undefined}
      data-testid="automation-row"
      data-key={row.key}
      data-system={row.system}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
        if (e.key.toLowerCase() === 'p' && row.flow && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); onFlow(); }
      }}
      className={`${GRID} min-h-[38px] cursor-pointer border-t border-app-border-subtle py-1.5 text-compact first:border-t-0 hover:bg-app-hover @max-2xl:py-2.5 ${selected ? 'bg-primary/10 shadow-[inset_2px_0_0_var(--primary)] hover:bg-primary/10' : ''}`}
    >
      <span className="flex min-w-0 flex-col @max-2xl:order-1">
        <span className="flex min-w-0 items-center gap-1.5 text-app-text">
          <ProjectMark project={row.project} />
          <span className="truncate">{row.title}</span>
        </span>
        {note && (
          <small className={`truncate text-mini ${brake ? 'text-primary' : WARNING_TEXT}`} data-testid={brake ? 'automation-brake' : 'automation-warn'}>{note}</small>
        )}
        <RowMeta row={row} open={flowOpen} onFlow={onFlow} />
      </span>
      <span className="truncate text-mini tabular-nums text-app-text-secondary @max-2xl:order-4" title={row.when ?? undefined} data-testid="automation-next">
        {row.enabled === false ? tr('auto.off') : nextRunWords(row, now, clock)}
      </span>
      <DayStrip row={row} now={now} glyph className="@max-2xl:order-3 @max-2xl:col-span-2" />
      <span className="@max-2xl:hidden"><UsageCell row={row} /></span>
      <span className={`truncate whitespace-nowrap text-mini tabular-nums @max-2xl:order-2 @max-2xl:text-right ${ran ? 'text-primary' : bad ? DANGER_TEXT : 'text-app-text-muted'}`} data-testid="automation-last">
        {ran ? tr('auto.cmd.ranNow') : last}
      </span>
      <span className="@max-2xl:order-5 @max-2xl:justify-self-end"><VoteMark row={row} /></span>
      <span className="flex items-center justify-end gap-0.5 @max-2xl:hidden" onClick={stop} onKeyDown={stop} data-testid="automation-commands">
        {job ? (
          <>
            <button type="button" className={ICON_BUTTON} title={tr('auto.cmd.run')} aria-label={tr('auto.cmd.run')} disabled={off} data-testid="automation-run" onClick={() => onCommand({ kind: 'run' })}>
              <Play size={13} />
            </button>
            <Switch checked={row.enabled !== false} disabled={off} label={tr('auto.cmd.toggle', { title: row.title })} testId="automation-toggle" onChange={(on) => onCommand({ kind: 'enable', on })} />
            <button type="button" className={ICON_BUTTON} title={tr('auto.cmd.remove')} aria-label={tr('auto.cmd.remove')} disabled={off} data-testid="automation-remove" onClick={() => onCommand({ kind: 'remove' })}>
              <Trash2 size={13} />
            </button>
          </>
        ) : (
          <span className="pr-1 text-mini text-app-text-faint" data-testid="automation-readonly">{tr('auto.readOnly')}</span>
        )}
      </span>
      {flowOpen && <FlowSteps row={row} label={tr('auto.flow.label', { title: row.title })} />}
    </div>
  );
}

interface TableProps {
  rows: AutomationRow[];
  /** How many rows show before the "N more, all fine" fold; null shows them all. */
  limit: number | null;
  now: number;
  clock: Clock;
  selectedKey: string | null;
  gatewayDown: boolean;
  ranAt: Readonly<Record<string, number>>;
  brakes: Readonly<Record<string, { text: string }>>;
  flowOpen: ReadonlySet<string>;
  onFlow(key: string): void;
  onSelect(row: AutomationRow): void;
  onCommand(row: AutomationRow, c: JobCommand): void;
  onMore?(): void;
  onLess?(): void;
}

export function AutomationTable({ rows, limit, now, clock, selectedKey, gatewayDown, ranAt, brakes, flowOpen, onFlow, onSelect, onCommand, onMore, onLess }: TableProps) {
  const tr = useT();
  const shown = limit === null ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <div className="overflow-hidden rounded border border-app-border bg-surface" data-testid="automation-table">
      <div className={`${GRID} h-[30px] border-b border-app-border-subtle bg-app-inset text-mini font-semibold text-app-text-secondary @max-2xl:hidden`}>
        <span>{tr('auto.col.name')}</span>
        <span>{tr('auto.col.next')}</span>
        <span>{tr('auto.col.day')}</span>
        <span>{tr('auto.col.usage')}</span>
        <span>{tr('auto.col.last')}</span>
        <span>{tr('auto.col.vote')}</span>
        <span className="text-right">{tr('auto.col.commands')}</span>
      </div>
      {shown.map((r) => (
        <TableRow
          key={r.key}
          row={r}
          now={now}
          clock={clock}
          selected={r.key === selectedKey}
          gatewayDown={gatewayDown}
          ran={(ranAt[r.key] ?? 0) > now - 60_000}
          brake={brakes[r.key]?.text ?? null}
          flowOpen={flowOpen.has(r.key)}
          onFlow={() => onFlow(r.key)}
          onSelect={() => onSelect(r)}
          onCommand={(c) => onCommand(r, c)}
        />
      ))}
      {hidden > 0 && onMore && (
        <button type="button" onClick={onMore} className="flex h-8 w-full items-center gap-1.5 border-t border-app-border-subtle px-3 text-mini text-app-text-muted hover:bg-app-hover @max-2xl:h-11" data-testid="automation-more">
          <b className="font-medium tabular-nums text-app-text-secondary">{tr('auto.more', { n: hidden })}</b> · {tr('auto.moreShow')}
        </button>
      )}
      {hidden === 0 && onLess && (
        <button type="button" onClick={onLess} className="flex h-8 w-full items-center border-t border-app-border-subtle px-3 text-mini text-app-text-muted hover:bg-app-hover @max-2xl:h-11">
          {tr('auto.less')}
        </button>
      )}
    </div>
  );
}
