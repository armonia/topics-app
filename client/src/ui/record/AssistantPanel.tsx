import { ChevronDown, CircleCheck, CircleDashed, MessageSquare, Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { UiCopy } from '../copy/types';
import clsx from 'clsx';
import type { Action, SourceModel } from '../types';
import { RichText } from '../primitives/RichText';
import { PanelHeading, SectionLabel, SidePanel } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import type { RecordModel } from './model';

/** Brings the newest line into view when it mounts: a new turn is a new key, so this runs once per turn. */
const showNewest = (el: HTMLElement | null) => el?.scrollIntoView({ block: 'nearest' });

/**
 * The assistant of one record: it sees only this record, its documents and
 * the knowledge base, and says so on top. The conversation scrolls under a header that
 * stays on top; the suggested questions and what is left to do on the record
 * (open on arrival, foldable to one line) sit above the composer, so they never
 * scroll out of sight. `onSend: false` draws the composer
 * disabled (the assistant is not connected here). With `onToggleCheck` the
 * items of the list can be ticked and unticked; `onAsk` makes the suggested
 * questions pressable; `fill` lets the panel take the width of its place (the
 * phone) instead of a column.
 */
export function AssistantPanel({ assistant, copy, onOpenSource, message = '', onMessageChange, onSend, onToggleCheck, onAsk, fill, busy }: {
  assistant: RecordModel['assistant'];
  copy: UiCopy;
  onOpenSource?: (source: SourceModel) => void;
  /** The composer is controlled: without `onMessageChange` it is read-only. */
  message?: string;
  onMessageChange?: (message: string) => void;
  onSend?: Action;
  onToggleCheck?: (id: string) => void;
  onAsk?: (question: string) => void;
  fill?: boolean;
  /** The assistant is answering: a quiet line says so. */
  busy?: boolean;
}) {
  const [checklistOpen, setChecklistOpen] = useState(true);
  const composer = (
    <label data-tip={onSend === false ? copy.preview.unavailable : undefined} className={clsx('flex h-10 items-center gap-2 rounded-xl bg-black/[0.05] pl-3.5 pr-2 dark:bg-white/[0.06]', onSend === false && 'cursor-default opacity-50')}>
      <input
        value={message}
        disabled={onSend === false}
        readOnly={!onMessageChange}
        onChange={(e) => onMessageChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && onSend) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={copy.record.composer}
        className="min-w-0 flex-1 bg-transparent text-prose text-app-text outline-none placeholder:text-app-placeholder"
      />
      <button
        type="button"
        onClick={onSend || undefined}
        disabled={onSend === false}
        aria-label={copy.record.send}
        data-tip={copy.record.send}
        className={clsx('inline-flex h-7 w-7 items-center justify-center rounded-lg text-app-text-secondary', onSend === false ? 'cursor-default opacity-45' : 'hover:bg-black/[0.06]')}
      >
        <Send size={15} aria-hidden="true" />
      </button>
    </label>
  );
  // Open on arrival (all five items in view, capped and scrolling past that) and foldable to one line with its
  // progress. Rendered only when open: WebKit still lays out a closed <details>, which left the items on top of the composer.
  const checklist = (
    <div>
      <button
        type="button"
        aria-expanded={checklistOpen}
        onClick={() => setChecklistOpen((v) => !v)}
        className={clsx('-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-left', FOCUS_RING)}
      >
        <ChevronDown size={13} className={clsx('shrink-0 text-app-text-tertiary transition-transform', !checklistOpen && '-rotate-90')} aria-hidden="true" />
        <SectionLabel>{assistant.checklistLabel}</SectionLabel>
        {assistant.checklistProgress && <span className="ml-auto text-mini tabular-nums text-app-text-tertiary">{assistant.checklistProgress}</span>}
      </button>
      {checklistOpen && <ul className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
        {assistant.checklist.map((c) => {
          const icon = c.done
            ? <CircleCheck size={15} className="shrink-0 text-emerald-600" aria-label={copy.record.done} />
            : <CircleDashed size={15} className="shrink-0 text-app-text-faint" aria-label={copy.record.toDo} />;
          return (
            <li key={c.id}>
              {onToggleCheck ? (
                <button
                  type="button"
                  aria-pressed={c.done}
                  onClick={() => onToggleCheck(c.id)}
                  className={clsx('-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1 text-left text-prose text-app-text hover:bg-app-hover', FOCUS_RING)}
                >
                  {icon}
                  <span className={c.done ? 'text-app-text-secondary line-through decoration-app-text-faint' : undefined}>{c.text}</span>
                </button>
              ) : (
                <span className="flex items-center gap-2 py-1 text-prose text-app-text">
                  {icon}
                  <span className={c.done ? 'text-app-text-secondary' : undefined}>{c.text}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>}
    </div>
  );
  const suggestions = onAsk && assistant.suggestions && assistant.suggestions.length > 0 ? (
    <div className="flex flex-wrap gap-1.5">
      {assistant.suggestions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onAsk(q)}
          className={clsx('inline-flex h-6 items-center rounded-full border border-app-border bg-surface px-2.5 text-compact text-app-text-secondary transition-colors hover:border-primary/40 hover:text-app-text', FOCUS_RING)}
        >
          {q}
        </button>
      ))}
    </div>
  ) : null;
  const pinned = <div className="space-y-3">{suggestions}{checklist}{composer}</div>;
  const body: ReactNode = (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 bg-surface">
        <PanelHeading tag={assistant.tag} tagIcon={MessageSquare}>{assistant.description}</PanelHeading>
      </div>
      <ol className="flex-1 space-y-4 px-4 py-4">
        {assistant.turns.map((t, i) => (
          t.role === 'user' ? (
            <li key={i} className="ml-10 rounded-2xl bg-app-user-bubble px-3.5 py-2.5 text-prose leading-6 text-app-text">
              <RichText text={t.text} pageLabel={copy.common.page} />
            </li>
          ) : (
            <li key={i} className="text-prose leading-6 text-app-text-body">
              <RichText text={t.text} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
            </li>
          )
        ))}
        <li key={assistant.turns.length} ref={showNewest} aria-hidden="true" className="h-0" />
        {busy && <li className="text-prose text-app-text-tertiary" role="status">{copy.work.record.assistantBusy}</li>}
      </ol>
    </div>
  );
  if (fill) {
    return (
      <aside className="flex min-h-0 flex-1 flex-col bg-surface">
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        <div className="shrink-0 border-t border-app-border px-4 py-3">{pinned}</div>
      </aside>
    );
  }
  return <SidePanel width={340} footer={pinned}>{body}</SidePanel>;
}
