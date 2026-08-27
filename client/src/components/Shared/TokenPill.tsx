import { X } from 'lucide-react';

/**
 * TokenPill — the small removable chip behind every "type, pick, see a chip"
 * field in the app: the chat's @-file mentions (`FilePill`, which now wraps
 * this) and the board's priority/assignee filter (`FilterTokenField`). One
 * shape, one place that draws the remove button, so a new token field does not
 * hand-roll its own chip.
 */
export function TokenPill({ icon, label, onRemove, removeLabel, title, className }: {
  icon?: React.ReactNode;
  label: string;
  onRemove: () => void;
  /** Accessible name of the remove button — the caller passes it translated
   *  (see `FilePill`'s `ctx.removeFile`), TokenPill stays i18n-agnostic. */
  removeLabel: string;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={className ?? 'inline-flex items-center gap-1 shrink-0 bg-blue-100/80 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-md px-2 py-0.5 text-[11px] font-medium'}
    >
      {icon}
      <span className="truncate max-w-[120px]">{label}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="ml-0.5 text-blue-400 hover:text-blue-600 dark:hover:text-blue-200"
      >
        <X size={12} />
      </button>
    </span>
  );
}
