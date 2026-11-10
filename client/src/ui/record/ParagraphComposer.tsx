import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/Field';

/** The box under the draft where the reader writes a paragraph to add: the tools of the bar above set how it will look. */
export function ParagraphComposer({ value, onChange, onAdd, copy }: {
  value: string;
  onChange: (value: string) => void;
  onAdd?: Action;
  copy: UiCopy;
}) {
  const r = copy.work.record;
  return (
    <div className="rounded-lg border border-app-border bg-surface p-3 font-sans">
      <TextArea label={r.paragraphLabel} value={value} onChange={onChange} placeholder={r.paragraphPlaceholder} rows={3} />
      <div className="mt-2 flex justify-end">
        <Button onClick={onAdd}>{r.paragraphAdd}</Button>
      </div>
    </div>
  );
}
