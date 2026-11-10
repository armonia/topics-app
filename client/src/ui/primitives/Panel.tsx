import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

/** The small uppercase heading over a group of rows. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary', className)}>
      {children}
    </div>
  );
}

/**
 * The column on the right of a pane: a header block, then sections divided by
 * hairlines, then an optional footer pinned to the bottom (a primary action).
 */
export function SidePanel({ width = 360, children, footer, className }: {
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <aside style={{ width }} className={clsx('flex h-full shrink-0 flex-col border-l border-app-border bg-surface', className)}>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && <div className="shrink-0 border-t border-app-border px-4 py-3">{footer}</div>}
    </aside>
  );
}

/** The opening block of a side panel: a tag, a title and one or two lines. */
export function PanelHeading({ tag, tagIcon, title, children }: {
  tag?: string;
  tagIcon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const TagIcon = tagIcon;
  return (
    <div className="border-b border-app-border px-4 pb-4 pt-4">
      {tag && (
        <span className="mb-2 inline-flex h-5 items-center gap-1 rounded bg-black/[0.05] px-1.5 text-mini text-app-text-secondary dark:bg-white/10">
          {TagIcon && <TagIcon size={12} aria-hidden="true" />}
          {tag}
        </span>
      )}
      {title && <h3 className="text-body-lg font-semibold leading-5 text-app-text">{title}</h3>}
      {children && <div className="mt-1 text-prose leading-5 text-app-text-secondary">{children}</div>}
    </div>
  );
}

export function PanelSection({ label, children, className }: { label?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('border-b border-app-border px-4 py-3.5', className)}>
      {label && <SectionLabel className="mb-2.5">{label}</SectionLabel>}
      {children}
    </section>
  );
}

/**
 * One fact as a row: what it is on the left (an optional chip, then the name),
 * its value on the right, and an optional quiet hint (the type, in mono) just
 * before the value.
 */
export function KeyValue({ lead, label, hint, value, valueClassName }: {
  lead?: ReactNode;
  label: ReactNode;
  hint?: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 py-0.5 text-prose leading-5">
      {lead}
      {/* The name wraps too: cut with dots, it lost the word that said what the value was. */}
      <span className="min-w-0 max-w-[55%] shrink-0 text-app-text [overflow-wrap:break-word]">{label}</span>
      {/* A long value wraps under itself instead of pushing past the edge. */}
      <span className="ml-auto flex min-w-0 items-center justify-end gap-2">
        {hint && <span className="shrink-0 font-mono text-nano text-app-text-faint">{hint}</span>}
        <span className={clsx('text-right tabular-nums text-app-text', valueClassName)}>{value}</span>
      </span>
    </div>
  );
}
