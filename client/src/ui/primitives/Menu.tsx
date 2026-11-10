import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';
import { FLOAT_SURFACE, LAYER_FLOAT, focusFirstItem, handleMenuKeys } from './overlay';

export type { MenuHeaderModel, MenuItemModel } from './menu-model';
import type { MenuHeaderModel, MenuItemModel } from './menu-model';

const ITEM = clsx(
  'mx-1 flex h-7 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 text-left text-compact transition-colors coarse:h-11 coarse:text-body-lg',
  'focus-visible:outline-none focus-visible:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 dark:focus-visible:bg-white/[0.08]',
);

/** The avatar, name and line of a menu header. */
function MenuHeaderBody({ header }: { header: MenuHeaderModel }) {
  return (
    <>
      <span
        aria-hidden="true"
        style={{ width: 26, height: 26, backgroundColor: header.color }}
        className="inline-flex shrink-0 items-center justify-center rounded-full text-mini font-bold leading-none text-white"
      >
        {header.monogram}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-prose font-semibold leading-5 text-app-text">{header.title}</span>
        {header.detail && <span className="block truncate text-mini leading-4 text-app-text-tertiary">{header.detail}</span>}
      </span>
    </>
  );
}

/** The widest a menu gets; a menu opened at a point is kept that far from the right edge. */
const MENU_MAX_WIDTH = 288;

/**
 * A list of actions over a transparent veil that closes it. With `x` and `y`
 * it is fixed at that point (a context menu); without, it hangs under its
 * positioned parent, on the `align` side (what `MenuButton` does). It takes
 * focus on its first item; arrows, Home and End move, Enter picks, Escape,
 * Tab and a click outside close. Picking an item calls `onSelect` and then
 * `onClose`. An optional `header` (avatar, name, a line under it) sits above
 * the items.
 */
export function Menu({ items, header, onSelect, onClose, x, y, ariaLabel, align = 'left', side = 'below', id, className }: {
  items: MenuItemModel[];
  header?: MenuHeaderModel;
  onSelect: (id: string) => void;
  onClose: () => void;
  x?: number;
  y?: number;
  ariaLabel: string;
  /** Side of the parent the anchored menu lines up with. */
  align?: 'left' | 'right';
  /** Whether the anchored menu hangs under its parent or stands over it. */
  side?: 'below' | 'above';
  id?: string;
  className?: string;
}) {
  const atPoint = x !== undefined && y !== undefined;
  const headerId = header?.id;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    handleMenuKeys(e, onClose);
  };
  return (
    <>
      <div
        aria-hidden="true"
        className={clsx('fixed inset-0', LAYER_FLOAT)}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        id={id}
        role="menu"
        aria-label={ariaLabel}
        ref={focusFirstItem}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={atPoint ? { left: `min(${x}px, calc(100vw - ${MENU_MAX_WIDTH + 8}px))`, top: y, maxHeight: `calc(100dvh - ${y}px - 8px)` } : undefined}
        className={clsx(
          FLOAT_SURFACE, LAYER_FLOAT,
          'min-w-[190px] max-w-[min(288px,calc(100vw-16px))] overflow-y-auto py-1 outline-none',
          atPoint ? 'fixed' : clsx('absolute max-h-[min(420px,60dvh)]', side === 'above' ? 'bottom-full mb-1' : 'top-full mt-1', align === 'right' ? 'right-0' : 'left-0'),
          className,
        )}
      >
        {header && (
          <>
            {headerId !== undefined ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  onSelect(headerId);
                  onClose();
                }}
                className={clsx(
                  'mx-1 flex min-h-11 w-[calc(100%-8px)] items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-app-text transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
                  'focus-visible:outline-none focus-visible:bg-black/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 dark:focus-visible:bg-white/[0.08]',
                )}
              >
                <MenuHeaderBody header={header} />
              </button>
            ) : (
              <div className="mx-1 flex min-h-11 items-center gap-2.5 px-2 py-1.5"><MenuHeaderBody header={header} /></div>
            )}
            <div role="separator" className="mx-2 my-1 h-px bg-app-border" />
          </>
        )}
        {items.map((it) => {
          if (it.separator) return <div key={it.id} role="separator" className="mx-2 my-1 h-px bg-app-border" />;
          if (it.heading) return <div key={it.id} role="presentation" className="px-3 pb-0.5 pt-1.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{it.label}</div>;
          const Icon = it.icon;
          const choice = it.checked !== undefined;
          return (
            <button
              key={it.id}
              type="button"
              role={choice ? 'menuitemradio' : 'menuitem'}
              aria-checked={choice ? it.checked : undefined}
              tabIndex={-1}
              disabled={it.disabled}
              data-tip={it.title}
              onClick={() => {
                onSelect(it.id);
                onClose();
              }}
              className={clsx(
                ITEM,
                it.disabled
                  ? 'cursor-default text-app-text-tertiary'
                  : it.danger
                    ? 'text-rose-600 hover:bg-rose-500/10 dark:text-rose-400'
                    : 'text-app-text hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
              )}
            >
              {Icon && <Icon size={14} className={clsx('shrink-0', !it.danger && !it.disabled && 'text-app-text-secondary')} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="shrink-0 pl-3 text-mini text-app-text-tertiary">{it.hint}</span>}
              {choice && (
                <span className="inline-flex w-3.5 shrink-0 justify-center text-primary dark:text-primary-dark">
                  {it.checked && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

const TRIGGER_VARIANT = {
  secondary: 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
  ghost: 'text-app-text-secondary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]',
} as const;

/** The trigger while its menu is open: the hover fill, held. */
const TRIGGER_OPEN = {
  secondary: 'bg-black/[0.08] text-app-text dark:bg-white/[0.12]',
  ghost: 'bg-black/[0.05] text-app-text dark:bg-white/[0.08]',
} as const;

const TRIGGER_SIZE = {
  sm: { label: 'h-6 gap-1 px-2 text-mini', square: 'h-6 w-6', icon: 12 },
  md: { label: 'h-7 gap-1.5 px-2.5 text-prose', square: 'h-7 w-7', icon: 14 },
} as const;

/**
 * Which side of its button a menu of these items opens on: under it, unless
 * it would be cut there (the foot of a scrolling column, of the screen) and
 * there is more room above. It measures the button's own page, as the focus
 * helpers do: layout only, no state of the app.
 */
function sideFor(button: HTMLElement, items: MenuItemModel[]): 'below' | 'above' {
  const view = button.ownerDocument.defaultView;
  if (!view) return 'below';
  /* The box the menu can show in: the viewport, cut by every ancestor that clips. */
  let top = 0;
  let bottom = view.innerHeight;
  for (let p = button.parentElement; p; p = p.parentElement) {
    const o = view.getComputedStyle(p);
    if (o.overflowY === 'visible' && o.overflowX === 'visible') continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  const row = view.matchMedia('(pointer: coarse)').matches ? 44 : 28;
  const height = Math.min(420, view.innerHeight * 0.6, items.reduce((h, it) => h + (it.separator ? 9 : row), 8));
  const r = button.getBoundingClientRect();
  const below = bottom - r.bottom;
  const above = r.top - top;
  return height + 4 > below && above > below ? 'above' : 'below';
}

/**
 * A button that opens a menu under itself (over itself when there is no room
 * below), the look of `Button`. It owns
 * only whether the menu is open; the actions are the caller's. `iconOnly`
 * draws the glyph alone and keeps `label` as its accessible name. Focus comes
 * back to the button when the menu closes.
 */
export function MenuButton({ label, icon: Icon, items, onSelect, variant = 'secondary', size = 'md', align = 'left', iconOnly, disabled, title, className }: {
  label: string;
  icon?: LucideIcon;
  items: MenuItemModel[];
  onSelect: (id: string) => void;
  variant?: keyof typeof TRIGGER_VARIANT;
  size?: keyof typeof TRIGGER_SIZE;
  align?: 'left' | 'right';
  iconOnly?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<'below' | 'above'>('below');
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const s = TRIGGER_SIZE[size];
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {
    if (trigger.current) setSide(sideFor(trigger.current, items));
    setOpen(true);
  };
  return (
    <span className={clsx('relative inline-flex shrink-0', className)}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={iconOnly ? label : undefined}
        data-tip={title ?? (iconOnly ? label : undefined)}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            show();
          }
        }}
        className={clsx(
          'inline-flex max-w-full shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors',
          FOCUS_RING,
          iconOnly ? s.square : s.label,
          disabled ? 'cursor-default bg-black/[0.04] text-app-text-tertiary dark:bg-white/[0.05]' : open ? TRIGGER_OPEN[variant] : TRIGGER_VARIANT[variant],
        )}
      >
        {Icon && <Icon size={iconOnly ? s.icon + 1 : s.icon} className="shrink-0" aria-hidden="true" />}
        {!iconOnly && <span className="min-w-0 truncate">{label}</span>}
        {!iconOnly && <ChevronDown size={s.icon - 2} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
      </button>
      {open && <Menu id={menuId} items={items} ariaLabel={label} align={align} side={side} onSelect={onSelect} onClose={close} />}
    </span>
  );
}
