/**
 * The rows of one system, as a table on a wide pane and as small cards on a
 * narrow one: name, when, the last 24 hours, the last run, your vote and, on
 * an OpenClaw job only, the three commands. A launchd or GitHub row says it is
 * read-only instead: nothing here can run or stop it.
 */
import { MessageSquare, Play, ThumbsDown, ThumbsUp, Trash2, BellOff } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Switch } from '../Shared/Switch';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { dayStrip, type AutomationRow, type JobCommand, type StripCell } from '../../lib/automations';
import { ICON_BUTTON, lastRunWords, type Clock } from './automationsUi';

const GRID = 'grid grid-cols-[minmax(0,1fr)_116px_160px_86px_44px_82px] items-center gap-2.5 px-3 @max-2xl:grid-cols-[minmax(0,1fr)_auto] @max-2xl:gap-y-1.5';

const CELL: Record<StripCell, string> = {
  ok: 'bg-emerald-500/75 dark:bg-emerald-400/70',
  error: 'bg-red-500 dark:bg-red-400',
  skipped: 'bg-app-text-faint/50',
  none: 'bg-app-hover',
};

export function DayStrip({ row, now, className = '' }: { row: AutomationRow; now: number; className?: string }) {
  const cells = dayStrip(row.day, now);
  return (
    <span className={`grid h-3.5 grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] ${className}`} data-testid="automation-strip" aria-hidden="true">
      {cells.map((c, i) => (
        <i key={i} data-cell={c} className={`rounded-[2px] ${CELL[c]} ${i === cells.length - 1 ? 'outline outline-1 outline-offset-1 outline-app-text-muted' : ''}`} />
      ))}
    </span>
  );
}

function dotTone(row: AutomationRow): string {
  if (row.enabled === false) return 'bg-app-text-faint';
  if (row.level === 'rotto') return 'bg-red-500 dark:bg-red-400';
  if (row.level === 'te') return 'bg-amber-500 dark:bg-amber-400';
  return 'bg-emerald-500 dark:bg-emerald-400';
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
  onSelect(): void;
  onCommand(c: JobCommand): void;
}

function TableRow({ row, now, clock, selected, gatewayDown, ran, onSelect, onCommand }: RowProps) {
  const tr = useT();
  const last = lastRunWords(row, clock, tr);
  const bad = row.last.outcome === 'error';
  const job = row.jobId !== null;
  const off = gatewayDown || row.enabled === null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid="automation-row"
      data-key={row.key}
      data-system={row.system}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`${GRID} h-[38px] cursor-pointer border-t border-app-border-subtle text-compact first:border-t-0 hover:bg-app-hover @max-2xl:h-auto @max-2xl:py-2.5 ${selected ? 'bg-primary/10 shadow-[inset_2px_0_0_var(--primary)] hover:bg-primary/10' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2 text-app-text @max-2xl:order-1">
        <span className={`h-1.5 w-1.5 flex-none rounded-full ${dotTone(row)}`} aria-hidden="true" />
        <span className="truncate">{row.title}</span>
      </span>
      <span className="truncate text-mini text-app-text-secondary @max-2xl:order-4">
        {row.enabled === false ? tr('auto.off') : row.when ?? ''}
      </span>
      <DayStrip row={row} now={now} className="@max-2xl:order-3 @max-2xl:col-span-2 @max-2xl:h-2.5" />
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
  onSelect(row: AutomationRow): void;
  onCommand(row: AutomationRow, c: JobCommand): void;
  onMore?(): void;
  onLess?(): void;
}

export function AutomationTable({ rows, limit, now, clock, selectedKey, gatewayDown, ranAt, onSelect, onCommand, onMore, onLess }: TableProps) {
  const tr = useT();
  const shown = limit === null ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <div className="overflow-hidden rounded border border-app-border bg-surface" data-testid="automation-table">
      <div className={`${GRID} h-[30px] border-b border-app-border-subtle bg-app-inset text-mini font-semibold text-app-text-secondary @max-2xl:hidden`}>
        <span>{tr('auto.col.name')}</span>
        <span>{tr('auto.col.when')}</span>
        <span>{tr('auto.col.day')}</span>
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
