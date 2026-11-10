import { Search } from 'lucide-react';
import clsx from 'clsx';
import { KeyHint } from '../primitives/Chip';
import { FOCUS_RING } from './pressable';

/**
 * The search pill of the top bar: 28px like the chrome buttons, the same
 * `raised-control` fill, a magnifier, what it searches and the shortcut that
 * opens it. `compact` keeps the magnifier alone (a phone, a narrow bar) and
 * the label as its accessible name.
 */
export function SearchButton({ label, shortcut, onClick, compact, className }: {
  label: string;
  /** The key that opens the search, as printed: `⌘K`. */
  shortcut: string;
  onClick: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      data-search-button=""
      aria-label={compact ? label : undefined}
      data-tip={compact ? `${label} ${shortcut}` : undefined}
      className={clsx(
        'raised-control inline-flex h-7 shrink-0 items-center rounded-lg text-app-text-secondary transition-colors hover:text-app-text',
        FOCUS_RING,
        compact ? 'w-7 justify-center' : 'w-[240px] min-w-[150px] max-w-full shrink gap-2 pl-2.5 pr-1.5',
        className,
      )}
    >
      <Search size={compact ? 15 : 14} className="shrink-0" aria-hidden="true" />
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate text-left text-compact">{label}</span>
          <KeyHint>{shortcut}</KeyHint>
        </>
      )}
    </button>
  );
}
