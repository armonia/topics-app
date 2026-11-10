import type { UiCopy } from '../copy/types';
import { Select, TextField } from '../primitives/Field';
import type { BoardColumnId } from './model';

export interface NewCardValues {
  title: string;
  org: string;
  column: BoardColumnId;
  /** YYYY-MM-DD or empty. */
  due: string;
}

/** The fields of the «new card» dialog. The container owns the values and the way they are saved. */
export function NewCardForm({ values, onChange, orgOptions, columnOptions, titleError, copy, onEnter }: {
  values: NewCardValues;
  onChange: (patch: Partial<NewCardValues>) => void;
  orgOptions: Array<{ value: string; label: string }>;
  columnOptions: Array<{ value: BoardColumnId; label: string }>;
  titleError?: string;
  copy: UiCopy;
  onEnter: () => void;
}) {
  const f = copy.orgs.board.form;
  return (
    <div className="flex flex-col gap-3.5">
      <TextField label={f.title} placeholder={f.titlePlaceholder} value={values.title} onChange={(v) => onChange({ title: v })} error={titleError} autoFocus onEnter={onEnter} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select label={f.org} value={values.org} options={orgOptions} onChange={(v) => onChange({ org: v })} />
        <Select label={f.column} value={values.column} options={columnOptions} onChange={(v) => onChange({ column: v as BoardColumnId })} />
      </div>
      <TextField label={f.due} type="date" value={values.due} onChange={(v) => onChange({ due: v })} hint={f.dueHint} />
    </div>
  );
}
