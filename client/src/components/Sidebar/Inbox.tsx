/**
 * «TO LOOK AT»: THE INBOX of the things that are lit (notifications-redesign,
 * design section 9, ATTN-09), and of what the hub asks of the person
 * (hub-smistamento, HUBBR-06). It replaces the history button.
 *
 * The button carries a number. Without the hub it is the Dock's (the lit
 * subjects). With the hub it is the figure of one group of the panel: amber
 * for «Decidi tu», else blue for the finished, else grey for the warnings,
 * nothing at zero (`bellBadge`).
 *
 * The panel itself (`InboxPanel.tsx`) is a chunk of its own, loaded the first
 * time the pointer or the keyboard comes near the button: the button is on
 * every screen, the panel only on the ones where it is opened.
 *
 * Keyboard: ⇧⌘I opens it (see the panel for the rest). Touch: a bottom sheet
 * under 768px (the `Menu` primitive).
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { useT } from '../../hooks/useT';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { useAttentionRows } from '../../state/attention';
import { bellBadge } from '../../state/attentionTotal';
import { useHubEverRead, useHubLive } from '../../state/hubLive';
import { useBoardTasks } from '../../lib/boardTasksStore';
import { hubBadgeCounts } from '../../lib/bellGroups';
import { inboxModel } from '../../lib/inboxModel';
import { OPEN_INBOX_EVENT } from '../../lib/inboxEvents';
import { RAISED_CONTROL } from '../../lib/selectionStyles';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

const PANEL_W = 420;

const loadPanel = () => import('./InboxPanel');
const InboxPanel = lazy(loadPanel);

const BADGE_VARIANT = { 'needs-you': 'needsYou', lit: 'default', quiet: 'quiet' } as const;

/**
 * The bell's number and name, and the model behind them: one reading for every
 * bell that opens this panel (the column's and the phone's header on a pane),
 * so two bells never show different numbers for the same sheet.
 */
export function useInboxBadge() {
  const tr = useT();
  const { attentionTotal } = useTabNotifications();
  const attention = useAttentionRows();
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const cards = useBoardTasks();
  const live = useHubLive();
  const hubPresent = useHubEverRead();
  const model = useMemo(() => inboxModel(attention, topics, terminalSessions, cards), [attention, topics, terminalSessions, cards]);
  const hubCounts = useMemo(() => hubBadgeCounts(live), [live]);
  const badge = bellBadge(attentionTotal, model.waiting.length, hubCounts, hubPresent);
  const decideCount = model.waiting.length + hubCounts.decide;
  const label = badge.count === 0
    ? tr('inbox.title')
    : hubPresent && decideCount > 0
      ? tr('bell.button.decide', { n: decideCount })
      : tr('inbox.button.count', { n: badge.count, m: decideCount });
  return { model, badge, decideCount, label, variant: BADGE_VARIANT[badge.tone] };
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

  // ⇧⌘I: the chord announces, the button answers.
  useEffect(() => {
    const onOpen = () => { void loadPanel(); setOpen(true); };
    window.addEventListener(OPEN_INBOX_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_INBOX_EVENT, onOpen);
  }, []);

  const preload = () => { void loadPanel(); };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
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
        onClose={() => setOpen(false)}
        role="dialog"
        ariaLabel={tr('inbox.title')}
        minWidth={PANEL_W}
        maxWidth={PANEL_W}
        unmanagedFocus
        testId="inbox-panel"
        className="flex flex-col overflow-hidden"
      >
        <Suspense fallback={<div className="h-24" aria-busy="true" />}>
          <InboxPanel model={model} onWSMessage={onWSMessage} onClose={() => setOpen(false)} />
        </Suspense>
      </Menu>
    </>
  );
}
