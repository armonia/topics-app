import { Search, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button, IconButton } from '../primitives/Button';
import { TextField } from '../primitives/Field';
import { FOCUS_RING } from '../shell/pressable';

/**
 * The question box of the knowledge base: one line, the button that asks, and
 * the questions people usually ask. The answer is the caller's, so the box
 * is a controlled field plus two handlers.
 */
export function AskBox({ copy, value, onChange, onAsk, suggestions, onClear, asked }: {
  copy: UiCopy;
  value: string;
  onChange: (v: string) => void;
  /** Called with the question as typed; an empty one is the caller's to answer (a toast). */
  onAsk: (question: string) => void;
  suggestions: string[];
  /** Clears the answer on show; offered only while there is one. */
  onClear?: () => void;
  asked?: boolean;
}) {
  const c = copy.knowledgeMore.collections;
  return (
    <div className="space-y-2.5">
      <div className="flex items-end gap-2 rounded-xl border border-primary/40 bg-sky-500/[0.06] p-2.5 shadow-[0_0_0_3px_rgba(0,102,255,0.08)]">
        <TextField
          className="flex-1"
          icon={Search}
          label={undefined}
          value={value}
          onChange={onChange}
          placeholder={c.askPlaceholder}
          onEnter={() => onAsk(value.trim())}
          title={c.askLabel}
        />
        {asked && onClear && <IconButton icon={X} label={c.clearAsk} onClick={onClear} />}
        <Button variant="primary" onClick={() => onAsk(value.trim())}>{c.askButton}</Button>
      </div>
      {!asked && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-compact text-app-text-tertiary">{c.askTry}</span>
          {suggestions.map((q) => (
            <button key={q} type="button" onClick={() => onAsk(q)} className={clsx('max-w-full rounded text-left', FOCUS_RING)}>
              <span className="inline-block max-w-full rounded bg-black/[0.05] px-1.5 py-0.5 text-left text-mini leading-4 text-app-text-secondary hover:bg-black/[0.08] dark:bg-white/[0.08]">{q}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
