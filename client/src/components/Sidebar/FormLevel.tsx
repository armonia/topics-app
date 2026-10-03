/**
 * A LEVEL OF THE USER MENU THAT HOLDS A FORM, and the frame every form shares.
 *
 * Two forms are the account and its machines and stay in the user menu as
 * levels: the plan (a licence token) and the machines (an address, a code, the
 * requests from other computers). The others live where they are used and are
 * drawn by `Settings/HomePanelHost` in the same `FormPanelFrame` (SETHOME-01).
 * What makes a form work inside a menu is written here once:
 *
 *  · WIDER than a preference level: a key or an address is typed into a field
 *    you can read. `FORM_LEVEL_WIDTH`, never wider than the window minus its
 *    margins; the flip and the clamp at the edge are `SubmenuItem`'s.
 *  · A FIXED HEADER and a body that scrolls inside the level, under the same
 *    height cap as the menu, so a long page (AI providers) does not push the
 *    level off the screen and the name of where you are stays in sight. On the
 *    phone the level is a sheet: the header sticks to its top.
 *  · THE KEYS BELONG TO THE FIELD: the menu's arrows and the level's ArrowLeft
 *    step aside inside a field (`useMenuKeyboard`, `SubmenuItem`), Escape closes
 *    only this level, and Tab cycles inside it instead of leaving for the page
 *    behind.
 *
 * The body is passed in already lazy: the row and its tail are all the first
 * paint of the menu needs, and the forms load the first time a level opens.
 */
import { Suspense, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { ErrorBoundary } from '../Shared/ErrorBoundary';
import { useCloseLevel } from '../Shared/levelClose';
import { useMobile } from '@/hooks/useMobile';
import { focusableWithin } from '@/hooks/useModalDialog';
import { stepFocus } from './stepFocus';
import { POPOVER_MARGIN } from '@/lib/popoverStyles';
import { useT } from '@/hooks/useT';

/** Wide enough for an API key field with its button beside it, and for the
 *  provider cards; narrow enough to sit beside a 400px column on a laptop. */
const FORM_LEVEL_WIDTH = 400;

export type Glyph = React.ComponentType<{ size?: number; className?: string }>;

export function FormLevel({ icon, label, testId, tail, defaultOpen = false, onOpenChange, children }: {
  icon: Glyph;
  label: string;
  /** The row; the level is `${testId}-menu`, its frame `${testId}-form`. */
  testId: string;
  tail?: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The form, usually a `lazy` component. */
  children: ReactNode;
}) {
  // Read on render, which is every time the menu opens: a level never wider
  // than the window it opens in.
  const width = Math.max(240, Math.min(FORM_LEVEL_WIDTH, window.innerWidth - 2 * POPOVER_MARGIN));
  return (
    <SubmenuItem
      icon={icon}
      label={label}
      testId={testId}
      tail={tail}
      minWidth={width}
      maxWidth={width}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      // A form is not a list of menu items: the level is a dialog named after
      // the level (`SubmenuItem` passes `label` as its aria-label).
      levelRole="dialog"
    >
      <FormPanelFrame icon={icon} label={label} testId={testId}>
        {children}
      </FormPanelFrame>
    </SubmenuItem>
  );
}

/**
 * THE FRAME OF A FORM: a fixed header (name and close), a body that scrolls,
 * Tab kept inside. The user menu's form levels draw it, and so does the host of
 * the forms that live where they are used (`Settings/HomePanelHost`): one frame,
 * so a form behaves the same in either place.
 */
export function FormPanelFrame({ icon: Icon, label, testId, maxHeight, children }: {
  icon: Glyph;
  label: string;
  /** The frame is `${testId}-form`, its close button `${testId}-close`. */
  testId: string;
  /** A tighter cap than the menu's, in px: the room beside an anchor. */
  maxHeight?: number;
  /** The form, usually a `lazy` component. */
  children: ReactNode;
}) {
  const tr = useT();
  // The level's own close inside a `SubmenuItem`, the panel's inside the host.
  const close = useCloseLevel();
  const { isMobile } = useMobile();
  const frame = useRef<HTMLDivElement>(null);

  // TAB STAYS IN THE FORM, AND STEPS THROUGH EVERY CONTROL. The level is
  // portalled to <body>, so the browser's own Tab order leaves it for the end
  // of the page, which is behind the menu and invisible. And WebKit's own Tab
  // (Safari, the WKWebView the app ships in) skips buttons unless the person
  // turned on «Press Tab to highlight each item»: from the last field it went
  // straight out to <body>, over the buttons beside it. So every Tab is walked
  // here, over the same list a dialog traps (`focusableWithin`).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const el = frame.current;
    if (!el) return;
    const items = focusableWithin(el);
    if (items.length === 0) return;
    const raw = document.activeElement as HTMLElement | null;
    e.preventDefault();
    stepFocus(items, raw && el.contains(raw) ? raw : null, e.shiftKey).focus();
  };

  return (
    <div
      ref={frame}
      data-testid={`${testId}-form`}
      onKeyDown={onKeyDown}
      // The cap of the menu itself (`ProfileMenu`). On the phone the sheet
      // already caps and scrolls, and the header sticks instead.
      className={`flex flex-col ${isMobile ? '' : 'max-h-[min(70vh,560px)]'}`}
      style={!isMobile && maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <div
        className={`flex flex-shrink-0 items-center gap-2 border-b border-app-border pl-3 pr-1 ${isMobile ? 'sticky top-0 z-10 min-h-11' : 'py-1'}`}
        style={isMobile ? { backgroundColor: 'var(--popover-bg, var(--bg-surface))' } : undefined}
      >
        <Icon size={14} className="flex-shrink-0 text-app-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-compact font-semibold text-app-text">{label}</span>
        <button
          type="button"
          data-roving-skip=""
          data-testid={`${testId}-close`}
          onClick={close}
          aria-label={tr('userMenu.level.close', { nome: label })}
          title={tr('userMenu.level.close', { nome: label })}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11"
        >
          <X size={14} />
        </button>
      </div>
      <div className={`min-h-0 flex-1 px-3 py-3 ${isMobile ? '' : 'overflow-y-auto overscroll-contain'}`}>
        {/* A FORM THAT BREAKS TAKES ITS FRAME, NOT THE MENU: the same net the
            Settings window had (a device with no `id` once blew up a whole
            page), now around each form. */}
        <ErrorBoundary fallbackMessageKey="crash.settings">
          <Suspense fallback={<div className="h-24" />}>{children}</Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
