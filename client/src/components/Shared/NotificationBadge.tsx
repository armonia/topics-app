/**
 * NotificationBadge — small primary-coloured pill showing an unread or
 * activity count. Single canonical look across the app (sidebar topic
 * row, sidebar project row, sidebar section header, top tab bar).
 *
 * - Auto-hides when count <= 0 (the parent doesn't have to gate the
 *   render conditionally; this matches the previous inline contract at
 *   every call site).
 * - Caps display at "99+" so a runaway counter doesn't blow the layout.
 *
 * Don't roll your own pill in a new surface — drop this in. If you
 * genuinely need a different colour or size, extend with a variant
 * prop rather than copy-pasting the className.
 */

interface NotificationBadgeProps {
  count: number;
  /** Extra wrapper classes (margins, visibility toggles like
   *  `group-hover/proj:hidden`). */
  className?: string;
  /** Optional accessible label override; defaults to "{n} unread". */
  ariaLabel?: string;
  /** Optional tooltip. */
  title?: string;
  /** `onFill` = the badge sits ON an attention fill (amber/blue). Use a
   *  translucent-white pill so it stays legible instead of the default
   *  primary-blue, which rendered blue-on-blue (invisible) on the awaiting fill. */
  variant?: 'default' | 'onFill';
}

export function NotificationBadge({ count, className = '', ariaLabel, title, variant = 'default' }: NotificationBadgeProps) {
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);
  // `onFill`: a translucent-black pill + white text reads on BOTH attention
  // fills (dark-text amber AND white-text blue), where the default primary-blue
  // pill went blue-on-blue (invisible) on the awaiting surface.
  const tone = variant === 'onFill'
    ? 'bg-black/35 text-white'
    : 'bg-primary text-white';
  return (
    <span
      className={`flex-shrink-0 ${tone} text-[11px] font-semibold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 leading-none ${className}`}
      aria-label={ariaLabel ?? `${count} unread`}
      title={title}
    >
      {display}
    </span>
  );
}
