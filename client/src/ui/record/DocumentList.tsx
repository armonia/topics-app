import { CircleCheck, FileText, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { KeyboardEvent, ReactNode } from 'react';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { SectionLabel } from '../primitives/Panel';
import type { DocumentModel, RecordModel, RecordSection } from './model';
import { FOCUS_RING } from '../shell/pressable';


/**
 * Makes a list item behave as a button without leaving the list: the <li> keeps
 * its place in the <ul>, so the role and the keys are on it. Nothing is added
 * when there is no handler, so a picture stays a picture.
 */
function pressable(onPress?: () => void) {
  if (!onPress) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress();
      }
    },
  };
}

export function DocumentCard({ doc, selected, copy, onOpen }: { doc: DocumentModel; selected: boolean; copy: UiCopy; onOpen?: () => void }) {
  return (
    <li
      aria-current={selected || undefined}
      {...pressable(onOpen)}
      className={clsx(
        'rounded-lg border bg-surface px-3 py-2.5',
        onOpen && ['cursor-pointer', FOCUS_RING],
        selected ? 'border-primary shadow-[0_0_0_3px_rgba(0,102,255,0.12)]' : ['border-app-border', onOpen && 'hover:border-primary/40 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]'],
      )}
    >
      <div className="flex items-center gap-1.5">
        <FileText size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-prose font-semibold text-app-text">{doc.name}</span>
        {doc.badge === 'signed' && <Chip tone="green" icon={CircleCheck}>{copy.record.signed}</Chip>}
        {doc.badge === 'draft' && <Chip tone="pink" icon={Sparkles}>{copy.record.draft}</Chip>}
      </div>
      <div className="mt-0.5 pl-5 text-compact text-app-text-tertiary [overflow-wrap:break-word]">{selected ? copy.record.openOnRight : doc.detail}</div>
    </li>
  );
}

/**
 * The left column of a record: its documents (where each comes from and what
 * it proves), then related records. The section switcher on top leads to the
 * record's data and history, which are other columns.
 * A container drives it: `selectedId` decides which document is open (instead
 * of the model's own mark), `onOpen` and `onOpenRelated` turn the cards into
 * links (hover and pointer only then), and `body` replaces both lists with the
 * content of another section.
 */
export function DocumentList({ record, copy, section = 'documents', onSectionChange, selectedId, onOpen, onOpenRelated, body, extra, fill }: {
  record: RecordModel;
  copy: UiCopy;
  section?: RecordSection;
  onSectionChange?: (section: RecordSection) => void;
  selectedId?: string;
  onOpen?: (docId: string) => void;
  onOpenRelated?: (id: string) => void;
  body?: ReactNode;
  /** Under the related records: what left the system (receipts). */
  extra?: ReactNode;
  /** Take the width of the place (the phone) instead of a 300px column. */
  fill?: boolean;
}) {
  const r = copy.record;
  return (
    <aside className={clsx('flex flex-col bg-app-inset', fill ? 'min-h-0 flex-1' : 'h-full w-[300px] shrink-0 border-r border-app-border')}>
      <div className="flex h-12 shrink-0 items-center border-b border-app-border px-4">
        <SegmentedControl
          value={section}
          onChange={(v) => onSectionChange?.(v)}
          ariaLabel={r.sectionsLabel}
          options={[
            { value: 'documents', label: r.documents },
            { value: 'data', label: r.data },
            { value: 'history', label: r.history },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {body ?? (
          <>
            <ul className="space-y-2">
              {record.documents.map((d) => (
                <DocumentCard
                  key={d.id}
                  doc={d}
                  selected={selectedId === undefined ? Boolean(d.selected) : d.id === selectedId}
                  copy={copy}
                  onOpen={onOpen && (() => onOpen(d.id))}
                />
              ))}
            </ul>
            {record.related.items.length > 0 && <SectionLabel className="mb-2 mt-5 px-1">{record.related.label}</SectionLabel>}
            <ul className="space-y-2">
              {record.related.items.map((it) => {
                const open = onOpenRelated && (() => onOpenRelated(it.id));
                return (
                  <li
                    key={it.id}
                    {...pressable(open)}
                    className={clsx('rounded-lg border border-app-border bg-surface px-3 py-2.5', open && ['cursor-pointer hover:border-primary/40 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]', FOCUS_RING])}
                  >
                    <div className="text-prose font-semibold text-app-text">{it.title}</div>
                    <div className="mt-0.5 text-compact text-app-text-tertiary">{it.detail}</div>
                  </li>
                );
              })}
            </ul>
            {extra}
          </>
        )}
      </div>
    </aside>
  );
}
