import { Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import { Select, TextArea, TextField } from '../primitives/Field';
import { FOCUS_RING } from '../shell/pressable';
import type { BlockId } from './model';

/**
 * «Crea una vista»: a name, the blocks picked from the catalogue, the kind of (allow-italian: quotes the Italian interface)
 * record it is for, and, if the reader prefers, a description in words from
 * which the blocks are proposed. Everything is the caller's state.
 */
export function CreateViewDialog({ copy, name, onName, description, onDescription, blocks, onToggleBlock, onSuggest, kind, onKind, kinds, blockOptions, error, onSubmit, onClose }: {
  copy: UiCopy;
  name: string;
  onName: (v: string) => void;
  description: string;
  onDescription: (v: string) => void;
  blocks: BlockId[];
  onToggleBlock: (id: BlockId) => void;
  onSuggest: () => void;
  kind: string;
  onKind: (v: string) => void;
  kinds: Array<{ value: string; label: string }>;
  blockOptions: Array<{ id: BlockId; name: string }>;
  /** Why the form cannot be sent yet, shown after the first try. */
  error?: { name?: string; blocks?: string };
  onSubmit: () => void;
  onClose: () => void;
}) {
  const v = copy.viewsMore.create;
  return (
    <Dialog
      title={v.title}
      size="md"
      onClose={onClose}
      closeLabel={copy.common.close}
      footer={(
        <>
          <Button onClick={onClose}>{v.cancel}</Button>
          <Button variant="primary" onClick={onSubmit}>{v.submit}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <TextField label={v.name} value={name} onChange={onName} placeholder={v.namePlaceholder} error={error?.name} autoFocus onEnter={onSubmit} />
        <div className="flex flex-col gap-2">
          <TextArea label={v.describe} value={description} onChange={onDescription} placeholder={v.describePlaceholder} rows={2} hint={v.describeHint} />
          <div>
            <Button size="sm" icon={Sparkles} onClick={onSuggest}>{v.suggest}</Button>
          </div>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1 text-mini font-medium text-app-text-secondary">{v.blocks}</legend>
          <div className="flex flex-wrap gap-1.5">
            {blockOptions.map((b) => {
              const on = blocks.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggleBlock(b.id)}
                  className={clsx(
                    'inline-flex h-7 items-center rounded-lg border px-2.5 text-compact transition-colors',
                    FOCUS_RING,
                    on ? 'border-primary bg-primary/10 text-app-text' : 'border-app-border text-app-text-secondary hover:bg-app-hover',
                  )}
                >
                  {b.name}
                </button>
              );
            })}
          </div>
          {error?.blocks ? <p className="text-mini text-rose-600 dark:text-rose-400">{error.blocks}</p> : <p className="text-mini text-app-text-tertiary">{v.blocksHint}</p>}
        </fieldset>
        <Select label={v.kind} value={kind} onChange={onKind} options={kinds} />
      </div>
    </Dialog>
  );
}
