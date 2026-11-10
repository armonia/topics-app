import { Scale, MapPin, ReceiptText } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/EmptyState';
import { SectionLabel } from '../primitives/Panel';
import { Timeline, type TimelineItemModel } from '../primitives/Timeline';
import { FOCUS_RING } from '../shell/pressable';
import type { ReceiptModel } from './model';

const ROW = clsx('-mx-1 flex w-[calc(100%+0.5rem)] items-baseline gap-2 rounded-md px-1 py-1.5 text-left hover:bg-app-hover', FOCUS_RING);

/**
 * The «Dati» section of the left column of a record: the values the AI read,
 * one row each with its value, each opening where it comes from; and the way
 * to the full sheet.
 */
export function FieldsBody({ fields, copy, onOpenField, onOpenSheet }: {
  fields: Array<{ id: string; label: string; value: string; corrected?: boolean }>;
  copy: UiCopy;
  onOpenField?: (id: string) => void;
  onOpenSheet?: () => void;
}) {
  const r = copy.work.record;
  if (fields.length === 0) return <EmptyState title={r.fieldsEmpty} className="px-2" />;
  return (
    <div>
      <SectionLabel className="mb-1.5 px-1">{r.sectionFields}</SectionLabel>
      <ul>
        {fields.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => onOpenField?.(f.id)} className={ROW}>
              <span className="w-[92px] shrink-0 truncate text-compact text-app-text-tertiary">{f.label}</span>
              <span className={clsx('min-w-0 flex-1 break-words text-prose', f.corrected ? 'text-amber-700 dark:text-amber-400' : 'text-app-text')}>{f.value}</span>
            </button>
          </li>
        ))}
      </ul>
      {onOpenSheet && <div className="mt-3 px-1"><Button onClick={onOpenSheet}>{r.openSheet}</Button></div>}
    </div>
  );
}

/** The «Storia» section: the events of the record in order, a line each. */
export function HistoryBody({ items, copy, onOpenSheet }: { items: TimelineItemModel[]; copy: UiCopy; onOpenSheet?: () => void }) {
  const r = copy.work.record;
  if (items.length === 0) return <EmptyState title={r.historyEmpty} className="px-2" />;
  return (
    <div>
      <SectionLabel className="mb-2 px-1">{r.sectionHistory}</SectionLabel>
      <Timeline items={items} ariaLabel={r.sectionHistory} />
      {onOpenSheet && <div className="mt-3 px-1"><Button onClick={onOpenSheet}>{r.openSheet}</Button></div>}
    </div>
  );
}

/**
 * What hangs under the documents of a record: the receipts of what left the
 * system, the norms it cites and the parcel it is about. Each row opens the
 * thing it names.
 */
export function RecordExtras({ receipts, receiptsLabel, norms, parcel, copy, onOpenReceipt, onOpenNorm, onOpenParcel }: {
  receipts: ReceiptModel[];
  receiptsLabel: string;
  norms: Array<{ id: string; label: string }>;
  parcel?: string;
  copy: UiCopy;
  onOpenReceipt?: (id: string) => void;
  onOpenNorm?: (id: string) => void;
  onOpenParcel?: () => void;
}) {
  const r = copy.work.record;
  return (
    <>
      {receipts.length > 0 && (
        <>
          <SectionLabel className="mb-2 mt-5 px-1">{receiptsLabel}</SectionLabel>
          <ul className="space-y-2">
            {receipts.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => onOpenReceipt?.(x.id)} className={clsx('block w-full rounded-lg border border-emerald-500/35 bg-surface px-3 py-2.5 text-left hover:bg-app-hover', FOCUS_RING)}>
                  <span className="flex items-center gap-1.5 text-prose font-semibold text-app-text"><ReceiptText size={14} className="shrink-0 text-emerald-600" aria-hidden="true" />{x.title}</span>
                  <span className="mt-0.5 block pl-5 text-compact text-app-text-tertiary">{x.at}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {norms.length > 0 && (
        <>
          <SectionLabel className="mb-2 mt-5 px-1">{r.norms}</SectionLabel>
          <ul className="space-y-1">
            {norms.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onOpenNorm?.(n.id)} className={clsx('flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-prose text-app-text hover:bg-app-hover', FOCUS_RING)}>
                  <Scale size={14} className="shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {parcel && (
        <>
          <SectionLabel className="mb-2 mt-5 px-1">{r.parcel}</SectionLabel>
          <button type="button" onClick={onOpenParcel} className={clsx('flex w-full items-start gap-2 rounded-lg border border-app-border bg-surface px-3 py-2.5 text-left hover:border-primary/40 hover:bg-app-hover', FOCUS_RING)}>
            <MapPin size={14} className="mt-0.5 shrink-0 text-app-text-secondary" aria-hidden="true" />
            <span className="min-w-0 text-prose text-app-text">{parcel}</span>
          </button>
        </>
      )}
    </>
  );
}
