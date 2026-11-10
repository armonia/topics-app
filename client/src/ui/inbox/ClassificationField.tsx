import { useState, type ReactNode } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { ClassificationFieldModel } from './model';

/** Under this confidence a proposed value reads amber: look at it before confirming. */
const SURE = 85;

const ICON_BUTTON = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-app-text-secondary transition-colors hover:bg-black/[0.06] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]';

/**
 * A proposed value: its label above, the value in a field, the confidence on
 * the right. A value the person changed says so instead of a percentage, and
 * the field that is being explained is outlined; its explanation (`children`)
 * hangs right under it. With `onExplain` the value box is a button that asks
 * for that explanation; with `onEdit` a pencil beside it turns the box into an
 * input (`editing` opens it from outside, e.g. from the origin of the value).
 */
export function ClassificationField({ field, focused, copy, onExplain, onEdit, editing, onCancelEdit, children }: {
  field: ClassificationFieldModel;
  focused?: boolean;
  copy: UiCopy;
  onExplain?: () => void;
  onEdit?: (value: string) => void;
  editing?: boolean;
  onCancelEdit?: () => void;
  children?: ReactNode;
}) {
  const [typing, setTyping] = useState(false);
  /* null: nothing typed yet, the input starts from the value on show. */
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? field.value;
  const open = Boolean(onEdit) && (typing || Boolean(editing));
  const sure = (field.confidence ?? 100) >= SURE;

  const start = () => {
    setDraft(null);
    setTyping(true);
  };
  const stop = () => {
    setTyping(false);
    setDraft(null);
    onCancelEdit?.();
  };
  const save = () => {
    const next = text.trim();
    setTyping(false);
    setDraft(null);
    if (!next || next === field.value) {
      onCancelEdit?.();
      return;
    }
    onEdit?.(next);
  };

  const boxClass = clsx(
    'flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-1.5 text-prose',
    field.corrected
      ? 'border border-amber-500/70 bg-amber-500/10'
      : 'bg-black/[0.04] dark:bg-white/[0.06]',
    focused && 'ring-2 ring-primary/50',
    onExplain && 'cursor-pointer text-left hover:ring-2 hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
  );
  const box = (
    <>
      <span className="min-w-0 flex-1 text-app-text [overflow-wrap:break-word]" data-tip={field.value}>{field.value}</span>
      {field.corrected ? (
        <span className="shrink-0 text-compact font-medium text-amber-700 dark:text-amber-400">{copy.inbox.correctedByYou}</span>
      ) : field.confirmed ? (
        <span className="shrink-0 text-compact font-medium text-emerald-700 dark:text-emerald-400">{copy.work.inbox.confirmedField}</span>
      ) : field.confidence !== undefined ? (
        <span
          data-tip={copy.inbox.confidence(field.confidence)}
          className={clsx('shrink-0 text-compact font-semibold tabular-nums', sure ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}
        >
          {field.confidence}%
        </span>
      ) : null}
    </>
  );
  return (
    <div className="relative min-w-0">
      <div className="mb-1 text-compact text-app-text-tertiary">{field.label}</div>
      {open ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={text}
            aria-label={field.label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') stop();
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-primary/60 bg-surface px-3 text-prose text-app-text outline-none ring-2 ring-primary/20"
          />
          <button type="button" onClick={save} aria-label={copy.work.inbox.saveValue} data-tip={copy.work.inbox.saveValue} className={ICON_BUTTON}>
            <Check size={15} aria-hidden="true" />
          </button>
          <button type="button" onClick={stop} aria-label={copy.common.close} data-tip={copy.common.close} className={ICON_BUTTON}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex items-start gap-1">
          {onExplain ? (
            <button type="button" onClick={onExplain} data-tip={copy.preview.whereFrom} aria-label={copy.inbox.why(field.value)} aria-pressed={focused} className={boxClass}>
              {box}
            </button>
          ) : (
            <div className={boxClass}>{box}</div>
          )}
          {onEdit && (
            <button type="button" onClick={start} aria-label={copy.work.inbox.editValue(field.label)} data-tip={copy.work.inbox.editValue(field.label)} className={ICON_BUTTON}>
              <Pencil size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
