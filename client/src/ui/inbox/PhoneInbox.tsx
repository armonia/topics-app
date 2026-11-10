import type { ReactNode } from 'react';
import { ArrowLeft, CornerDownLeft } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action, ItemLinks, SourceModel } from '../types';
import { Chip } from '../primitives/Chip';
import { RichText } from '../primitives/RichText';
import { ClassificationField } from './ClassificationField';
import type { InboxModel, QueueFilter, QueueItemModel, ReviewModel, ValueOriginModel } from './model';
import { ValueOrigin } from './ValueOrigin';
import { PHONE_FILL } from '../work/phoneFrame';

const PRESS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

function PhoneRow({ item, copy, onOpen }: { item: QueueItemModel; copy: UiCopy; onOpen?: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen?.(item.id)}
        className={clsx('block min-h-[64px] w-full rounded-xl border border-app-border bg-surface px-4 py-3 text-left active:bg-app-hover', PRESS)}
      >
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1 text-body-lg font-semibold leading-5 text-app-text">{item.title}</span>
          <span className={clsx('shrink-0 text-prose leading-5 tabular-nums', item.urgent ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>{item.when}</span>
        </span>
        <span className="mt-0.5 block text-prose leading-5 text-app-text-secondary">{copy.inbox.proposal(item.proposal)}</span>
        {item.tag && <Chip tone={item.tag.tone} className="mt-2">{item.tag.text}</Chip>}
      </button>
    </li>
  );
}

/**
 * The queue on a phone (m01): one column of large rows, the filters on top,
 * nothing at the side. A row opens the input full screen.
 */
export function PhoneQueue({ inbox, copy, filter = 'all', onFilterChange, onOpen, toolbar, empty }: {
  inbox: InboxModel;
  copy: UiCopy;
  filter?: QueueFilter;
  onFilterChange?: (filter: QueueFilter) => void;
  onOpen?: (id: string) => void;
  toolbar?: ReactNode;
  empty?: ReactNode;
}) {
  return (
    <div className={clsx('flex min-h-0 flex-col', PHONE_FILL)}>
      <div className="shrink-0 px-4 pb-2 pt-4">
        <h1 className="mb-3 text-headline font-semibold tracking-[-0.01em] text-app-text">{copy.shell.nav.inbox}</h1>
        <SegmentedControl
          value={filter}
          onChange={(v) => onFilterChange?.(v)}
          ariaLabel={copy.inbox.filterLabel}
          options={[
            { value: 'all', label: `${copy.inbox.all} ${inbox.counts.all}` },
            { value: 'overdue', label: `${copy.inbox.overdue} ${inbox.counts.overdue}` },
          ]}
        />
        {toolbar && <div className="mt-2 flex items-center gap-2">{toolbar}</div>}
      </div>
      {inbox.items.length === 0 && empty ? (
        <div className="flex min-h-0 flex-1 flex-col">{empty}</div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-6 pt-2">
          {inbox.items.map((it) => <PhoneRow key={it.id} item={it} copy={copy} onOpen={onOpen} />)}
        </ul>
      )}
    </div>
  );
}

/**
 * One input on a phone: what it is and how long it has, what it says with its
 * pages, the proposed values to touch, and the three ways out in large
 * buttons at the foot. `explain` opens the origin of one value under it.
 */
export function PhoneReview({ review, copy, backLabel, onBack, explain, decided, onConfirm, onReject, onOpenOriginals, onOpenSource, onExplainField, explainActions, onEditField, editingFieldId, onCancelEdit, banner, onOpenRecord }: {
  review: ReviewModel;
  copy: UiCopy;
  backLabel: string;
  onBack?: () => void;
  explain?: { fieldId: string; origin?: ValueOriginModel };
  decided?: boolean;
  onConfirm?: Action;
  onReject?: Action;
  onOpenOriginals?: Action;
  onOpenSource?: (source: SourceModel) => void;
  onExplainField?: ItemLinks;
  explainActions?: { onUse?: Action; onEdit?: Action; applied?: boolean; onOpenDocument?: Action; onOpenSource?: (source: SourceModel) => void; onClose?: () => void };
  onEditField?: (fieldId: string, value: string) => void;
  editingFieldId?: string;
  onCancelEdit?: () => void;
  banner?: ReactNode;
  onOpenRecord?: () => void;
}) {
  const i = copy.inbox;
  return (
    <div className={clsx('flex min-h-0 flex-col', PHONE_FILL)}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        <button type="button" onClick={onBack} className={clsx('-ml-1 mb-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-1.5 text-prose text-app-text-secondary active:bg-app-hover', PRESS)}>
          <ArrowLeft size={16} aria-hidden="true" />{backLabel}
        </button>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-prose">
          <Chip tone={review.kind.tone}>{review.kind.text}</Chip>
          {review.record && onOpenRecord && (
            <button type="button" onClick={onOpenRecord} className={clsx('inline-flex h-7 items-center rounded px-1.5 text-compact font-medium text-primary dark:text-primary-dark', PRESS)}>{review.record.label}</button>
          )}
          {review.deadline && <span className="ml-auto font-medium text-rose-600 dark:text-rose-400">{review.deadline}</span>}
        </div>
        {banner && <div className="mb-3">{banner}</div>}
        <h2 className={clsx('text-headline font-semibold leading-7 tracking-[-0.01em] text-app-text', review.deadlineNote ? 'mb-1' : 'mb-3')}>{review.title}</h2>
        {review.deadlineNote && <p className="mb-3 text-prose text-app-text-secondary">{review.deadlineNote}</p>}
        <p className="mb-1 text-body-lg leading-7 text-app-text-body">
          <RichText text={review.summary} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
        </p>
        <div className="mt-4 space-y-3">
          {review.fields.map((f) => (
            <div key={f.id} className="min-w-0">
              <ClassificationField
                field={f}
                focused={explain?.fieldId === f.id}
                copy={copy}
                onExplain={onExplainField?.[f.id]}
                onEdit={onEditField && !decided ? (value) => onEditField(f.id, value) : undefined}
                editing={editingFieldId === f.id}
                onCancelEdit={onCancelEdit}
              >
                {explain?.fieldId === f.id && explain.origin && (
                  <div className="mt-2"><ValueOrigin origin={explain.origin} copy={copy} inline {...explainActions} /></div>
                )}
              </ClassificationField>
            </div>
          ))}
        </div>
        <section className="mt-4 rounded-lg border border-app-border bg-app-inset px-4 py-3">
          <h3 className="mb-1 text-prose font-semibold text-app-text">{i.afterConfirm}</h3>
          <p className="text-prose leading-6 text-app-text-secondary">{review.after}</p>
        </section>
      </div>
      <div className="shrink-0 space-y-2 border-t border-app-border bg-surface px-4 pb-4 pt-3">
        {!decided && (
          <button
            type="button"
            onClick={onConfirm || undefined}
            disabled={onConfirm === false}
            className={clsx('flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 text-body-lg font-medium text-white active:bg-emerald-800 disabled:cursor-default disabled:opacity-45', PRESS)}
          >
            {review.confirmLabel}<CornerDownLeft size={14} className="opacity-80" aria-hidden="true" />
          </button>
        )}
        <div className="grid grid-cols-2 gap-2">
          {!decided && (
            <button type="button" onClick={onReject || undefined} disabled={onReject === false} className={clsx('h-11 rounded-xl bg-black/[0.05] text-prose font-medium text-app-text active:bg-black/10 disabled:opacity-45 dark:bg-white/[0.08]', PRESS)}>{i.notForUs}</button>
          )}
          <button type="button" onClick={onOpenOriginals || undefined} disabled={onOpenOriginals === false} className={clsx('h-11 rounded-xl bg-black/[0.05] text-prose font-medium text-app-text active:bg-black/10 disabled:opacity-45 dark:bg-white/[0.08]', decided && 'col-span-2', PRESS)}>{i.openOriginals}</button>
        </div>
      </div>
    </div>
  );
}
