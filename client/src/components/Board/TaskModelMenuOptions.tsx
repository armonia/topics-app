/**
 * TaskModelMenuOptions - the rows inside a task model picker, once.
 *
 * The composer and the task drawer both offer the same choice: Auto, then one
 * row per executable model. They drew it twice, with two copies of the same
 * markup, and the copies had already started to drift (one truncated long
 * labels, the other did not). This component owns the rows. The `Menu`
 * popover around them stays in each caller, because positioning, Escape and
 * focus restore belong to the surface, not to the list.
 *
 * WHAT "AUTO" MEANS HERE. It is `null`, and it is not a placeholder for
 * "nothing chosen". The server picks a real model across the compatible
 * connected runtimes (`server/services/task-auto-model.ts`). The row is
 * therefore a first-class choice with a check mark of its own, and each
 * surface passes its own translated label because the two use different i18n
 * keys.
 *
 * WHAT THIS COMPONENT DOES NOT DO: it never reconciles `value` against
 * `models`. A model whose provider just disconnected drops out of the list
 * while the task keeps it stored, and the chip must keep saying so. Selecting
 * something else on the user's behalf would be a silent change to what the
 * agent runs on.
 */
import { Check, Sparkles } from 'lucide-react';
import { friendlyModelLabel } from './format';
import { POPOVER_ITEM } from '../../lib/popoverStyles';

interface Props {
  /** The live catalog, already filtered to executable coding runtimes. */
  models: string[];
  /** Currently selected model id, or `null` for Auto. */
  value: string | null;
  onSelect: (model: string | null) => void;
  /** Locks every row while a write is in flight. */
  disabled?: boolean;
  /** Caller-translated label for the Auto row. */
  autoLabel: string;
  /** Draw the sparkle glyph on the Auto row (the drawer does, the composer does not). */
  autoIcon?: boolean;
  /** Optional tooltip on the Auto row (the composer explains what Auto does). */
  autoTitle?: string;
}

export function TaskModelMenuOptions({ models, value, onSelect, disabled, autoLabel, autoIcon, autoTitle }: Props) {
  return (
    <>
      <button
        role="option" aria-selected={value === null} disabled={disabled}
        onClick={() => onSelect(null)}
        title={autoTitle}
        className={`${POPOVER_ITEM} disabled:opacity-40`}
      >
        {autoIcon && <Sparkles className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />}
        <span className="min-w-0 flex-1 truncate">{autoLabel}</span>
        {value === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
      </button>
      {models.map((m) => (
        <button
          key={m} role="option" aria-selected={value === m} disabled={disabled}
          onClick={() => onSelect(m)}
          className={`${POPOVER_ITEM} disabled:opacity-40`}
        >
          <span className="min-w-0 flex-1 truncate">{friendlyModelLabel(m)}</span>
          {value === m && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
        </button>
      ))}
    </>
  );
}
