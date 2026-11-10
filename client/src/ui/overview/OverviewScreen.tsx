import type { KeyboardEvent, ReactNode } from 'react';
import { CircleAlert, Clock, Folder, Gauge, Sparkles, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import { Blank } from '../primitives/Blank';
import { Button } from '../primitives/Button';
import { RichText } from '../primitives/RichText';
import { PaneHeader } from '../shell/PaneHeader';
import type { Action, ItemLinks } from '../types';
import { DayBars } from './DayBars';
import { OVERVIEW_BLOCKS, type FlowStatModel, type OverviewBlockId, type OverviewModel, type OverviewPeriod, type StatIcon, type StatTileModel } from './model';
import { FOCUS_RING } from '../shell/pressable';

const STAT_ICON: Record<StatIcon, LucideIcon> = { folder: Folder, gauge: Gauge, clock: Clock, alert: CircleAlert };
const PERIODS: OverviewPeriod[] = ['week', 'month', 'year'];
const CARD = 'rounded-lg border border-app-border bg-surface';


/** A headline number; a button (to the list behind it) only when `onOpen` is passed. */
export function StatTile({ tile, onOpen }: { tile: StatTileModel; onOpen?: () => void }) {
  const Icon = STAT_ICON[tile.icon];
  const body = (
    <>
      <Icon size={14} className="absolute right-3.5 top-3.5 text-app-text-tertiary" aria-hidden="true" />
      <div className={clsx('text-[26px] font-semibold leading-9 tracking-[-0.01em] tabular-nums', tile.attention ? 'text-amber-600 dark:text-amber-400' : 'text-app-text')}>{tile.value}</div>
      <div className="text-prose text-app-text-secondary">{tile.label}</div>
      {tile.detail && <div className="mt-0.5 text-compact text-app-text-tertiary">{tile.detail}</div>}
    </>
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={clsx(CARD, 'relative w-full cursor-pointer px-4 py-3.5 text-left transition-colors hover:border-app-border-light hover:bg-black/[0.03] dark:hover:bg-white/[0.05]', FOCUS_RING)}
      >
        {body}
      </button>
    );
  }
  return <div className={clsx(CARD, 'relative px-4 py-3.5')}>{body}</div>;
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_112px_104px_176px_84px_72px_150px] items-center gap-x-4 px-4';

function ShareBar({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1.5 w-[88px] overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]" aria-hidden="true">
        <span className="block h-full rounded-full bg-primary dark:bg-primary-dark" style={{ width: `${value}%` }} />
      </span>
      <span className="tabular-nums">{value}%</span>
    </span>
  );
}

/**
 * The month of every flow side by side: volume, time, how much goes to a person, corrections, errors, who holds it.
 * Rows open their flow and the stuck cell opens the flow's stuck items, each only when its handler is passed.
 */
export function FlowStatsTable({ flows, copy, volumeLabel, onOpenFlow, onOpenStuck }: {
  flows: FlowStatModel[];
  copy: UiCopy;
  /** The header of the volume column when the period is not a month. */
  volumeLabel?: string;
  onOpenFlow?: (flowId: string) => void;
  onOpenStuck?: (flowId: string) => void;
}) {
  const c = copy.overview.columns;
  // Enter/Space on the row itself only: a nested button handles its own keys.
  const rowKeys = (id: string) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onOpenFlow?.(id);
  };
  return (
    <div className={clsx(CARD, 'overflow-x-auto')}>
    <div className="min-w-[1000px]" role="table">
      <div role="row" className={clsx(GRID, 'h-9 border-b border-app-border bg-black/[0.02] text-compact text-app-text-secondary dark:bg-white/[0.03]')}>
        <span role="columnheader">{c.flow}</span>
        <span role="columnheader" className="text-right">{volumeLabel ?? c.perMonth}</span>
        <span role="columnheader" className="text-right">{c.avgTime}</span>
        <span role="columnheader">{c.toPerson}</span>
        <span role="columnheader" className="text-right">{c.corrected}</span>
        <span role="columnheader" className="text-right">{c.errors}</span>
        <span role="columnheader">{c.stuck}</span>
      </div>
      {flows.map((f) => (
        <div
          key={f.id}
          role="row"
          tabIndex={onOpenFlow ? 0 : undefined}
          onClick={onOpenFlow ? () => onOpenFlow(f.id) : undefined}
          onKeyDown={onOpenFlow ? rowKeys(f.id) : undefined}
          className={clsx(
            GRID,
            'h-10 border-b border-app-border-light text-prose text-app-text last:border-b-0',
            onOpenFlow && ['cursor-pointer transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]', FOCUS_RING, 'focus-visible:ring-inset'],
          )}
        >
          <span role="cell" className="truncate font-semibold">{f.name}</span>
          <span role="cell" className="text-right tabular-nums">{f.perMonth}</span>
          <span role="cell" className="text-right tabular-nums">{f.avgTime}</span>
          <span role="cell"><ShareBar value={f.toPerson} /></span>
          <span role="cell" className="text-right tabular-nums">{f.corrected ?? <Blank />}</span>
          <span role="cell" className="text-right tabular-nums">{f.errors}</span>
          <span role="cell">
            {f.stuck && onOpenStuck ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenStuck(f.id); }}
                className={clsx('max-w-full truncate whitespace-nowrap rounded text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}
              >
                {f.stuck}
              </button>
            ) : (f.stuck ?? <Blank />)}
          </span>
        </div>
      ))}
    </div>
    </div>
  );
}

/**
 * The management overview (n18): an estimate of a month at full speed, in
 * blocks the director can rearrange. Headline numbers, every flow in one
 * table, what is worth doing now in words, and the records per day.
 * Tiles, flow rows and stuck cells lead somewhere only when their handlers are
 * passed; `children` replace the body for a period whose data is not loaded.
 */
export function OverviewScreen({
  overview, copy, period = 'month', onPeriodChange, onOpenFlow, onOpenStuck, tileLinks, onCustomize, onExport,
  customizeTitle, exportTitle, volumeLabel, blocks = OVERVIEW_BLOCKS, phone, children,
}: {
  overview: OverviewModel;
  copy: UiCopy;
  period?: OverviewPeriod;
  onPeriodChange?: (period: OverviewPeriod) => void;
  onOpenFlow?: (flowId: string) => void;
  onOpenStuck?: (flowId: string) => void;
  tileLinks?: ItemLinks;
  onCustomize?: Action;
  onExport?: Action;
  /** Why a control is off, shown on hover. */
  customizeTitle?: string;
  exportTitle?: string;
  /** The header of the volume column for a period other than the month. */
  volumeLabel?: string;
  /** The blocks on show, in order. */
  blocks?: OverviewBlockId[];
  /** Phone layout: the controls move to a row of their own under the header. */
  phone?: boolean;
  children?: ReactNode;
}) {
  const o = copy.overview;
  const controls = (
    <>
      <SegmentedControl value={period} onChange={(v) => onPeriodChange?.(v)} ariaLabel={o.periodLabel} options={PERIODS.map((p) => ({ value: p, label: o[p] }))} />
      <Button onClick={onCustomize} title={customizeTitle}>{o.customize}</Button>
      <Button onClick={onExport} title={exportTitle}>{o.exportAll}</Button>
    </>
  );
  const insightOn = blocks.includes('insight');
  const render = (id: OverviewBlockId) => {
    switch (id) {
      case 'tiles':
        return (
          <div key={id} className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4 md:col-span-2">
            {overview.tiles.map((t) => <StatTile key={t.id} tile={t} onOpen={tileLinks?.[t.id]} />)}
          </div>
        );
      case 'flows':
        return (
          <div key={id} className="md:col-span-2">
            <FlowStatsTable flows={overview.flows} copy={copy} volumeLabel={volumeLabel} onOpenFlow={onOpenFlow} onOpenStuck={onOpenStuck} />
          </div>
        );
      case 'insight':
        return (
          <section key={id} className={clsx(CARD, 'px-4 py-3.5')}>
            <h3 className="mb-2 flex items-center gap-2 text-body-lg font-semibold text-app-text">
              <Sparkles size={15} className="text-fuchsia-600 dark:text-fuchsia-400" aria-hidden="true" />
              {o.whatNow}
            </h3>
            <p className="text-prose leading-6 text-app-text-body">
              <RichText text={overview.insight} pageLabel={copy.common.page} />
            </p>
          </section>
        );
      case 'chart':
        return (
          <section key={id} className={clsx(CARD, 'px-4 py-3.5', !insightOn && 'md:col-span-2')}>
            <DayBars chart={overview.chart} copy={copy} />
          </section>
        );
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={overview.crumbs}>{!phone && controls}</PaneHeader>
      {phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-4 py-2">{controls}</div>}
      {children ?? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5 md:py-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{blocks.map(render)}</div>
        </div>
      )}
    </div>
  );
}
