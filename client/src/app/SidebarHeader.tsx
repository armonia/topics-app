import { Suspense, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { isTauri } from '../lib/shell';
import {
  TITLE_INSET_WITH_CONTROLS_MAC,
  TITLE_INSET_WITH_CONTROLS_WINDOWS,
  TRAFFIC_LIGHT_DOT_PX,
  TRAFFIC_LIGHTS_WIDTH_PX,
  WINDOW_CONTROLS_INSET_PX,
} from '../lib/shell/windowControlsGeometry';
import { windowChrome } from '../lib/shell/windowChrome';
import { DRAG_REGION, NO_DRAG_REGION } from '../lib/shell/dragRegion';
import { WindowControls } from '../components/Shared/WindowControls';
import { PaneAddMenu } from '../components/Shared/PaneAddMenu';
import { TopicsLoadDot } from '../components/Sidebar/TopicsLoadDot';
import { shortcut, usesCtrl } from '../lib/shortcutLabel';
import { GLYPH_KBD_PADDING, MOBILE_SIDEBAR_HEADER_H, MOBILE_SIDEBAR_HEADER_H_COMPACT, RAISED_CONTROL, ROW_INSET, ROW_PX, SIDEBAR_ACTIVE, SIDEBAR_HOVER } from '../lib/selectionStyles';
import type { useWebSocket } from '../hooks/useWebSocket';
import type { TopicsMenuState } from './useTopicsMenu';
import { Inbox } from './lazyHosts';

// Tauri-on-macOS: the native traffic lights are permanent and the shell pins
// their frames (`apply_traffic_lights`, lib.rs). The room the rows keep for
// them is read from `windowChrome`, one value for every surface; this flag
// only still drives the wider gap of the mobile title button below.
const isTauriMac = isTauri && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

interface SidebarHeaderProps {
  isMobile: boolean;
  topicsMenu: TopicsMenuState;
  wsStatus: ReturnType<typeof useWebSocket>['status'];
  topicsError: string | null;
  onWSMessage: ReturnType<typeof useWebSocket>['onMessage'];
  setSearchScope: Dispatch<SetStateAction<'all' | 'projects' | 'history'>>;
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  handleQuickCreateTopic: () => unknown;
  handleStandaloneAddPane: ComponentProps<typeof PaneAddMenu>['onAddPane'];
}

/** The head of the sidebar column: the title, the bell, search and the add menu. */
export function SidebarHeader({
  isMobile, topicsMenu, wsStatus, topicsError, onWSMessage,
  setSearchScope, setShowSearch, handleQuickCreateTopic, handleStandaloneAddPane,
}: SidebarHeaderProps) {
  const {
    showTopicsMenu, setShowTopicsMenu, mobileTopFull, topicsMenuRef,
    setTopicsMenuPos, resetTopicsMenuRequest,
  } = topicsMenu;
  // THE TWO COMMANDS OF THE COLUMN, defined ONCE and mounted where needed.
  //
  // With the mouse they sit at the head of the sidebar, next to the title; with
  // the finger at the foot, where the thumb reaches. Two copies of the JSX would
  // be two buttons that open the same thing and diverge at the first touch-up,
  // which is exactly how the duplicate menus this pass removed were born. Only
  // the SIZE changes: 44px with the finger, 28 with the mouse.
  const sidebarSearchButton = (
    <button
      onClick={() => { setSearchScope('all'); setShowSearch(true); }}
      className={`edge-lit ${isMobile ? 'h-11 w-11 justify-center' : 'h-7'} flex items-center gap-1.5 rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag`} {...NO_DRAG_REGION}
      style={{ pointerEvents: 'auto', ...(isMobile ? null : GLYPH_KBD_PADDING) }}
      title={`Search (${shortcut('K')})`}
      aria-label="Search, open the command palette"
    >
      {/* 16 and not 14: next to a system icon (WhatsApp's «+» is the yardstick
          used) a 14 glyph in a 28 box reads as half a control. Sixteen fills
          the box without touching its edges. */}
      <Search size={isMobile ? 20 : 16} className="flex-shrink-0" aria-hidden="true" />
      {/* No label with the finger: the button sits NEXT to the title, in a row
          where every horizontal pixel is contested, and the magnifier alone
          reads. The label was for the bar at the foot, where the two commands
          were alone in a wide band. */}
      {/* `shortcut('K')` and not the glyph written out: the `title` two lines up
          is already per-platform, this one was pinned to "⌘K", so on Windows
          the button said "Ctrl+K" on hover and "⌘K" on its face, naming a key
          that machine does not have.
          AND NOT SHOWN AT ALL WHERE THE MODIFIER IS Ctrl, because there the
          hint costs more than the row has. The sidebar is 255px and the sums
          are these: "⌘K"/"⌘N" leave 242px of content in 243 available, while
          "Ctrl+K"/"Ctrl+N" ask for 280, 37px that have to come from somewhere,
          and they came from the notification bell, pushed out of its own group
          and underneath the `z-50` one, where it stopped taking clicks (twelve
          `notification-history` reds on Linux CI, measured 2026-08-26). The
          `title` keeps saying it on hover, in full and in the right words. */}
      {/* `kbd-hint`: THE HINT YIELDS BEFORE THE WORDMARK. Inside the sidebar
          header this class is what a container query switches off once the row
          is too narrow to hold «Topics» whole as well, see `.sidebar-header`
          in index.css for the measured threshold. The button stays clickable
          and its `title` two lines up keeps naming the shortcut. */}
      {!isMobile && !usesCtrl && <kbd className="kbd kbd-hint flex-shrink-0 hidden md:inline">{shortcut('K')}</kbd>}
    </button>
  );
  const sidebarAddMenu = (
    <PaneAddMenu
      scope="standalone"
      presentation="palette"
      onNewChat={() => handleQuickCreateTopic()}
      onAddPane={handleStandaloneAddPane}
      triggerTitle={`New (${shortcut('N')})`}
      triggerVariant="header"
      // Same reason as the `<kbd>` of Search just above: where the modifier is
      // Ctrl the hint does not fit in the row, and the `title` already says it.
      triggerKbd={usesCtrl ? undefined : shortcut('N')}
    />
  );

  return (
        /* Header - draggable for window move. Horizontal inset = ROW_INSET,
            the same 6px the tab strip, the sidebar cards, and the list's
            vertical padding use, one inset on every sidebar axis. */
        <div
          // THE HEIGHT FOLLOWS THE BUTTONS, not the other way round. With the
          // finger the two commands are 44px (the iOS threshold) and the row was
          // 48: 2px above and 2 below, i.e. «the keys touch the edge». 44 + 2 *
          // ROW_INSET = 56 (`h-14`) and the air goes back to that of the whole
          // column, the SAME 6px that separates a card from the edge and a row
          // from its neighbour. With the mouse the buttons are 28 and the row
          // stays 40, which is the same identity: 28 + 2 * 6 = 40.
          // NO LINE UNDER THE HEADER (08/08). Above and below there is the same
          // surface, the column is chrome from top to bottom, so that line did
          // not separate two things: it only drew a boundary. The two commands
          // already say where the header ends, having a ground of their own, and
          // so does the first card of the list, which is inset by 6.
          //
          // Note for whoever comes back here: the same does NOT hold for the line
          // under the panes' tabbar. There I measured, bar and content have the
          // SAME ground in all four combinations (phone/desktop × light/dark), so
          // that line is the only separation that exists and removing it merges
          // the two zones. Here instead the header has what it takes to be
          // recognised within itself.
          // `sidebar-header`: the row declares itself a container so its own
          // width can decide what stays in it. What it decides today is the
          // keyboard hints (`kbd-hint`), which go before the wordmark shrinks
          //, the threshold and the sum behind it are in index.css.
          //
          // ON A PHONE THIS ROW HAS NO GROUND AND IS NOT IN THE FLOW: it is a
          // layer over the list, sitting at the safe-area inset (card
          // 1e015ad6). The tabs travel BEHIND it instead of stopping at its
          // edge, and the band under the status bar stops being a dead strip.
          // `pointer-events: none` on the row and `auto` on its two commands:
          // where there is nothing to press the finger belongs to the list
          // scrolling underneath, or the column would carry 56px of glass at
          // the top that stop a scroll without saying why.
          className={`sidebar-header flex items-center justify-between flex-shrink-0 app-drag-region ${
            // `pointer-events-none` WITHOUT `[&>*]:pointer-events-auto`: under
            // the row the tabs run from right after the safe area (A1), and
            // the two groups it is made of, one `flex-1`, wide as the whole
            // row, would eat the taps of the first one. Only the BUTTONS take
            // a tap, each on its own (Topics and the bell with inline
            // `pointerEvents: 'auto'`, the window controls with their own
            // class): the wrappers let everything through.
            isMobile ? 'mobile-top-veil pointer-events-none absolute inset-x-0 z-10' : 'h-10'
          }`} {...DRAG_REGION}
          // A1: compact at the head (44, the buttons), whole while scrolling
          // (56). Out of flow in both cases, so the size moves nothing,
          // `data-compact` is the spec's handle.
          data-compact={isMobile ? String(!mobileTopFull) : undefined}
          style={{
            paddingRight: ROW_INSET,
            paddingLeft: ROW_INSET,
            gap: ROW_INSET,
            ...(isMobile ? {
              top: 'env(safe-area-inset-top, 0px)',
              height: mobileTopFull ? MOBILE_SIDEBAR_HEADER_H : MOBILE_SIDEBAR_HEADER_H_COMPACT,
            } : null),
          }}
        >
          {/* ONE STEP FROM EDGE TO EDGE. The pair at the other end of this row
              (search and add) sits at `gap: ROW_INSET`; the lights, the word
              and the bell on this end use the same 6px, so a ruler across the
              row reads one number. Mobile keeps its `gap-2`: down there the
              row is a different composition (no lights, bell on the right). */}
          <div
            className={`flex items-center flex-1 min-w-0 ${isMobile ? 'gap-2' : ''}`}
            style={isMobile ? undefined : { gap: ROW_INSET }}
          >
            {/* NO «X» next to the title. The mobile drawer closes by itself as
                soon as you open something (`if (isMobile) setSidebarCollapsed(true)`,
                a dozen places in usePanelLifecycle) and by dragging it towards
                the left with the finger (`useSidebarSwipe`), so the cross was
                not the exit, it was a third copy of the same exit, put where
                the eye looks for the title. It also cost the column: `w-10 -ml-1 mr-1` + the `gap-2`
                of the container pushed «Topics» to x=60, i.e. 46px further to
                the right than the names of the rows below (x=14). Removed, the
                title goes back in column with them. */}
            {/* Topics button - opens combined settings & tools menu */}
            {/* `relative`: THE WINDOW COMMANDS ARE ANCHORED HERE. On Windows
                they come out over this button when the menu opens, exactly where
                the Mac's traffic lights come out (`trafficLightPosition`
                { x: 12, y: 12 }, i.e. ROW_INSET into this wrapper), see
                WindowControls. They are absolute, so they add nothing to this
                row: `h-10` stays `h-10` whether they are lit or not. */}
            {/* `min-w-0`, AND IT IS LOAD-BEARING. This wrapper sits between the
                shrinkable left group and the title button, and a flex child
                defaults to `min-width: auto`: without it the wrapper refuses to
                go below its content, so the label never truncates however
                narrow the room, the left group grows past its share, and the
                row, `justify-between`, lets it run INTO the group on the
                right. Measured on CI 2026-08-31: the bell at 113-141 with the
                Search button at 127-184 painted over it, so a click on the
                bell opened Search instead. Reproduced here by widening the
                label with letter-spacing: at 2px the bell already stops
                receiving its own clicks, and the wrapper measured 119px inside
                a row of 117 (overflow 38). Truncate on the label alone does
                NOTHING while a link in this chain says `auto`. */}
            {/* THE TITLE IS NOT A MENU ANY MORE, ON THE DESKTOP.
                Asked for on card 022db87b: at the top only «Topics», next to
                the window commands, with no accordion and no dot of its own.
                The submenu it used to open - archived, view, panels, history,
                settings, performance - moved UNDER THE USER CARD at the foot of
                the column, which is now the single door of this chrome.
                That dropdown was also the only reason the Mac's traffic lights
                stayed hidden until a click: they are permanent now, and the
                word sits to their right (`TITLE_INSET_WITH_CONTROLS_MAC` on the
                Mac, `TITLE_INSET_WITH_CONTROLS_WINDOWS` on Windows).
                ON THE PHONE THE MENU STAYS: down there the column is a drawer,
                the identity band does not exist (width contract,
                SIDEBAR-STATUS-01) and this button is the only way to archived,
                view and settings. The rows are the SAME ones though, one
                component (`TopicsMenuItems`), never a copy. */}
            <div
              className={`app-no-drag relative min-w-0 ${windowChrome === 'mac' ? TITLE_INSET_WITH_CONTROLS_MAC : windowChrome === 'windows' ? TITLE_INSET_WITH_CONTROLS_WINDOWS : ''}`}
              {...NO_DRAG_REGION}
              ref={topicsMenuRef}
            >
              {/* THE LIGHTS, AS A BOX THAT CAN BE MEASURED. The Mac's three
                  lights are native: AppKit paints them over the webview and no
                  DOM node stands where they are, so nothing here could assert
                  that the word starts to their right, or by how much. This is
                  the rectangle the shell pins them to (`apply_traffic_lights`,
                  lib.rs: x=12 in the window, 52 wide, centred on the 40px
                  header), in the wrapper's coordinates: 6 = 12 - ROW_INSET.
                  It paints nothing, catches nothing and is not read aloud; it
                  only exists so a test can ask where the lights are. */}
              {windowChrome === 'mac' && (
                <div
                  data-testid="traffic-lights-box"
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 -translate-y-1/2"
                  style={{
                    left: WINDOW_CONTROLS_INSET_PX - ROW_INSET,
                    width: TRAFFIC_LIGHTS_WIDTH_PX,
                    height: TRAFFIC_LIGHT_DOT_PX,
                  }}
                />
              )}
              {!isMobile ? (
                <span
                  data-testid="sidebar-topics-title"
                  className={`flex min-h-7 items-center ${ROW_PX} py-0.5 font-semibold text-app-text tracking-[-0.01em] truncate text-title`}
                >
                  Topics
                </span>
              ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showTopicsMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setTopicsMenuPos({ top: rect.bottom + 4, left: rect.left });
                    resetTopicsMenuRequest();
                  }
                  setShowTopicsMenu(!showTopicsMenu);
                }}
                // ROW_PX, not `px-1.5` written by hand: it is the same inner
                // inset as every row of the sidebar, and it is needed so that
                // «Topics» and the chat names sit on the SAME column. Measured
                // (390×844 and 1280×800): a row's card starts at
                // ROW_INSET=6 and its text at 6+8=14; the button starts at 6
                // (the header's paddingLeft) and with px-1.5 the title fell at
                // 12, 2px to the left of the names below, the near-miss that
                // reads worse than a clear difference. With ROW_PX the title goes to 14
                // and the hover lift stays flush with the card edge.
                // THE HEIGHT IS DICTATED BY THE ROW, and the row is dictated by its
                // commands: `h-14` with the finger around 44 buttons, `h-10` with
                // the mouse around 28 buttons (see the header comment).
                // The title followed neither: a fixed `min-h-7`, which with 17px
                // text becomes 29.5 inside a 56 row, measured. Effect: its lift
                // ended 13px above the bottom of the row while Search and «+»,
                // next to it, reach 6.
                // From afar it reads as extra space under the header, and it is half of the
                // «double spacing» seen on the phone. As a side effect the menu's target
                // goes from 29.5 to 44, i.e. to the threshold every other command of
                // this row already respects.
                // `isMobile` and not `md:`: in the header that predicate decides,
                // and two mechanisms in the same row diverge (it is the defect
                // just removed from the tab bar).
                className={`flex items-center min-w-0 ${isTauriMac ? 'gap-2' : 'gap-1'} ${ROW_PX} py-0.5 ${isMobile ? 'min-h-11' : 'min-h-7'} rounded-lg transition-colors cursor-pointer ${
                  // Lift in ALPHA, not `bg-app-hover`: this button sits on the
                  // chrome, and an opaque one calibrated on `--bg-surface` goes
                  // the wrong way there in light theme. See SIDEBAR_HOVER.
                  showTopicsMenu ? SIDEBAR_ACTIVE : SIDEBAR_HOVER
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
                // A stable handle for the title button: its accessible NAME is
                // «Topics» (the text), not the `title`, so looking it up by
                // role+name means looking it up by a word that appears in half
                // the column. It is the same reason project rows have
                // `project-toggle-*`.
                data-testid="sidebar-topics-menu"
              >
                {/* The room for the window commands is on the WRAPPER now
                    (`TITLE_INSET_WITH_CONTROLS_MAC` / `_WINDOWS`), not on this label: the
                    commands no longer come out over the word, they sit to its
                    left and stay there. */}
                <span className="font-semibold text-app-text tracking-[-0.01em] truncate text-title">Topics</span>
                {/* HOW HEAVY THE MACHINE IS, right next to its name. This is
                    what stayed on screen when the numbers at the foot of the
                    column moved into this menu: the exact figures are one click
                    away, the "is it fine" is not. It hides with the title under
                    the window commands, because on Windows and on macOS those
                    are painted over this exact spot when the menu is open, and
                    a dot surviving underneath them would read as a glitch.
                    See `TopicsLoadDot`. */}
                {/* IT DOES NOT UNMOUNT ANY MORE, it goes `invisible`, the same
                    trick the title next to it uses. Unmounting it made the row
                    NARROWER the moment the menu opened, i.e. the trigger
                    resized under the finger that had just clicked it. And
                    keeping it in the DOM is what lets it carry
                    `connection-status`, the handle half the E2E suite uses to
                    know the app is up (layout.fixture, multi-client,
                    tab-sync): a handle that disappears when a menu opens is a
                    handle that answers the wrong question.

                    ONE dot, not two. The alarm rides on THIS one instead of a
                    second lamp beside it: two dots 4px apart are not two
                    signals, they are one signal that looks broken. */}
                <TopicsLoadDot alarm={wsStatus !== 'connected' || !!topicsError} />
                {/* 14, like the glyph of «Search» and of the «+» next to it on the
                    SAME row, measured: it was 12 against their 14, and the radius
                    6 against 8. Three side-by-side elements with three different
                    shapes are not three styles, they are a defect: Add and Search
                    are the reference. */}
                <ChevronDown size={14} className={`text-app-text-secondary transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
              )}
              {/* The window commands, and ONLY on Windows: there the system frame
                  is off (the app draws its own) and without these there would be
                  no way left to minimise, maximise or close except through the
                  taskbar. They sit HERE, over the button, and not at the end of
                  the row: on macOS the component renders nothing because those
                  commands are the traffic lights, and the shell paints them over
                  this exact spot. Same place on both systems, same order.
                  A SIBLING of the button and not a child: a button inside a
                  button is invalid HTML, and the browser would take the nesting
                  apart on its own. */}
              {/* ALWAYS LIT, now that the title is not a trigger. They used to
                  appear with the Topics menu, mirroring the Mac's traffic
                  lights, which appeared with it too; the menu is gone from the
                  desktop and a window with no way to close it is not an
                  option, so both sets are permanent and the title sits to
                  their right. */}
              <WindowControls visible />
            </div>
            {/* WITH THE MOUSE IT SITS NEXT TO TOPICS, and not at the end of the row with
                Search and «+»: those two are commands that CREATE or SEARCH, this
                one is a state, it says how many things happened while you were
                not looking. It sits beside the column's identity because it is the
                first thing you look at on coming back to the app.
                NOT WITH THE FINGER: on the phone the top row has «Topics» on the left
                and the bell on the RIGHT (14/08), which is the side where the phone
                keeps status in every app that opens, and where Search and
                «+» are no longer, having moved down into the bottom row. The same
                button, mounted on the other side: the panel anchors to the
                trigger's rectangle and keeps itself inside the screen. */}
            {!isMobile && (
              <div className="app-no-drag flex-shrink-0" {...NO_DRAG_REGION}>
                <Suspense fallback={<span className="w-7 h-7 flex-shrink-0" aria-hidden="true" />}>
                  <Inbox onWSMessage={onWSMessage} isMobile={isMobile} />
                </Suspense>
              </div>
            )}
          </div>

          {isMobile && (
            <div className="app-no-drag flex-shrink-0" {...NO_DRAG_REGION}>
              <Suspense fallback={<span className="w-7 h-7 flex-shrink-0" aria-hidden="true" />}>
                <Inbox onWSMessage={onWSMessage} isMobile />
              </Suspense>
            </div>
          )}
          {/* SEARCH AND «+», at the end of the title row.
              They have turned around: they were here, ended up in a bar at the
              foot of the column on the phone (right geometry for the thumb, wrong
              price, two commands detached from the thing they command), then
              attached to the logo, and now they are back aligned to the right,
              which is where the eye looks for shortcuts. They are always the
              SAME two buttons, defined once above: only the size changes, 44px
              with the finger and 28 with the mouse. */}
          {/* ON THE PHONE THERE IS NOTHING ELSE AT THE TOP.
              «On one side topics, clickable; on the other nothing else» (12/08).
              Search and «+» do not disappear: they go down into the bottom row
              (`MobileChromeBar`), where the thumb reaches and where they sit
              together with the third door, the board. They are always the SAME
              two commands defined once above, what changes is where they are
              mounted, not what they are. */}
          {!isMobile && <div
            className="flex items-center relative z-50 app-no-drag flex-shrink-0"
            {...NO_DRAG_REGION}
            // `gap: ROW_INSET`, not `gap-2` written by hand. The column has ONE
            // step, 6px, and it is the same that separates a card from the
            // edge, a card from its neighbour, and these buttons from the right
            // edge and from the lines above and below. Between the two it was 8,
            // the only distance in the row that did not add up («the spacing
            // between the two keys does not seem right»): with everything else at 6 a
            // two-pixel gap does not read as a choice, it reads as a mistake.
            style={{ pointerEvents: 'auto', gap: ROW_INSET }}
          >
            {sidebarSearchButton}
            {sidebarAddMenu}
          </div>}
        </div>
  );
}
