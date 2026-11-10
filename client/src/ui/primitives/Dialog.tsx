import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { LAYER_MODAL, MODAL_VEIL, focusOnMount, focusSurface } from './overlay';

const WIDTH = {
  sm: 'sm:max-w-[420px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[800px]',
} as const;

/*
 * The panel rises from the bottom edge on a phone (a sheet) and settles in
 * the centre from 640px up, on the product's own entrances (`slideUp`,
 * `commandPaletteIn` in index.css).
 */
const PANEL = clsx(
  'relative flex max-h-[88dvh] w-full flex-col overflow-hidden border border-app-border bg-surface shadow-2xl outline-none',
  'rounded-t-xl pb-[env(safe-area-inset-bottom)] sm:max-h-[calc(100dvh-48px)] sm:rounded-xl sm:pb-0',
  'max-sm:[animation:slideUp_var(--motion-base)_var(--ease-standard)] sm:[animation:commandPaletteIn_var(--motion-fast)_var(--ease-standard)]',
);

/** The fixed layer of a modal: the veil, and the panel bottom or centre. */
function ModalLayer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };
  return (
    <div onKeyDown={onKeyDown} className={clsx('fixed inset-0 flex items-end justify-center sm:items-center sm:p-6', LAYER_MODAL)}>
      <div aria-hidden="true" className={MODAL_VEIL} onClick={onClose} />
      {children}
    </div>
  );
}

const CLOSE_BUTTON = clsx(
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
  FOCUS_RING,
);

/**
 * A modal window: a title with a close button, a body that scrolls, an
 * optional footer for the actions. Escape and a click on the veil close it.
 * It takes focus when it opens, unless a control inside already did.
 */
export function Dialog({ title, children, footer, onClose, size = 'md', closeLabel }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: keyof typeof WIDTH;
  closeLabel: string;
}) {
  const titleId = useId();
  return (
    <ModalLayer onClose={onClose}>
      <div ref={focusSurface} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={clsx(PANEL, WIDTH[size])}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-app-border pl-4 pr-2.5">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-body-lg font-semibold text-app-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} data-tip={closeLabel} className={CLOSE_BUTTON}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-prose leading-6 text-app-text-secondary">{children}</div>
        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-app-border px-4 py-3">{footer}</footer>
        )}
      </div>
    </ModalLayer>
  );
}

const CONFIRM_TONE = {
  primary: 'bg-primary text-white hover:bg-primary-hover',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
} as const;

const DIALOG_BUTTON = clsx(
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg px-4 text-prose font-medium transition-colors sm:h-7 sm:px-3',
  FOCUS_RING,
);

/**
 * A question before an action: a title, an optional sentence, the two
 * answers. The confirm button has focus when it opens, so Enter confirms and
 * Escape (or the veil) cancels. On a phone the answers stack full width.
 */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, tone = 'primary', onConfirm, onCancel }: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: keyof typeof CONFIRM_TONE;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  return (
    <ModalLayer onClose={onCancel}>
      <div
        ref={focusSurface}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        className={clsx(PANEL, WIDTH.sm)}
      >
        <div className="px-5 pb-2 pt-5">
          <h2 id={titleId} className="text-body-lg font-semibold leading-6 text-app-text">{title}</h2>
          {body && <div id={bodyId} className="mt-1.5 text-prose leading-6 text-app-text-secondary">{body}</div>}
        </div>
        <div className="flex flex-col-reverse gap-2 px-5 pb-5 pt-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className={clsx(DIALOG_BUTTON, 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]')}
          >
            {cancelLabel}
          </button>
          <button ref={focusOnMount} type="button" onClick={onConfirm} className={clsx(DIALOG_BUTTON, CONFIRM_TONE[tone])}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
