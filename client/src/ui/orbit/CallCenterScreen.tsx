import type { ReactNode } from 'react';
import { Headset, PhoneCall, PhoneIncoming } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip, Count } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { SectionLabel } from '../primitives/Panel';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { CallRowModel, IncomingCallModel } from './model';

function Row({ row, onSelect }: { row: CallRowModel; onSelect: (id: string) => void }) {
  return (
    <li className={clsx('relative border-b border-app-border', row.selected ? 'bg-sky-500/[0.08] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary' : 'hover:bg-app-hover')}>
      <button
        type="button"
        aria-current={row.selected || undefined}
        onClick={() => onSelect(row.id)}
        className={clsx('block w-full cursor-pointer px-4 py-3 text-left focus-visible:ring-inset', FOCUS_RING)}
      >
        <div className="flex items-start gap-3">
          <span className="min-w-0 flex-1 text-prose font-semibold leading-5 text-app-text">{row.title}</span>
          <span className={clsx('shrink-0 text-compact leading-5 tabular-nums', row.overdue ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{row.when}</span>
        </div>
        {row.summary && <div className="mt-0.5 text-compact leading-5 text-app-text-secondary">{row.summary}</div>}
        {row.chip && <Chip tone={row.chip.tone} className="mt-1.5">{row.chip.text}</Chip>}
      </button>
    </li>
  );
}

/**
 * The call center (s03): on the left what is ringing, what waits for a
 * person and the calls already handled; on the right the place of whichever
 * one is open (`children`: an item to confirm, or a call). Under 768px the
 * list sits on top and the place below it, each scrolling by itself.
 */
export function CallCenterScreen({ incoming, onSelectIncoming, queue, recent, onSelect, copy, children, phone }: {
  incoming?: IncomingCallModel;
  onSelectIncoming: () => void;
  queue: CallRowModel[];
  recent: CallRowModel[];
  onSelect: (id: string) => void;
  copy: UiCopy;
  children?: ReactNode;
  phone?: boolean;
}) {
  const c = copy.orgs.callCenter;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.shell.nav.callcenter, detail: copy.orgs.sarim.orgName }]} status={<Count value={queue.length} tone="blue" />} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className={clsx('flex shrink-0 flex-col overflow-y-auto border-app-border md:w-[340px] md:border-r', phone && 'max-h-[40dvh] border-b')}>
          {incoming && (
            <div className="border-b border-app-border p-3">
              <button
                type="button"
                aria-current={incoming.selected || undefined}
                onClick={onSelectIncoming}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  incoming.status === 'ringing' ? 'border-amber-500/50 bg-amber-500/10' : 'border-app-border bg-surface hover:bg-app-hover',
                  incoming.selected && 'ring-2 ring-primary/60',
                  FOCUS_RING,
                )}
              >
                <span className={clsx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full', incoming.status === 'ringing' ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')}>
                  {incoming.status === 'ringing' ? <PhoneIncoming size={15} aria-hidden="true" /> : <PhoneCall size={15} aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-mini font-semibold uppercase tracking-wide text-app-text-tertiary">{incoming.status === 'ringing' ? c.incomingLabel : incoming.status === 'live' ? c.statusLive : c.statusEnded(c.now)}</span>
                  <span className="block truncate text-prose font-semibold text-app-text">{incoming.caller}</span>
                </span>
              </button>
            </div>
          )}
          <div className="px-4 pb-1 pt-3"><SectionLabel>{c.queue(queue.length)}</SectionLabel></div>
          {queue.length === 0 ? (
            <p className="px-4 py-3 text-compact text-app-text-tertiary">{c.queueEmpty}</p>
          ) : (
            <ul>{queue.map((r) => <Row key={r.id} row={r} onSelect={onSelect} />)}</ul>
          )}
          <div className="px-4 pb-1 pt-4"><SectionLabel>{c.recentCalls}</SectionLabel></div>
          <ul>{recent.map((r) => <Row key={r.id} row={r} onSelect={onSelect} />)}</ul>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {children ?? <EmptyState icon={Headset} title={c.nothingOpen}>{c.nothingOpenBody}</EmptyState>}
        </div>
      </div>
    </div>
  );
}
