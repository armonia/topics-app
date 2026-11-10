import type { ReactNode } from 'react';
import type { UiCopy } from '../copy/types';
import type { Action, ItemLinks, SourceModel } from '../types';
import { BackButton } from '../shell/PaneHeader';
import { KeyHint } from '../primitives/Chip';
import type { InboxModel, QueueFilter, ValueOriginModel } from './model';
import { QueueList } from './QueueList';
import { ReviewDetail } from './ReviewDetail';

/** The keys of the queue, for the tab strip: move, confirm, correct. */
export function QueueKeys({ copy }: { copy: UiCopy }) {
  const i = copy.inbox;
  return (
    <span className="ml-auto hidden items-center gap-1.5 text-compact text-app-text-tertiary min-[1760px]:flex">
      <KeyHint>J</KeyHint><KeyHint>K</KeyHint>{i.keysScroll}
      <span aria-hidden="true">·</span>
      <KeyHint>↵</KeyHint>{i.keysConfirm}
      <span aria-hidden="true">·</span>
      <KeyHint>E</KeyHint>{i.keysCorrect}
    </span>
  );
}

/**
 * The queue of a person (n12): what waits for them on the left, the selected
 * input on the right with the original beside every claim, to confirm or
 * correct in place. A container drives it through the callbacks; `detail`
 * replaces the review when the selected item has nothing to show yet.
 */
export function InboxScreen({ inbox, copy, filter, onFilterChange, onSelect, onOpenSource, onExplainField, onOpenRecord, onConfirm, onReject, onAsk, detail, toolbar, empty, onEditField, editingFieldId, onCancelEdit, banner, decided }: {
  inbox: InboxModel;
  copy: UiCopy;
  filter?: QueueFilter;
  onFilterChange?: (filter: QueueFilter) => void;
  onSelect?: (id: string) => void;
  onOpenSource?: (source: SourceModel) => void;
  onExplainField?: ItemLinks;
  onOpenRecord?: () => void;
  onConfirm?: Action;
  onReject?: Action;
  /** The secondary button: ask the assistant. */
  onAsk?: Action;
  detail?: ReactNode;
  /** A row under the queue's filter: the office menu and the search. */
  toolbar?: ReactNode;
  /** The list's own words when no input matches the filters. */
  empty?: ReactNode;
  /** Saves a corrected value typed into a field. */
  onEditField?: (fieldId: string, value: string) => void;
  editingFieldId?: string;
  onCancelEdit?: () => void;
  /** A line over the title, e.g. that the input was already decided. */
  banner?: ReactNode;
  /** The input was already decided: no confirm or reject. */
  decided?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0">
      <QueueList items={inbox.items} selectedId={inbox.selectedId} counts={inbox.counts} filter={filter} onFilterChange={onFilterChange} onSelect={onSelect} copy={copy} toolbar={toolbar} empty={empty} />
      {detail || !inbox.review ? (
        <div className="flex h-full min-w-0 flex-1 flex-col">{detail}</div>
      ) : (
        <ReviewDetail
          review={inbox.review}
          copy={copy}
          decided={decided}
          hints={<QueueKeys copy={copy} />}
          onOpenSource={onOpenSource}
          onExplainField={onExplainField}
          onOpenRecord={onOpenRecord}
          onConfirm={onConfirm}
          onReject={onReject}
          onEditField={onEditField}
          editingFieldId={editingFieldId}
          onCancelEdit={onCancelEdit}
          banner={banner}
          secondary={{ label: copy.inbox.askAssistant, icon: true, onClick: onAsk }}
        />
      )}
    </div>
  );
}

/**
 * One input on its own (v02), with the origin of a value open under it: the
 * view a person reaches from a notification, without the queue. With
 * `onBack` and `backLabel` a bar on top leads back to where it was opened from.
 */
export function ReviewScreen({ inbox, copy, explain, decided, onBack, backLabel, onConfirm, onReject, onOpenOriginals, onOpenSource, explainActions, onExplainField, onEditField, editingFieldId, onCancelEdit, banner }: {
  inbox: InboxModel;
  copy: UiCopy;
  explain?: { fieldId: string; origin?: ValueOriginModel };
  /** Opened from the record the input became: the decision buttons are left out. */
  decided?: boolean;
  onBack?: () => void;
  backLabel?: string;
  onConfirm?: Action;
  onReject?: Action;
  /** The secondary button: open the originals. */
  onOpenOriginals?: Action;
  onOpenSource?: (source: SourceModel) => void;
  explainActions?: { onUse?: Action; onEdit?: Action; applied?: boolean; onOpenDocument?: Action; onOpenSource?: (source: SourceModel) => void; onClose?: () => void };
  onExplainField?: ItemLinks;
  onEditField?: (fieldId: string, value: string) => void;
  editingFieldId?: string;
  onCancelEdit?: () => void;
  banner?: ReactNode;
}) {
  if (!inbox.review) return null;
  const detail = (
    <ReviewDetail
      review={inbox.review}
      copy={copy}
      order="fields-first"
      withHeader={false}
      explain={explain}
      decided={decided}
      onOpenSource={onOpenSource}
      onConfirm={onConfirm}
      onReject={onReject}
      onExplainField={onExplainField}
      explainActions={explainActions}
      onEditField={onEditField}
      editingFieldId={editingFieldId}
      onCancelEdit={onCancelEdit}
      banner={banner}
      secondary={{ label: copy.inbox.openOriginals, onClick: onOpenOriginals }}
    />
  );
  if (!onBack || backLabel === undefined) return <div className="flex h-full min-h-0">{detail}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-app-border px-4">
        <BackButton label={backLabel} onClick={onBack} copy={copy} />
      </div>
      <div className="flex min-h-0 flex-1">{detail}</div>
    </div>
  );
}
