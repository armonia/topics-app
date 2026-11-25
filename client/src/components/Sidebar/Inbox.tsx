/**
 * «TO LOOK AT»: THE INBOX of the things that are lit (notifications-redesign,
 * design section 9, ATTN-09), and of what the hub asks of the person
 * (hub-smistamento, HUBBR-06). It replaces the history button.
 *
 * The button carries THE number: how many rows «Ora» lists, the same the
 * Dock, the tray and the tab say (the ledger, `BellLedger` in
 * `useTabNotifications`). Its colour says the first group: amber when
 * something waits for an answer («Decidi tu»), else blue for the finished,
 * else grey for warnings alone; nothing at zero.
 *
 * The panel itself (`InboxPanel.tsx`) is a chunk of its own, loaded the first
 * time the pointer or the keyboard comes near the button: the button is on
 * every screen, the panel only on the ones where it is opened.
 *
 * Keyboard: ⇧⌘I opens it (see the panel for the rest). Touch: a bottom sheet
 * under 768px (the `Menu` primitive).
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { useT } from '../../hooks/useT';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { OPEN_INBOX_EVENT, type OpenInboxDetail } from '../../lib/inboxEvents';
import { RAISED_CONTROL } from '../../lib/selectionStyles';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

const PANEL_W = 420;

// Destructured so knip sees which export is read (check:deadcode-blindspots).
const loadPanel = async () => {
  const { default: Panel } = await import('./InboxPanel');
  return { default: Panel };
};
const InboxPanel = lazy(loadPanel);

const BADGE_VARIANT = { 'needs-you': 'needsYou', lit: 'default', quiet: 'quiet' } as const;

/**
 * The bell's number and name, and the model behind them: one reading for every
 * bell that opens this panel (the column's and the phone's header on a pane),
 * so two bells never show different numbers for the same sheet.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the badge and the bell read the same sheet, kept next to each other
export function useInboxBadge() {
  const tr = useT();
  const { bell } = useTabNotifications();
  const badge = { count: bell.total, tone: bell.tone };
  const label = bell.total === 0
    ? tr('inbox.title')
    : bell.decide > 0
      ? tr('inbox.button.count', { n: bell.total, m: bell.decide })
      : tr('inbox.button.total', { n: bell.total });
  return { model: bell.model, badge, decideCount: bell.decide, label, variant: BADGE_VARIANT[badge.tone] };
}

export function Inbox({
  onWSMessage,
  isMobile = false,
  className = '',
}: {
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  isMobile?: boolean;
  className?: string;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { model, badge, decideCount, label } = useInboxBadge();
  // The tab an opener asked for (History for a hub's `#journal`): a new object per request, so two
  // equal requests in a row both land. Dropped on close, so a later click opens on «now» again.
  const [tabRequest, setTabRequest] = useState<{ tab: 'now' | 'history' } | null>(null);
  const close = () => { setOpen(false); setTabRequest(null); };

  // ⇧⌘I: the chord announces, the button answers.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const tab = (e as CustomEvent<OpenInboxDetail | undefined>).detail?.tab;
      if (tab) setTabRequest({ tab });
      void loadPanel();
      setOpen(true);
    };
    window.addEventListener(OPEN_INBOX_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_INBOX_EVENT, onOpen);
  }, []);

  const preload = () => { void loadPanel(); };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        onPointerEnter={preload}
        onFocus={preload}
        // The same box as its neighbours on the row (Search and «+»): 44 with
        // a finger, 28 with a mouse.
        className={`edge-lit relative ${isMobile ? 'h-11 w-11' : 'h-7 w-7'} flex items-center justify-center rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag ${className}`}
        // The attribute, not only the class: under Tauri it is what gives up
        // dragging the window (tests/e2e/drag-regions.spec.ts).
        {...NO_DRAG_REGION}
        style={{ pointerEvents: 'auto' }}
        title={tr('inbox.title')}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="inbox-button"
        data-waiting={decideCount > 0 ? 'true' : undefined}
        data-tone={badge.count > 0 ? badge.tone : undefined}
      >
        <Bell size={isMobile ? 18 : 14} aria-hidden="true" />
        <NotificationBadge
          count={badge.count}
          variant={BADGE_VARIANT[badge.tone]}
          className="absolute -top-1 -right-1"
          ariaLabel={label}
          testId="inbox-count"
        />
      </button>
      <Menu
        open={open}
        anchorRef={triggerRef}
        onClose={close}
        role="dialog"
        ariaLabel={tr('inbox.title')}
        minWidth={PANEL_W}
        maxWidth={PANEL_W}
        unmanagedFocus
        testId="inbox-panel"
        className="flex flex-col overflow-hidden"
      >
        <Suspense fallback={<div className="h-24" aria-busy="true" />}>
          <InboxPanel model={model} onWSMessage={onWSMessage} onClose={close} tabRequest={tabRequest} />
        </Suspense>
      </Menu>
    </>
  );
}
