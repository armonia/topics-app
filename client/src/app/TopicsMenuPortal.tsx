import { Suspense, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmInsidePopoverContext } from '../hooks/confirmInsidePopover';
import type { useMenuPreferences } from '../hooks/useUserMenuHost';
import type { useSidebarState } from '../hooks/useSidebarState';
import { SheetGrabber } from '../components/Shared/SheetGrabber';
import { SidebarSystemMenu } from '../components/Sidebar/SidebarSystemMenu';
import { MobileIdentityMenuItems, TopicsMenuItems } from '../components/Sidebar/topicsMenuItemsLazy';
import { TopicsBackRow, TopicsEntryRow } from '../components/Sidebar/UserMenuTopicsNav';
import { POPOVER_SURFACE, POPOVER_MARGIN, POPOVER_SHEET, Z_POPOVER, Z_POPOVER_SCRIM } from '../lib/popoverStyles';
import type { TopicsMenuState } from './useTopicsMenu';

interface TopicsMenuPortalProps {
  isMobile: boolean;
  topicsMenu: TopicsMenuState;
  sidebar: ReturnType<typeof useSidebarState>;
  menuPreferences: ReturnType<typeof useMenuPreferences>;
  splitLayoutAvailable: boolean;
  setSearchScope: Dispatch<SetStateAction<'all' | 'projects' | 'history'>>;
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  setShowChangelogFromMenu: Dispatch<SetStateAction<string | null>>;
  handleReopenClosedTab: ComponentProps<typeof TopicsMenuItems>['onReopenClosedTab'];
  openHistoryUrl: (url: string) => void;
}

/** The «Topics» title menu, portaled to the body to escape the sidebar's overflow. */
export function TopicsMenuPortal({
  isMobile, topicsMenu, sidebar, menuPreferences, splitLayoutAvailable,
  setSearchScope, setShowSearch, setShowChangelogFromMenu, handleReopenClosedTab, openHistoryUrl,
}: TopicsMenuPortalProps) {
  const {
    showTopicsMenu, setShowTopicsMenu, mobileSheetTopics, setMobileSheetTopics,
    topicsDropdownRef, topicsScrimRef, topicsMenuPos, topicsMenuRequest,
  } = topicsMenu;
  return (
    <>
      {/* Portal dropdowns (rendered outside sidebar to escape overflow-hidden) */}
      {showTopicsMenu && createPortal(
        <>
        {/* The bottom sheet's scrim, as in `Menu`: under 768px this menu is no
            longer a card hung from the title but a sheet, and a sheet without a
            scrim stands on its edge alone (measured elsewhere: 1.04:1 in light
            theme). */}
        {isMobile && (
          <div ref={topicsScrimRef} className="fixed inset-0 bg-black/40 modal-backdrop-enter" style={{ zIndex: Z_POPOVER_SCRIM }} onClick={() => setShowTopicsMenu(false)} />
        )}
        <div
          ref={topicsDropdownRef}
          data-testid="sidebar-topics-menu-panel"
          // Height cap + scroll, and a left clamp. This menu opened at
          // `trigger.bottom + 4` with NO bound of any kind: it has ~12 rows and
          // simply ran off the bottom on a short window, with the overflowing
          // rows unreachable. Capping to the space actually below the trigger
          // (and clamping the left edge to the shared POPOVER_MARGIN) keeps
          // every row reachable without a measure-then-place pass.
          className={
            isMobile
              // BOTTOM SHEET, and the entries go down into the band instead of
              // leaving it empty: it is the same law as the status bar,
              // `max(sab − 12, 8)`, not an `env()` stuck underneath, which
              // would leave a dead strip a third of a row high.
              // Under 768px this is THE phone's menu: the account lives here too,
              // so it must reach the thumb.
              ? `fixed bottom-0 left-0 right-0 ${POPOVER_SHEET} overflow-y-auto overscroll-contain`
              : `${POPOVER_SURFACE} min-w-[200px] overflow-y-auto overscroll-contain`
          }
          style={
            isMobile
              ? {
                  zIndex: Z_POPOVER,
                  paddingBottom: 'max(calc(var(--sab) - 12px), 8px)',
                  maxHeight: 'calc(100dvh - 3rem)',
                }
              : {
                  position: 'fixed',
                  top: topicsMenuPos.top,
                  left: Math.max(POPOVER_MARGIN, topicsMenuPos.left),
                  maxHeight: `calc(100vh - ${topicsMenuPos.top + POPOVER_MARGIN}px)`,
                  zIndex: Z_POPOVER,
                }
          }
        >
          {isMobile && <SheetGrabber />}
          {/* A question asked in here (a form's «remove?», «sign out?») is part
              of the menu: the dialog leaves it open (`useConfirm`). */}
          <ConfirmInsidePopoverContext.Provider value={true}>
          {/* WHO YOU ARE, at the top, as on the desktop card: the account, the
              people, the groups and the devices are the same component in
              both hosts (USERMENU-09). Before, the phone reached sign-in,
              rename and revoke only through the Settings panel. */}
          {/* A1: THE SHEET HAS TWO FLOORS, on the phone. The root is the user
              menu, who you are and how the machine is doing, and the
              «Topics» entry walks down to the floor with the rows. One floor
              MOUNTS while the other unmounts: with `hidden` the hidden buttons
              would stay under the finger of the MOBILE-CHROME-05 tests. On the
              desktop nothing changes: the mobile branches are off and the
              output is what it was, fragments included. */}
          {isMobile && !mobileSheetTopics && (
            <>
              <Suspense fallback={null}>
                <MobileIdentityMenuItems
                  key={topicsMenuRequest.n}
                  onClose={() => setShowTopicsMenu(false)}
                  openLevel={topicsMenuRequest.level}
                />
              </Suspense>
              <div className="border-t border-app-border" />
              <TopicsEntryRow onOpen={() => setMobileSheetTopics(true)} />
            </>
          )}
          {/* THE ROWS ARE A COMPONENT, not a copy. The same ones sit in the
              user card's menu at the foot of the column, which on the desktop
              is the only door of this chrome: two hand-written lists are two
              lists that one day answer differently - the same rule
              SIDEBAR-STATUS-01 writes for the status rows. */}
          {(!isMobile || mobileSheetTopics) && (
            <>
              {isMobile && <TopicsBackRow onBack={() => setMobileSheetTopics(false)} />}
              {isMobile && <div className="border-t border-app-border" />}
              <Suspense fallback={null}>
              <TopicsMenuItems
                key={topicsMenuRequest.n}
                isMobile={isMobile}
                showArchived={sidebar.showArchived}
                onToggleArchived={() => { sidebar.toggleShowArchived(); }}
                viewMode={sidebar.viewMode}
                onViewModeChange={sidebar.setViewMode}
                preferences={menuPreferences}
                splitLayoutAvailable={splitLayoutAvailable}
                onOpenHistory={() => { setSearchScope('history'); setShowSearch(true); setShowTopicsMenu(false); }}
                onReopenClosedTab={handleReopenClosedTab}
                onOpenHistoryUrl={openHistoryUrl}
                onClose={() => setShowTopicsMenu(false)}
                openLevel={topicsMenuRequest.level}
              />
              </Suspense>
            </>
          )}
          {/* THE STATE SITS AT THE BOTTOM, under the commands: above the things
              that DO something, below the things that SAY something. Same
              component on both screens, never a second copy counting the same
              memory. The alarms are NOT in here: they stay at the foot of the
              column, visible without opening anything (`SidebarStatusBar`). */}
          {(!isMobile || !mobileSheetTopics) && (
            <>
              <div className="my-1 border-t border-app-border" />
              <SidebarSystemMenu
                key={topicsMenuRequest.n}
                isMobile={isMobile}
                openLevel={topicsMenuRequest.level}
                onNavigate={() => setShowTopicsMenu(false)}
                onOpenChangelog={(version) => { setShowTopicsMenu(false); setShowChangelogFromMenu(version); }}
              />
            </>
          )}
          </ConfirmInsidePopoverContext.Provider>
        </div>
        </>,
        document.body
      )}
    </>
  );
}
