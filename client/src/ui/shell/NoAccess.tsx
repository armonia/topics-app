import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';

/**
 * A place the current person may not open: the shape of EmptyState with a
 * lock, one line that says so, why, and an optional way on (ask for access,
 * go back). `data-noaccess` marks it, so a test can tell it from a broken page.
 */
export function NoAccess({ title, body, action }: { title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div data-noaccess="true" className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center">
      <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.05] text-app-text-tertiary dark:bg-white/[0.08]">
        <Lock size={18} aria-hidden="true" />
      </span>
      <p className="max-w-[440px] text-body-lg font-semibold text-app-text">{title}</p>
      <div className="max-w-[440px] text-prose leading-6 text-app-text-secondary">{body}</div>
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
