import { Bell, ChevronRight, FileText } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { StateChip } from './StateChip';
import { EmptyState } from '../primitives/EmptyState';
import { FOCUS_RING, pressable } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { ContractRowModel } from './model';

/**
 * The column widths, as shares (the same grammar as `primitives/Table`). The
 * kind rides under the title and the start under the end, so the eight
 * columns fit the pane and the alerts are never past its edge.
 */
const COLUMNS = ['title', 'counterparty', 'status', 'value', 'end', 'notice', 'renewal', 'alerts'] as const;
const WIDTH: Record<(typeof COLUMNS)[number], string> = {
  title: 'minmax(200px, 280fr)',
  counterparty: 'minmax(140px, 170fr)',
  status: 'minmax(min-content, 100fr)',
  value: 'minmax(min-content, 140fr)',
  end: 'minmax(min-content, 110fr)',
  notice: 'minmax(130px, 150fr)',
  renewal: 'minmax(100px, 110fr)',
  alerts: 'minmax(min-content, 64fr)',
};

function AlertCount({ row, copy }: { row: ContractRowModel; copy: UiCopy }) {
  const t = copy.contracts.list;
  if (!row.alerts) return <span className="text-compact text-app-text-faint">{t.noAlerts}</span>;
  return (
    <span data-tip={row.alertTitle} aria-label={t.alertsAria(row.alerts)} className={clsx('inline-flex items-center gap-1 text-compact font-semibold tabular-nums', TONE_TEXT[row.alertTone])}>
      <Bell size={12} aria-hidden="true" />{row.alerts}
    </span>
  );
}

/**
 * Every contract as a table: title and kind, counterparty, state, value, end
 * and start, the next notice, the renewal and the open alerts. A row opens the contract
 * (`data-contract` names it). On a phone the rows become cards, one column.
 */
export function ContractList({ rows, onOpen, copy, phone, activeId }: {
  rows: ContractRowModel[];
  onOpen: (id: string) => void;
  copy: UiCopy;
  phone: boolean;
  activeId?: string;
}) {
  const t = copy.contracts.list;
  if (!rows.length) {
    return <EmptyState icon={FileText} title={t.emptyTitle} className="min-h-0 rounded-lg border border-app-border bg-surface py-10">{t.emptyBody}</EmptyState>;
  }
  if (phone) {
    return (
      <ul aria-label={copy.contracts.title} className="space-y-2">
        {rows.map((r) => (
          <li key={r.id}>
            <div
              data-contract={r.id}
              role="button"
              {...pressable(() => onOpen(r.id))}
              className={clsx('block rounded-lg border border-app-border bg-surface px-3.5 py-3 transition-colors hover:bg-app-hover', FOCUS_RING)}
            >
              <div className="flex items-center gap-1.5">
                <Chip>{r.kindText}</Chip>
                <StateChip tone={r.statusTone}>{r.statusText}</StateChip>
                <span className="flex-1" />
                <AlertCount row={r} copy={copy} />
              </div>
              <div className="mt-1.5 text-prose font-semibold leading-5 text-app-text">{r.title}</div>
              <div className="text-compact leading-4 text-app-text-secondary">{r.counterparty}</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-compact leading-4">
                <dt className="text-app-text-tertiary">{t.columns.value}</dt>
                <dd className="text-right tabular-nums text-app-text">{r.valueText}</dd>
                <dt className="text-app-text-tertiary">{t.columns.end}</dt>
                <dd className={clsx('text-right tabular-nums', r.endMissing ? 'text-app-text-tertiary' : 'text-app-text')}>{r.endText}</dd>
                <dt className="text-app-text-tertiary">{t.columns.notice}</dt>
                <dd className={clsx('text-right tabular-nums', r.noticeMissing ? 'text-compact text-app-text-faint' : r.noticeTone ? TONE_TEXT[r.noticeTone] : 'text-app-text')}>{r.noticeText}</dd>
              </dl>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={copy.contracts.title} style={{ gridTemplateColumns: COLUMNS.map((c) => WIDTH[c]).join(' ') }} className="grid w-min min-w-full text-prose">
        <div role="rowgroup" className="col-span-full grid grid-cols-subgrid">
          <div role="row" className="col-span-full grid min-h-9 grid-cols-subgrid items-center border-b border-app-border bg-app-inset text-compact font-medium leading-tight text-app-text-secondary">
            {COLUMNS.map((c) => (
              <span key={c} role="columnheader" className={clsx('min-w-0 px-3 py-1', c === 'value' && 'text-right')}>{t.columns[c]}</span>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="col-span-full grid grid-cols-subgrid">
          {rows.map((r) => (
            <div
              key={r.id}
              role="row"
              data-contract={r.id}
              aria-current={r.id === activeId ? true : undefined}
              {...pressable(() => onOpen(r.id))}
              className={clsx(
                'group col-span-full grid min-h-12 cursor-pointer grid-cols-subgrid items-center border-b border-app-border transition-colors last:border-b-0 hover:bg-app-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
                r.id === activeId && 'bg-sky-500/[0.08]',
              )}
            >
              <div role="cell" className="min-w-0 px-3 py-2">
                <span className="flex items-start gap-1 font-medium leading-5 text-app-text [overflow-wrap:break-word]">
                  <span className="min-w-0 flex-1">{r.title}</span>
                  <ChevronRight size={14} className="mt-0.5 shrink-0 text-app-text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                </span>
                <span className="mt-1 block"><Chip>{r.kindText}</Chip></span>
              </div>
              <div role="cell" className="min-w-0 px-3 py-2 leading-5">
                <span className="block text-app-text [overflow-wrap:break-word]">{r.counterparty}</span>
                {!r.counterparty.startsWith(r.counterpartyKind) && <span className="block text-mini text-app-text-tertiary">{r.counterpartyKind}</span>}
              </div>
              <div role="cell" className="min-w-0 px-3 py-2"><StateChip tone={r.statusTone}>{r.statusText}</StateChip></div>
              <div role="cell" className="min-w-0 px-3 py-2 text-right leading-5">
                <span className="block whitespace-nowrap tabular-nums text-app-text">{r.valueText}</span>
                {r.valueDetail && <span className="block text-mini text-app-text-tertiary">{r.valueDetail}</span>}
              </div>
              <div role="cell" className="min-w-0 px-3 py-2 leading-5">
                <span className={clsx('block', r.endMissing ? 'text-compact text-app-text-tertiary' : 'whitespace-nowrap tabular-nums text-app-text')}>{r.endText}</span>
                <span className="block whitespace-nowrap text-mini tabular-nums text-app-text-tertiary">{r.startText}</span>
              </div>
              <div role="cell" className="min-w-0 px-3 py-2 leading-5">
                <span className={clsx('block whitespace-nowrap tabular-nums', r.noticeMissing ? 'text-compact text-app-text-faint' : r.noticeTone ? `font-medium ${TONE_TEXT[r.noticeTone]}` : 'text-app-text')}>{r.noticeText}</span>
                {r.noticeDetail && <span className="block text-mini text-app-text-tertiary">{r.noticeDetail}</span>}
              </div>
              <div role="cell" className={clsx('min-w-0 px-3 py-2 text-compact leading-4', r.renewalMissing ? 'text-app-text-faint' : 'text-app-text-secondary')}>{r.renewalText}</div>
              <div role="cell" className="min-w-0 px-3 py-2"><AlertCount row={r} copy={copy} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
