import { useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';
import type { FiltersCopy } from '../copy/filters';
import { FOCUS_RING } from '../shell/pressable';
import { FilterEditor, type FilterStep } from './FilterEditor';
import type { FilterDraft, FilterFieldModel, FilterTokenModel, FilterValueModel } from './model';

/** The size of every control of the bar: `md` 28px, `sm` 24px. */
export const BAR_SIZE = {
  md: { row: 'h-7 text-compact', icon: 14 },
  sm: { row: 'h-6 text-mini', icon: 12 },
} as const;

export type BarSize = keyof typeof BAR_SIZE;

const SEGMENT = clsx('inline-flex h-full min-w-0 items-center gap-1 px-1.5 transition-colors hover:bg-sky-500/15', FOCUS_RING, 'focus-visible:ring-inset');

/**
 * A filter on show: «field · condition · value» with the glyph of the field,
 * each part a button that opens the picker at that step, and a cross that
 * takes the filter off. It owns only which step is open; the new filter goes
 * out through `onChange`.
 */
export function FilterToken({ token, copy, fields, valuesOf, onChange, onRemove, size, phone }: {
  token: FilterTokenModel;
  copy: FiltersCopy;
  fields: FilterFieldModel[];
  valuesOf: (field: string) => FilterValueModel[];
  onChange: (draft: FilterDraft) => void;
  onRemove: () => void;
  size: BarSize;
  phone?: boolean;
}) {
  const [open, setOpen] = useState<FilterStep | null>(null);
  const triggers = useRef<Partial<Record<FilterStep, HTMLButtonElement | null>>>({});
  const s = BAR_SIZE[size];
  const Icon = token.icon;
  const ValueIcon = token.valueIcon;
  const label = `${token.fieldLabel} ${token.opLabel} ${token.valueLabel}`;
  const close = (step: FilterStep) => {
    setOpen(null);
    triggers.current[step]?.focus({ preventScroll: true });
  };
  const trigger = (step: FilterStep, tip: string, children: ReactNode, className?: string) => (
    <button
      ref={(el) => {
        triggers.current[step] = el;
      }}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open === step}
      aria-label={tip}
      data-tip={tip}
      onClick={() => setOpen(open === step ? null : step)}
      className={clsx(SEGMENT, className)}
    >
      {children}
    </button>
  );
  return (
    <span
      role="group"
      aria-label={label}
      className={clsx('relative inline-flex max-w-full shrink-0 items-stretch overflow-visible rounded-lg bg-sky-500/15 font-medium text-sky-800 dark:text-sky-300', s.row)}
    >
      {trigger('field', copy.editField(token.fieldLabel), (
        <>
          <Icon size={s.icon - 2} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{token.fieldLabel}</span>
        </>
      ), 'rounded-l-lg pl-2')}
      {trigger('op', copy.editOp(token.fieldLabel), <span className="font-normal opacity-75">{token.opLabel}</span>)}
      {trigger('value', copy.editValue(token.fieldLabel), (
        <>
          {ValueIcon && <ValueIcon size={s.icon - 2} className="shrink-0" aria-hidden="true" />}
          <span className="max-w-[12rem] truncate">{token.valueLabel}</span>
        </>
      ))}
      <button
        type="button"
        aria-label={copy.removeToken(label)}
        data-tip={copy.removeToken(label)}
        onClick={onRemove}
        className={clsx('inline-flex h-full w-6 shrink-0 items-center justify-center rounded-r-lg transition-colors hover:bg-sky-500/20', FOCUS_RING, 'focus-visible:ring-inset')}
      >
        <X size={s.icon - 2} aria-hidden="true" />
      </button>
      {open && (
        <FilterEditor
          copy={copy}
          fields={fields}
          valuesOf={valuesOf}
          initial={{ field: token.field, op: token.op, value: token.value }}
          step={open}
          phone={phone}
          onCommit={(draft) => {
            onChange(draft);
            close(open);
          }}
          onClose={() => close(open)}
        />
      )}
    </span>
  );
}
