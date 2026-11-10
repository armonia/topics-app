import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

/**
 * What a place shows when its content is not there: a glyph, one line that says
 * so plainly, an optional sentence, and the way on. `data-empty` marks it, so a
 * test can tell an honest empty place from a broken one.
 */
export function EmptyState({ icon: Icon, title, children, action, className }: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div data-empty="true" className={clsx('flex min-h-full flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center', className)}>
      {Icon && (
        <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.05] text-app-text-tertiary dark:bg-white/[0.08]">
          <Icon size={18} aria-hidden="true" />
        </span>
      )}
      <p className="max-w-[440px] text-body-lg font-semibold text-app-text">{title}</p>
      {children && <div className="max-w-[440px] text-prose leading-6 text-app-text-secondary">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
