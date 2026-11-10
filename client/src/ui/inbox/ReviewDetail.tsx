import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CornerDownLeft, FileText, MessageSquare, Sparkles } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action, ItemLinks, SourceModel } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { RichText } from '../primitives/RichText';
import { ClassificationField } from './ClassificationField';
import type { ReviewModel, ValueOriginModel } from './model';
import { OriginUnknown, ValueOrigin } from './ValueOrigin';

function Card({ children }: { children: ReactNode }) {
  return <section className="rounded-lg border border-app-border bg-surface px-4 py-3.5">{children}</section>;
}

function CardTitle({ title, hint, copy }: { title: string; hint?: string; copy: UiCopy }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>
      <h3 className="text-body-lg font-semibold text-app-text">{title}</h3>
      {hint && <span className="text-prose text-app-text-tertiary">{hint}</span>}
    </div>
  );
}

/**
 * One input to confirm: what it says, with every claim pinned to its page of
 * the original; the proposed classification, each value with its confidence
 * and correctable; what happens on its own after the confirmation; the three
 * ways out. `explain` opens the origin of one field under the field itself.
 * The `on*` props are what a navigable container hands in: without them the
 * screen is a picture. `onExplainField` makes the fields it names clickable,
 * `onOpenRecord` turns the record chip of the header into a link (without it
 * the header does not show the record), `explainActions` wires the open origin.
 */
export function ReviewDetail({ review, copy, order = 'summary-first', withHeader = true, explain, decided, onOpenSource, onConfirm, onReject, secondary, onExplainField, onOpenRecord, explainActions, onEditField, editingFieldId, onCancelEdit, banner, hints }: {
  review: ReviewModel;
  copy: UiCopy;
  order?: 'summary-first' | 'fields-first';
  withHeader?: boolean;
  /** `origin` omitted: the field is open but its origin is not known here, and the popover says so. */
  explain?: { fieldId: string; origin?: ValueOriginModel };
  /** The input was already decided (opened from its record): no confirm or reject. */
  decided?: boolean;
  onOpenSource?: (source: SourceModel) => void;
  onConfirm?: Action;
  onReject?: Action;
  /** The third action: ask the assistant, or open the originals. */
  secondary: { label: string; onClick?: Action; icon?: boolean };
  /** Fields with an entry open their origin when pressed, keyed by field id. */
  onExplainField?: ItemLinks;
  onOpenRecord?: () => void;
  explainActions?: { onUse?: Action; onEdit?: Action; applied?: boolean; onOpenDocument?: Action; onOpenSource?: (source: SourceModel) => void; onClose?: () => void };
  /** A field's value typed over: lets the fields be corrected in place. */
  onEditField?: (fieldId: string, value: string) => void;
  /** The field that is being typed over. */
  editingFieldId?: string;
  onCancelEdit?: () => void;
  /** A line over the title (already decided, who decided). */
  banner?: ReactNode;
  /** At the right end of the buttons: the keys that work on this screen. */
  hints?: ReactNode;
}) {
  const i = copy.inbox;
  const summary = (
    <Card key="summary">
      <CardTitle title={i.whatItSays} copy={copy} />
      <p className="text-body-lg leading-7 text-app-text-body">
        <RichText text={review.summary} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
      </p>
    </Card>
  );
  const fields = (
    <Card key="fields">
      <CardTitle title={i.proposed} hint={onExplainField ? i.pickForSource : explain ? i.hoverForSource : i.editable} copy={copy} />
      <div className="grid grid-cols-2 gap-x-5 gap-y-3">
        {review.fields.map((f) => (
          <ClassificationField
            key={f.id}
            field={f}
            focused={explain?.fieldId === f.id}
            copy={copy}
            onExplain={onExplainField?.[f.id]}
            onEdit={onEditField && !decided ? (value) => onEditField(f.id, value) : undefined}
            editing={editingFieldId === f.id}
            onCancelEdit={onCancelEdit}
          >
            {explain?.fieldId === f.id && (explain.origin
              ? <ValueOrigin origin={explain.origin} copy={copy} {...explainActions} />
              : <OriginUnknown value={f.value} copy={copy} onClose={explainActions?.onClose} />)}
          </ClassificationField>
        ))}
      </div>
    </Card>
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-9 pb-6 pt-5">
        {withHeader && (
          <div className="mb-2 flex items-center gap-2.5 text-prose">
            <Chip tone={review.kind.tone}>{review.kind.text}</Chip>
            {review.record && onOpenRecord && (
              <button
                type="button"
                onClick={onOpenRecord}
                className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-mini font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-primary-dark"
              >
                <FileText size={12} className="shrink-0" aria-hidden="true" />
                {review.record.label}
              </button>
            )}
            <span className="truncate text-app-text-tertiary">{review.origin}</span>
            {review.deadline && <span className="ml-auto shrink-0 font-medium text-rose-600 dark:text-rose-400">{review.deadline}</span>}
          </div>
        )}
        {banner && <div className="mb-3">{banner}</div>}
        <h2 className={clsx('text-headline font-semibold leading-7 tracking-[-0.01em] text-app-text', review.deadlineNote ? 'mb-1' : 'mb-4')}>{review.title}</h2>
        {review.deadlineNote && <p className="mb-4 text-prose text-app-text-secondary">{review.deadlineNote}</p>}
        <div className="space-y-4">
          {order === 'summary-first' ? [summary, fields] : [fields, summary]}
          <section className="rounded-lg border border-app-border bg-app-inset px-4 py-3.5">
            <h3 className="mb-1 text-prose font-semibold text-app-text">{i.afterConfirm}</h3>
            <p className="text-prose leading-6 text-app-text-secondary">{review.after}</p>
          </section>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-9 pb-5 pt-3">
        {!decided && (
          <>
            <Button variant="confirm" size="lg" onClick={onConfirm} trailing={<CornerDownLeft size={13} className="opacity-80" aria-hidden="true" />}>
              {review.confirmLabel}
            </Button>
            <Button size="lg" onClick={onReject}>{i.notForUs}</Button>
          </>
        )}
        <Button size="lg" icon={secondary.icon ? MessageSquare : undefined} onClick={secondary.onClick}>{secondary.label}</Button>
        {hints}
      </div>
    </div>
  );
}
