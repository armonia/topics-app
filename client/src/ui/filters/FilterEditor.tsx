import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import type { FiltersCopy } from '../copy/filters';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/Field';
import { Popover } from '../primitives/Popover';
import type { FilterDraft, FilterFieldModel, FilterOp, FilterValueModel } from './model';
import { PickList, type PickItem } from './PickList';

export type FilterStep = 'field' | 'op' | 'value';

/** More rows than this and the list gets a search box. */
const SEARCH_FROM = 6;

/** Where a popover of the bar stands: under its trigger, or as a sheet on a phone. */
export const SHEET = 'fixed inset-x-2 bottom-2 top-auto mt-0 w-auto max-h-[80dvh]';
export const DROP = 'w-72 max-w-[calc(100vw-16px)]';

/**
 * One filter built a step at a time: the field (with search), the condition,
 * the value (the real values with an icon and a count, with search; a date
 * picker for a date; a number of days for `within`). Backspace on an empty
 * search goes back a step, Escape closes. It owns only the step and the draft;
 * `onCommit` gets the finished filter. Opened on a token it starts at the part
 * that was clicked.
 */
export function FilterEditor({ copy, fields, valuesOf, initial, step: first, onCommit, onClose, phone }: {
  copy: FiltersCopy;
  fields: FilterFieldModel[];
  valuesOf: (field: string) => FilterValueModel[];
  initial?: Partial<FilterDraft>;
  step: FilterStep;
  onCommit: (draft: FilterDraft) => void;
  onClose: () => void;
  phone?: boolean;
}) {
  const [step, setStep] = useState<FilterStep>(first);
  const [draft, setDraft] = useState<Partial<FilterDraft>>(initial ?? {});
  const [typed, setTyped] = useState(initial?.value ?? '');
  const field = fields.find((f) => f.id === draft.field);
  const singleOp = field?.ops.length === 1;

  const toValue = (next: Partial<FilterDraft>) => {
    setDraft(next);
    setTyped(next.value ?? '');
    setStep('value');
  };
  const pickField = (id: string) => {
    const f = fields.find((x) => x.id === id);
    if (!f) return;
    const op = draft.field === id && draft.op && f.ops.includes(draft.op) ? draft.op : f.ops[0];
    const keep = draft.field === id ? draft.value : undefined;
    if (f.ops.length === 1) toValue({ field: id, op, value: keep });
    else {
      setDraft({ field: id, op, value: keep });
      setStep('op');
    }
  };
  const pickOp = (op: FilterOp) => toValue({ ...draft, op, value: (op === 'within') === (draft.op === 'within') ? draft.value : undefined });
  const back = () => setStep(step === 'value' && !singleOp ? 'op' : 'field');
  const commit = (value: string) => {
    if (draft.field && draft.op && value) onCommit({ field: draft.field, op: draft.op, value });
  };

  const title = step === 'field' ? copy.stepField : step === 'op' ? copy.stepOp : copy.stepValue;
  const kind = field?.kind;
  const days = draft.op === 'within';

  let body;
  if (step === 'field') {
    body = (
      <PickList
        key="field"
        items={fields.map((f): PickItem => ({ id: f.id, label: f.label, icon: f.icon, selected: f.id === draft.field }))}
        onPick={pickField}
        onClose={onClose}
        searchable={fields.length > SEARCH_FROM}
        placeholder={copy.pickFieldPlaceholder}
        ariaLabel={copy.stepField}
        empty={copy.noMatch}
      />
    );
  } else if (step === 'op' && field) {
    body = (
      <PickList
        key="op"
        items={field.ops.map((op): PickItem => ({ id: op, label: copy.ops[op], selected: op === draft.op }))}
        onPick={(id) => pickOp(id as FilterOp)}
        onBack={back}
        onClose={onClose}
        placeholder={copy.stepOp}
        ariaLabel={copy.stepOp}
        empty={copy.noMatch}
      />
    );
  } else if (field && kind === 'choice') {
    const values = valuesOf(field.id);
    body = (
      <PickList
        key="value"
        items={values.map((v): PickItem => ({ id: v.value, label: v.label, icon: v.icon, count: v.count, selected: v.value === draft.value }))}
        onPick={commit}
        onBack={back}
        onClose={onClose}
        searchable={values.length > SEARCH_FROM}
        placeholder={copy.pickValuePlaceholder}
        ariaLabel={copy.stepValue}
        empty={values.length ? copy.noMatch : copy.noValues}
      />
    );
  } else if (field) {
    const ready = days ? /^\d+$/.test(typed) && Number(typed) > 0 : typed !== '';
    body = (
      <div
        key="value"
        className="flex flex-col gap-2 p-2"
        onKeyDown={(e) => {
          // Backspace on an empty text or number box goes back a step.
          if (e.key === 'Backspace' && !e.repeat && typed === '' && (days || kind !== 'date') && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            back();
          }
        }}
      >
        <TextField
          lang={copy.lang}
          autoFocus
          size="sm"
          type={days ? 'number' : kind === 'date' ? 'date' : 'text'}
          label={days ? copy.daysLabel : kind === 'date' ? copy.dateLabel : copy.textLabel}
          value={typed}
          onChange={setTyped}
          onEnter={() => ready && commit(typed.trim())}
        />
        <Button size="sm" variant="primary" onClick={ready ? () => commit(typed.trim()) : false} className="self-end">{copy.apply}</Button>
      </div>
    );
  }

  return (
    <Popover ariaLabel={copy.addFilterLabel} onClose={onClose} fixed={phone} className={clsx(phone ? SHEET : DROP, 'overflow-hidden')}>
      <div className="flex h-8 items-center gap-1.5 border-b border-app-border px-2 text-mini text-app-text-secondary">
        {step !== 'field' && (
          <button
            type="button"
            aria-label={copy.back}
            data-tip={copy.back}
            onClick={back}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
        )}
        <span className="font-medium text-app-text">{title}</span>
        {field && step !== 'field' && (
          <span className="flex min-w-0 items-center gap-1 truncate pl-1">
            <field.icon size={12} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{field.label}</span>
            {draft.op && step === 'value' && <span className="shrink-0 text-app-text-tertiary">{copy.ops[draft.op]}</span>}
          </span>
        )}
      </div>
      {body}
    </Popover>
  );
}
