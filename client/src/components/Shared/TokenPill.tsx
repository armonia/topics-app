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
        // THE RING THAT ESCAPED THE FIELD. The app's one focus rule
        // (index.css, @layer base) paints `outline: 2px solid var(--primary)`
        // with `outline-offset: 2px` on every button. Around a 12px X inside a
        // 24px-tall filter shell that ring is drawn OUTSIDE the rounded
        // rectangle, and reads as a border sprouting off the control.
        // allow-italian: «esce un bordo quando faccio focus» (29/08)
        //
        // Silenced AND replaced in the same place: a ring is a box-shadow, so
        // it costs no layout, and `ring-inset` cannot leave the box by
        // construction. Dropping the outline without putting the ring back
        // would leave this button - which is also the chat's @-mention pill -
        // with no visible focus at all.
        className="ml-0.5 rounded-sm text-blue-400 hover:text-blue-600 dark:hover:text-blue-200 outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70"
      >
        <X size={12} />
      </button>
    </span>
  );
}
