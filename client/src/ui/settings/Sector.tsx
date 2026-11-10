import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { Chip } from '../primitives/Chip';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/Field';
import { FOCUS_RING } from '../shell/pressable';

export interface PackageCardModel {
  id: string;
  name: string;
  /** The organization that runs it, when there is one. */
  org?: string;
  badges: Array<{ label: string; tone: 'green' | 'blue' | 'neutral' }>;
  /** One line of what it brings, e.g. «7 tipi · 6 modelli». */
  summary: string;
  /** Whether this is the package on show (the preview), not necessarily the active one. */
  selected: boolean;
  onSelect: () => void;
}

/** A sector package: a radio card, the one on show is lit. Choosing it previews how labels change. */
export function PackageCards({ items, ariaLabel }: { items: PackageCardModel[]; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid min-w-0 gap-3 sm:grid-cols-2">
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={p.selected}
          onClick={p.onSelect}
          className={clsx(
            'flex min-w-0 flex-col gap-1.5 rounded-lg border px-3.5 py-3 text-left transition-colors',
            FOCUS_RING,
            p.selected ? 'border-primary bg-primary/[0.05] ring-1 ring-primary' : 'border-app-border bg-surface hover:border-app-border-light hover:bg-app-hover',
          )}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-prose font-semibold text-app-text">{p.name}</span>
            {p.org && <Chip>{p.org}</Chip>}
            {p.badges.map((b) => <Chip key={b.label} tone={b.tone}>{b.label}</Chip>)}
          </span>
          <span className="text-compact text-app-text-secondary">{p.summary}</span>
        </button>
      ))}
    </div>
  );
}

export interface VocabularyRowModel {
  id: string;
  generic: string;
  word: string;
  /** The word of the package on show, when it is not the active one. */
  other?: string;
  edited: boolean;
  editLabel: string;
  onChange: (v: string) => void;
  /** Set while the typed word differs from the saved one. */
  onSave?: () => void;
  onReset: () => void;
}

/** The vocabulary: each generic word of Topics against the one this organization uses, editable in place. */
export function VocabularyList({ rows, labels, resetLabel, saveLabel, editedLabel, disabled, disabledTitle }: {
  rows: VocabularyRowModel[];
  labels: { generic: string; word: string; other?: string };
  resetLabel: string;
  saveLabel: string;
  editedLabel: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const grid = labels.other ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]';
  return (
    <div role="table" aria-label={labels.word} className="overflow-hidden rounded-lg border border-app-border">
      <div role="row" className={clsx('hidden items-center gap-3 border-b border-app-border bg-app-inset px-3 py-2 text-compact font-medium text-app-text-secondary sm:grid', grid)}>
        <span role="columnheader">{labels.generic}</span>
        <span role="columnheader">{labels.word}</span>
        {labels.other && <span role="columnheader">{labels.other}</span>}
      </div>
      {rows.map((r) => (
        <div key={r.id} role="row" className={clsx('grid items-center gap-x-3 gap-y-1.5 border-b border-app-border px-3 py-2 last:border-b-0', grid)}>
          <span role="cell" className="text-prose font-medium text-app-text">{r.generic}</span>
          <span role="cell" className="flex min-w-0 items-center gap-1.5">
            <TextField size="sm" value={r.word} onChange={r.onChange} onEnter={r.onSave} title={disabledTitle ?? r.editLabel} placeholder={r.editLabel} disabled={disabled} className="min-w-0 flex-1" />
            {r.onSave && !disabled && <Button size="sm" variant="primary" onClick={r.onSave}>{saveLabel}</Button>}
            {r.edited && !r.onSave && <Chip tone="blue">{editedLabel}</Chip>}
            {r.edited && !r.onSave && !disabled && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={r.onReset} title={resetLabel}><span className="sr-only">{resetLabel}</span></Button>
            )}
          </span>
          {labels.other && <span role="cell" className="text-prose text-app-text-secondary">{r.other}</span>}
        </div>
      ))}
    </div>
  );
}

/** The sample lines that show how the labels read with the words of a package. */
export function LabelPreview({ lines }: { lines: Array<{ where: string; text: string }> }) {
  return (
    <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
      {lines.map((l) => (
        <li key={l.where} className="min-w-0 rounded-lg bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]">
          <div className="text-mini uppercase tracking-[0.06em] text-app-text-tertiary">{l.where}</div>
          <div className="truncate text-prose font-medium text-app-text">{l.text}</div>
        </li>
      ))}
    </ul>
  );
}

/** A group of what the package brings (the types, the templates, ...) under its title. */
export function BringGroup({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{title}</h3>
        {count && <span className="text-mini text-app-text-tertiary">{count}</span>}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** One thing the package brings, with the way to its place when it has one. */
export function BringItem({ label, detail, action }: { label: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-app-border py-1.5 first:border-t-0">
      <span className="min-w-[140px] flex-1 text-prose leading-5 text-app-text">{label}</span>
      {detail && <span className="shrink-0 text-compact tabular-nums text-app-text-tertiary">{detail}</span>}
      {action}
    </div>
  );
}
