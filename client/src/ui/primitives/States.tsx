import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import clsx from 'clsx';
import { Spinner } from './Progress';

/** A grey bar that shimmers where text will be (`.skeleton` in index.css). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={clsx('skeleton block h-3 rounded', className)} />;
}

const LINE_WIDTHS = ['w-11/12', 'w-4/5', 'w-2/3', 'w-5/6', 'w-3/5'];

/**
 * A place whose content is on its way: one line that says what is loading,
 * then the shape of the text to come. `data-loading` marks it, so a test can
 * tell a slow place from an empty one.
 */
export function LoadingState({ title, lines = 3, className }: { title: string; lines?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" data-loading="true" className={clsx('flex flex-1 flex-col gap-4 px-6 py-6', className)}>
      <div className="flex items-center gap-2 text-prose text-app-text-secondary">
        <Spinner size={14} />
        {title}
      </div>
      <div className="flex max-w-[560px] flex-col gap-2.5">
        <Skeleton className="h-4 w-1/3" />
        {Array.from({ length: Math.max(0, lines) }, (_, i) => <Skeleton key={i} className={LINE_WIDTHS[i % LINE_WIDTHS.length]} />)}
      </div>
    </div>
  );
}

/**
 * What a place shows when it could not load: the same shape as EmptyState,
 * with a red glyph, one plain line, an optional sentence, the way on, and the
 * technical details in a quiet box for whoever has to report it.
 * `data-error` marks it.
 */
export function ErrorState({ title, body, action, details, className }: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  details?: string;
  className?: string;
}) {
  return (
    <div role="alert" data-error="true" className={clsx('flex min-h-full flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center', className)}>
      <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
        <CircleAlert size={18} aria-hidden="true" />
      </span>
      <p className="max-w-[440px] text-body-lg font-semibold text-app-text">{title}</p>
      {body && <div className="max-w-[440px] text-prose leading-6 text-app-text-secondary">{body}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
      {details && (
        <div className="mt-3 max-h-32 w-full max-w-[440px] select-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/[0.04] px-3 py-2 text-left font-mono text-mini leading-4 text-app-text-secondary dark:bg-white/[0.06]">
          {details}
        </div>
      )}
    </div>
  );
}
