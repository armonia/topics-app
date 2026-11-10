import { X } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { LAYER_FLOAT } from './overlay';
import { NOTICE_ICON, NOTICE_TEXT, type NoticeTone } from './notice';

export interface ToastModel {
  id: string;
  tone: NoticeTone;
  title: string;
  body?: string;
  /** The way on from the message, e.g. `Open the receipt`. */
  actionLabel?: string;
}

/**
 * Short messages about something that just happened, stacked bottom right
 * (bottom centre on a phone), newest last. Each one has its kind's glyph, a
 * title, an optional line and way on, and a close button. An error is an
 * `alert` and interrupts a screen reader; the rest are polite `status`.
 * How long a toast stays is the caller's: this draws what it is given.
 */
export function ToastStack({ toasts, onDismiss, onAction, dismissLabel }: {
  toasts: ToastModel[];
  onDismiss: (id: string) => void;
  onAction: (id: string) => void;
  dismissLabel: string;
}) {
  if (!toasts.length) return null;
  return (
    <div
      className={clsx(
        'pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-[max(12px,env(safe-area-inset-bottom))]',
        'sm:inset-x-auto sm:right-0 sm:items-end sm:px-4 sm:pb-4',
        LAYER_FLOAT,
      )}
    >
      {toasts.map((t) => {
        const Icon = NOTICE_ICON[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            data-tone={t.tone}
            className="glass-surface popover-enter pointer-events-auto flex w-full max-w-[380px] items-start gap-2.5 rounded-lg border border-app-border py-2.5 pl-3 pr-2 shadow-lg"
          >
            <Icon size={15} className={clsx('mt-0.5 shrink-0', NOTICE_TEXT[t.tone])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-prose font-medium leading-5 text-app-text">{t.title}</p>
              {t.body && <p className="mt-0.5 line-clamp-3 text-mini leading-4 text-app-text-secondary">{t.body}</p>}
              {t.actionLabel && (
                <button
                  type="button"
                  onClick={() => onAction(t.id)}
                  className={clsx('-mx-1 mt-1 rounded px-1 text-mini font-semibold leading-5 text-primary hover:underline underline-offset-2 dark:text-primary-dark', FOCUS_RING)}
                >
                  {t.actionLabel}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label={`${dismissLabel}: ${t.title}`}
              data-tip={dismissLabel}
              className={clsx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-app-text-tertiary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
