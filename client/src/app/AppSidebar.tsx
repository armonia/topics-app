import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { ErrorBoundary } from '../components/Shared/ErrorBoundary';
import { PaneAddMenu } from '../components/Shared/PaneAddMenu';
import { SidebarStatusBar, MobileTransportBand } from '../components/Sidebar/SidebarStatusBar';
import { MobileChromeBar } from '../components/Sidebar/MobileChromeBar';
import { mobileDrawerStyle } from '../hooks/useSidebarSwipe';
import type { useMenuPreferences } from '../hooks/useUserMenuHost';
import type { useSidebarState } from '../hooks/useSidebarState';
import type { useWebSocket } from '../hooks/useWebSocket';
import { OPEN_INBOX_EVENT } from '../lib/inboxEvents';
import { ROW_INSET, SIDEBAR_SCROLL_BOTTOM_PROPERTY, SIDEBAR_SCROLL_TOP_PROPERTY } from '../lib/selectionStyles';
import { NEXT_WAITING_EVENT } from '../state/waitingQueue';
import { SidebarHeader } from './SidebarHeader';
import type { TopicsMenuState } from './useTopicsMenu';

interface AppSidebarProps {
  sidebarRef: RefObject<HTMLDivElement | null>;
  sidebarContentRef: RefObject<HTMLDivElement | null>;
  isMobile: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  floatingSplits: boolean;
  viewportHeight: number | null;
  topicsMenu: TopicsMenuState;
  wsStatus: ReturnType<typeof useWebSocket>['status'];
  topicsError: string | null;
  onWSMessage: ReturnType<typeof useWebSocket>['onMessage'];
  sidebar: ReturnType<typeof useSidebarState>;
  menuPreferences: ReturnType<typeof useMenuPreferences>;
  splitLayoutAvailable: boolean;
  setSearchScope: Dispatch<SetStateAction<'all' | 'projects' | 'history'>>;
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  setShowChangelogFromMenu: Dispatch<SetStateAction<string | null>>;
  handleReopenClosedTab: ComponentProps<typeof SidebarStatusBar>['commands']['onReopenClosedTab'];
  openHistoryUrl: (url: string) => void;
  handleQuickCreateTopic: () => unknown;
  handleStandaloneAddPane: ComponentProps<typeof PaneAddMenu>['onAddPane'];
  boardInFront: boolean;
  handleMobileBoardToggle: () => void;
  waitingCount: number;
  /** The topic tree (or its skeleton), drawn inside the scrolling list slot. */
  children: ReactNode;
}

/**
 * The sidebar column and the phone's bottom chrome: header, topic list slot,
 * version banner slot, identity band, transport alarm and the row of doors.
 */
export function AppSidebar({
  sidebarRef, sidebarContentRef, isMobile, sidebarCollapsed, sidebarWidth, floatingSplits,
  viewportHeight, topicsMenu, wsStatus, topicsError, onWSMessage, sidebar, menuPreferences,
  splitLayoutAvailable, setSearchScope, setShowSearch, setShowChangelogFromMenu,
  handleReopenClosedTab, openHistoryUrl, handleQuickCreateTopic, handleStandaloneAddPane,
  boardInFront, handleMobileBoardToggle, waitingCount, children,
}: AppSidebarProps) {
  return (
    <>
      {/* Sidebar */}
      <div
        ref={sidebarRef}
        role="navigation"
        aria-label="Topics sidebar"
        // The column declares itself so CSS can name it. What it names today is
        // the rule that stops a finger from turning a drag into a text
        // selection (`index.css`, `@media (pointer: coarse)`): the drawer
        // swipe, the pinned tiles and the topic rows are all born from a still
        // finger on a line of text, which is what iOS reads as "select this".
        data-sidebar=""
        // `group/sidebar`: some sidebar affordances light up only when you hover
        // over it (the "+" of the groups at the bottom). The hover group lives
        // HERE and not on the single bar because the hidden target would
        // otherwise be impossible to find: you enter the sidebar and the
        // control is there.
        // `bg-app-chrome`, not `bg-surface`: the sidebar is CHROME, and chrome
        // steps back under the page instead of standing above it. It was `bg-surface`
        // (#fff / #181a20), i.e. LIGHTER than the page, on iPhone it left a step
        // towards iOS's black status bar, and the band at the top
        // changed tint as the sidebar opened and closed. The token also carries
        // the transparency on the mac shell: see --chrome-bg in index.css.
        // A SHADOW SEPARATES TWO PLANES, A LINE SEPARATES TWO ZONES OF THE SAME PLANE.
        //
        // On desktop the sidebar is `fixed` above the content and it cast a
        // `shadow-2xl`: twenty-five pixels of gradient laid ON the content.
        // As long as the two surfaces had different tints that gradient read
        // as depth. Since the veil became one they have the same
        // pixel, measured: sidebar #191b1e, content #191b1e, and the shadow
        // is the only thing left in between: a dark band with no sharp edge, which reads
        // as a double spacing and as a third tint (#17191c at x=211,
        // going back up to #191b1e only at x=236). «They have no border, there is a double
        // spacing and the colours are not the same» (09/08): three
        // symptoms of a single thing.
        //
        // With FLOATING panes the shadow is right and stays: there the sidebar
        // really is on a different plane, detached from its gap. Without them, the two planes
        // are one, and what is needed is a boundary, one pixel, not twenty-five.
        // The phone drawer has its own rule (`.sidebar-drawer`, index.css): it
        // slides on transform alone at a constant width, and hides itself with
        // `visibility` once it is off screen, which is what `data-drawer` drives.
        data-drawer={isMobile ? (sidebarCollapsed ? 'closed' : 'open') : undefined}
        className={`group/sidebar bg-app-chrome flex flex-col flex-shrink-0 overflow-hidden ${
          isMobile ? 'sidebar-drawer fixed inset-y-0 left-0 z-50 w-full'
            : `sidebar-transition fixed inset-y-0 left-0 z-40 ${floatingSplits ? 'shadow-2xl' : 'border-r border-app-border'}`
        }`}
        style={{
          // Non-mobile: the sidebar is position:fixed with a CONSTANT width and collapses
          // via a composited translateX, so the content area never resizes on toggle, the
          // reveal is the FLIP push on #main-content (useSidebarFlipPush). Mobile is a
          // full-width drawer that slides the same way.
          //
          // On mobile the two measures come from `mobileDrawerStyle`, which is the
          // same function `useSidebarSwipe` uses to put the column back in place
          // after a drag: React and the gesture write the SAME element,
          // and two copies of the same strings would diverge at the first touch-up.
          width: isMobile ? mobileDrawerStyle(sidebarCollapsed).width : `${sidebarWidth}px`,
          transform: isMobile
            ? mobileDrawerStyle(sidebarCollapsed).transform
            : (sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)'),
          // Safe-area top inset applied UNCONDITIONALLY: env() self-zeroes when
          // there's no inset (desktop, non-notched), so gating it on isPWA was
          // the bug that left content clipped under the notch when the app is
          // opened in a plain mobile browser tab (e.g. over Tailscale, where
          // display-mode is 'browser', not 'standalone'). The mobile sidebar is
          // `position: fixed inset-y-0`, so it escapes the root and needs its own.
          //
          // ON A PHONE THE COLUMN IS NOT PUSHED DOWN, IT IS PADDED FROM INSIDE.
          // Asked from a phone (card 1e015ad6): the top row should have no
          // ground of its own, "so that scrolling the sidebar the tabs go under
          // it, and under the safe area too". A padding on THIS element cannot
          // do that: it moves the scroller down, so the list ends where the row
          // begins and nothing ever passes behind it. So down there the inset
          // ALONE becomes `--sidebar-scroll-top`, which the scrolling column
          // takes as its own padding-top: the rows start right after the safe
          // area (mobile-chrome-feedback A1) and travel behind the row and
          // behind the status bar from the first pixel, the way a native list
          // does. It used to carry the height of the row on top of the inset,
          // which left a full row of dead space under the notch.
          paddingTop: isMobile ? 0 : 'env(safe-area-inset-top, 0px)',
          [SIDEBAR_SCROLL_TOP_PROPERTY as string]: isMobile
            ? 'var(--sat, 0px)'
            : '0px',
          // The column is `fixed inset-y-0`: it escapes the root's padding, so
          // it reserves the bottom band itself. And it reserves it INSIDE the
          // scroller, not as the column's padding: the button row has no
          // ground and the notice band («Claude usage») a translucent one,
          // so their height becomes a spacer OF THE SCROLLER, as at the top:
          // at rest the last tab sits above the band and the buttons, and
          // scrolling the tabs pass under them instead of being cut in half
          // on the edge.
          paddingBottom: 0,
          [SIDEBAR_SCROLL_BOTTOM_PROPERTY as string]: 'calc(var(--mobile-chrome-h, 0px) + var(--mobile-transport-h, 0px))',
        }}
      >

        <SidebarHeader
          isMobile={isMobile}
          topicsMenu={topicsMenu}
          wsStatus={wsStatus}
          topicsError={topicsError}
          onWSMessage={onWSMessage}
          setSearchScope={setSearchScope}
          setShowSearch={setShowSearch}
          handleQuickCreateTopic={handleQuickCreateTopic}
          handleStandaloneAddPane={handleStandaloneAddPane}
        />

        {/* SidebarControls removed: search is now the inline header input,
            view-mode + archived toggles live in the Topics ▾ menu, and ⌘K
            (CommandPalette) remains via setShowSearch / the keyboard shortcut. */}
        {/* topicsError ("Using cached data, server unreachable") moved to the
            bottom SidebarStatusBar, see <SidebarStatusBar dataNotice={…} />. */}

        <div ref={sidebarContentRef} className="flex-1 flex flex-col min-h-0" data-testid="sidebar-topic-list">
          {children}
        </div>

        {/* THE VERSION BANNER LANDS HERE, inside the column and at its full
            width, no longer as a floating card anchored to the little number
            at the foot. See DevBundleToast / UpdaterToast: they look for
            this slot and portal into it. */}
        {/* On the phone the column runs to the bottom of the screen, under the
            row of buttons (`MobileChromeBar`): the list pays that band as a
            spacer of its own (`SIDEBAR_SCROLL_BOTTOM_PROPERTY`), and so must
            this slot, or the banner sits BEHIND the row. Measured 04/10 at
            390x844: only its eyebrow and the X peeked out, and a tap on the
            centre of the reload button landed on the search button. */}
        <div
          data-update-slot
          className="flex-shrink-0 empty:hidden"
          style={{
            paddingInline: ROW_INSET,
            paddingBottom: isMobile ? `calc(${ROW_INSET}px + var(${SIDEBAR_SCROLL_BOTTOM_PROPERTY}, 0px))` : ROW_INSET,
          }}
        />

        {/* THE FOOT OF THE COLUMN KEEPS THE IDENTITY, and nothing else.

            The machine's state, connection, memory, version, restart, moved
            into the «Topics» menu on 31/08, where it was asked for and where the
            phone has had it since 07/08. The identity band did NOT follow, and
            that is the deliberate half: its contract is RESPONSIVE (the three
            subjects hold one line at sidebar widths 180, 256 and 400, measured
            in identity-chips.spec.ts) and the desktop dropdown is
            `min-w-[200px]` and does not track the column, moving it in would
            not have relocated the band, it would have deleted the contract the
            band exists to satisfy. It also leaves the accounts where a person
            already looks, which is the half that sent this bar back down here
            on 07/08. See SIDEBAR-STATUS-01. */}
        {!isMobile && (
        <ErrorBoundary fallbackMessageKey="crash.identityBand">
          <SidebarStatusBar
            wsStatus={wsStatus}
            dataNotice={topicsError}
            // THE COMMANDS OF THE COLUMN COME DOWN HERE. On the desktop the
            // user card is the only door of the chrome: archived, view,
            // panels, history, settings and the state of the machine live in
            // its menu, not in a dropdown hanging off the title.
            commands={{
              showArchived: sidebar.showArchived,
              onToggleArchived: () => { sidebar.toggleShowArchived(); },
              viewMode: sidebar.viewMode,
              onViewModeChange: sidebar.setViewMode,
              preferences: menuPreferences,
              splitLayoutAvailable,
              onOpenHistory: () => { setSearchScope('history'); setShowSearch(true); },
              onOpenChangelog: (version) => setShowChangelogFromMenu(version),
              onReopenClosedTab: handleReopenClosedTab,
              onOpenHistoryUrl: openHistoryUrl,
            }}
          />
        </ErrorBoundary>
        )}
      </div>

      {/* THE PHONE'S FIVE DOORS, search · pencil · task · waiting · profile.
          It stands OUTSIDE the column, not inside: the row must stay under the
          fingers even with the drawer shut, or the board switch would be a
          one-way street (board open, the button back to the list gone with the
          column). That is also why it paints itself instead of inheriting the
          sidebar's chrome. The pencil is the SAME `PaneAddMenu` as the
          desktop, wearing the row's face: the list of things to create is one,
          the tap opens a chat straight away and the long press opens the whole
          menu (A6). */}
      {/* THE TRANSPORT ALARM ON THE PHONE. The «Offline» / «Reconnecting…» /
          «cached data» rows lived ONLY inside the `{!isMobile && …}` block of
          the bar at the foot of the column, i.e. they did not exist at all on
          the device that actually loses the network. Here they are outside the
          drawer, like the bottom row: visible without opening anything. The
          identity band stays desktop-only, which is the other half. */}
      {isMobile && (
        <ErrorBoundary fallbackMessageKey="crash.transportBand">
          <MobileTransportBand wsStatus={wsStatus} dataNotice={topicsError} keyboardVisible={viewportHeight !== null} />
        </ErrorBoundary>
      )}

      <MobileChromeBar
        onSearch={() => { setSearchScope('all'); setShowSearch(true); }}
        addSlot={
          <PaneAddMenu
            scope="standalone"
            onNewChat={() => handleQuickCreateTopic()}
            onAddPane={handleStandaloneAddPane}
            triggerVariant="bar"
            // A6: the pencil. The menu brings its own name and title (i18n
            // inside `PaneAddMenu`), where the trigger lives too: two literals
            // here would be the only check-ui-language hits left in the file.
            quickChat
          />
        }
        boardInFront={boardInFront}
        onToggleBoard={handleMobileBoardToggle}
        // THE SAME boolean `boardInFront` is computed from: they used to
        // be two different predicates, and between 768 and 1023 on touch the
        // row lit up over a desktop layout with its switch stuck one-way.
        mobile={isMobile}
        // THE Profile PANE, no longer the Settings modal.
        //
        // It led to Settings → Profile, i.e. into a panel that opens
        // over the app and has to be closed to get back to work. Now it is a tab
        // like Dashboard and Board: `topics:open-utility` is the bus that opens
        // them all (the listener lives in `usePanelLifecycle` and accepts the set
        // `UTILITY_PANEL_TYPES`), and on the phone `handleOpenAsPage` closes the
        // drawer by itself. The section in Settings stays where it was.
        onOpenProfile={() => { window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } })); topicsMenu.setShowTopicsMenu(false); }}
        waitingCount={waitingCount}
        // A5: the door ALWAYS answers. With a queue it takes the ⌘J step, with
        // an empty queue it opens the Waiting page (the Inbox's Now) instead
        // of staying mute. One prop, so detaching it silences both branches.
        onNextWaiting={() => window.dispatchEvent(new CustomEvent(waitingCount === 0 ? OPEN_INBOX_EVENT : NEXT_WAITING_EVENT))}
      />
    </>
  );
}
