import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import clsx from 'clsx';
import { FLOAT_SURFACE, LAYER_FLOAT, focusSurface } from './overlay';

/**
 * A floating panel over a transparent full-screen veil: a click outside or
 * Escape closes it. By default it hangs under its positioned parent on the
 * `align` side; with `fixed` the caller's `className` places it on the
 * window (the notifications under the bell, the persona menu over the
 * identity row). It takes focus when it opens, unless a control inside
 * already did, so Escape always reaches it.
 */
export function Popover({ children, onClose, ariaLabel, className, align = 'left', fixed, style }: {
  children: ReactNode;
  onClose: () => void;
  ariaLabel: string;
  className?: string;
  align?: 'left' | 'right';
  /** The panel is placed on the window by `className`, not under its parent. */
  fixed?: boolean;
  style?: CSSProperties;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };
  return (
    <>
      <div aria-hidden="true" className={clsx('fixed inset-0', LAYER_FLOAT)} onClick={onClose} />
      <div
        role="dialog"
        aria-label={ariaLabel}
        ref={focusSurface}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={style}
        className={clsx(
          FLOAT_SURFACE, LAYER_FLOAT, 'outline-none',
          fixed ? 'fixed' : clsx('absolute top-full mt-1', align === 'right' ? 'right-0' : 'left-0'),
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
