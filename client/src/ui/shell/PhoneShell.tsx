import type { KeyboardEvent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { Count } from '../primitives/Chip';
import { focusSurface } from '../primitives/overlay';
import { FOCUS_RING } from './pressable';

export interface PhoneNavItemModel {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  active?: boolean;
}

/**
 * The window of Topics under 768px: a 48px bar on top (a leading control, the
 * title, actions), the content scrolling vertically only, a 56px tab bar at
 * the bottom over the home indicator (left out when `nav` is empty: a screen
 * that is not part of the app, like the one after signing out). With `drawer` the sidebar slides in
 * from the left over a dimmed veil; the veil or Escape closes it. It fills its
 * parent (`relative`), so the drawer stays inside it in a preview frame too.
 */
export function PhoneShell({ title, leading, actions, nav, onNav, children, drawer, onCloseDrawer, navLabel, drawerLabel }: {
  title: string;
  leading?: ReactNode;
  actions?: ReactNode;
  nav: PhoneNavItemModel[];
  onNav: (id: string) => void;
  children: ReactNode;
  drawer?: ReactNode;
  onCloseDrawer?: () => void;
  /** Accessible name of the bottom tab bar. */
  navLabel?: string;
  /** Accessible name of the drawer. */
  drawerLabel?: string;
}) {
  const onDrawerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !onCloseDrawer) return;
    e.stopPropagation();
    onCloseDrawer();
  };
  return (
    <div className="relative flex h-full w-full flex-col overflow-clip bg-surface font-sans text-prose text-app-text antialiased">
      <header className="box-content flex h-12 shrink-0 items-center gap-1 border-b border-app-border bg-app-chrome px-1.5 pt-[env(safe-area-inset-top)]">
        {leading && <div className="flex shrink-0 items-center">{leading}</div>}
        <h1 className={clsx('min-w-0 flex-1 truncate text-body-lg font-semibold text-app-text', !leading && 'pl-2.5')}>{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">{children}</main>

      {nav.length > 0 && (
        <nav aria-label={navLabel} className="box-content flex h-14 shrink-0 border-t border-app-border bg-app-chrome pb-[env(safe-area-inset-bottom)]">
          {nav.map((n) => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onNav(n.id)}
                aria-current={n.active ? 'page' : undefined}
                className={clsx(
                  'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-mini font-medium transition-colors',
                  FOCUS_RING, 'focus-visible:ring-inset',
                  n.active ? 'text-primary dark:text-primary-dark' : 'text-app-text-secondary',
                )}
              >
                <span className="relative inline-flex">
                  <Icon size={20} strokeWidth={n.active ? 2.25 : 1.75} aria-hidden="true" />
                  {n.count !== undefined && n.count > 0 && <Count value={n.count} tone="red" className="absolute -right-3 -top-1.5" />}
                </span>
                <span className="max-w-full truncate px-1 leading-none">{n.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {drawer && (
        <div className="absolute inset-0 z-50" onKeyDown={onDrawerKey}>
          <div aria-hidden="true" className="absolute inset-0 bg-black/35 modal-backdrop-enter" onClick={onCloseDrawer} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={drawerLabel}
            ref={focusSurface}
            tabIndex={-1}
            className="drawer-enter absolute inset-y-0 left-0 flex w-[min(300px,86%)] flex-col overflow-hidden bg-app-chrome pt-[env(safe-area-inset-top)] shadow-2xl outline-none"
          >
            {drawer}
          </div>
        </div>
      )}
    </div>
  );
}
