/**
 * ONE DOOR AT THE FOOT OF THE COLUMN, and everything behind it.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * There were FIVE doors in the chrome and they all led into the same house:
 * the account chip, the groups chip and the friends chip at the foot of the
 * column, plus the «Topics» dropdown at the top with the view commands and the
 * machine's own numbers inside it. Five triggers, five panels, five places to
 * learn, and the one thing every one of them is about is the person using the
 * app. A person does not have five identities, so the app stops offering five
 * ways to ask about them.
 *
 * Now it is the USER CARD, and this is what opens under it: the account, the
 * people, the groups, the commands of the column, and the state of the machine.
 * The order is the one a menu of this kind is read in: who you are first,
 * whoever else is around second, what you can DO third, what the machine SAYS
 * last. Above the things that do something, below the things that say something
 * - the same order the «Topics» menu already had internally, kept in the move.
 *
 * ── WHY SUBMENUS, AND NOT SECTIONS THAT EXPAND ──────────────────────────────
 * Friends, groups and the running agents are lists, and for a while they were
 * accordions: a chevron turning ninety degrees and the list unfolding inside
 * the same panel. That shape has a cost the first open pays and every open
 * after it repeats: an accordion pushes every row below it down, so the
 * commands and the system rows jump, and a two level menu turns into a
 * scrolling column you have to hunt through. A submenu opens its level beside
 * the row, where the eye already is, and the host panel does not move. The
 * shared `SubmenuItem` (on the `Menu` primitive) owns the placement, the flip
 * at the window edge, the dismissal contract and the occlusion of a native
 * browser pane, so this file only says what goes in each level.
 *
 * The panel reads in groups, hairline between each: what you are and what you
 * pay (account, plan), the people (friends, groups), the machines (devices,
 * nodes), what the app runs on and reaches (AI providers, tools, calendar), the
 * preferences and commands of the column, the app. Every setting lives here:
 * the forms too, in wider levels (`FormLevel`), and there is no Settings
 * window behind a last row any more (USERMENU-06).
 *
 * ── AND THE MENU DOES NOT REPEAT THE CARD ───────────────────────────────────
 * The card that opens it already says your name and what the machine is
 * spending. The menu says the things the card cannot: the address you are
 * signed in with, the way in when there is no account, the names of the people
 * behind the chips, the exact numbers behind the dot.
 */
import { useLayoutEffect, useState } from 'react';
import { MenuWidthProvider } from '../Shared/SubmenuItem';
import { PresencePopover } from './PresencePopover';
import { TopicsMenuItems, type TopicsMenuItemsProps } from './TopicsMenuItems';
import { SidebarSystemMenu } from './SidebarSystemMenu';
import { IdentityMenuItems } from './IdentityMenuItems';
import type { IdentityMenuData } from '@/hooks/useIdentityMenuData';
import type { WorkSignal } from './workSignals';
import type { UserMenuLevel } from '@/lib/openUserMenu';
import { ConfirmInsidePopoverContext } from '@/hooks/confirmInsidePopover';

/** The commands of the column, as they arrive from `App`: everything the
 *  «Topics» dropdown used to hold, minus the two things this menu decides for
 *  itself (which hand it is drawn for, and how it closes). */
export type SidebarCommands = Omit<TopicsMenuItemsProps, 'isMobile' | 'onClose'> & {
  onOpenChangelog: (version: string) => void;
};

/**
 * THE PANEL IS AS WIDE AS THE COLUMN IT HANGS FROM, and never narrower than
 * this.
 *
 * It was a constant, 288. That was fine while the column measured 256: the
 * panel overhung by a little and nobody noticed. But the column drags between
 * 180 and 400 (`useSidebarAndLayout`), and at 400 the ratio inverts - a 288
 * menu hanging off a 388 card reads as a small window, which is exactly the
 * defect that was reported.
 *
 * THE ANCHOR IS MEASURED, not the state. The real width lives in a `useState`
 * of `App` that nobody in this chain can read, and it is persisted to
 * `app-settings` one round late: while the column is being dragged the measure
 * exists only in the DOM. The card that opens the menu is `w-full` inside the
 * column, so its rect IS the column, always, and with no new props. Same
 * precedent as `Select`, which measures its trigger's rect on open.
 *
 * THE FLOOR STAYS 288 because this panel holds an email field and a code
 * field: under 300 an address is typed into a two-word window. With a narrow
 * column the menu is therefore wider than the column, and that is right - it
 * is the case the number was chosen for.
 */
const MIN_WIDTH = 288;

/** The anchor's width, measured before paint and measured again while it is
 *  dragged: the `ResizeObserver` costs one call per gesture and removes the
 *  question "what if the column changes while the menu is open". */
function useAnchorWidth(anchorEl: HTMLElement | null, floor: number): number {
  const [width, setWidth] = useState(floor);
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const measure = () => setWidth(Math.max(floor, Math.round(anchorEl.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchorEl);
    return () => observer.disconnect();
  }, [anchorEl, floor]);
  return width;
}

export function ProfileMenu({
  anchorEl, onClose, identity, signals, commands, openLevel = null, focusFirstRow = false,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** The account, the people and the devices (`useIdentityMenuData`). */
  identity: IdentityMenuData;
  /** What is running right now, already picked and tiered by `workSignals`. */
  signals: WorkSignal[];
  commands: SidebarCommands;
  /** The level `openUserMenu` asked for, open from the first render. */
  openLevel?: UserMenuLevel | null;
  /** Opened by ⌘, : the first row has the focus. */
  focusFirstRow?: boolean;
}) {
  const width = useAnchorWidth(anchorEl, MIN_WIDTH);

  return (
    <PresencePopover
      anchorEl={anchorEl}
      onClose={onClose}
      testId="profile-menu"
      width={width}
      focusFirstRow={focusFirstRow}
    >
      {/* THE PANEL SCROLLS, THE WINDOW DOES NOT. Everything the chrome knows is
          in here now, and the account block plus the performance panel opened
          is taller than a small laptop screen. The popover flips above the card
          by itself; what it cannot do is shrink, so the cap lives here. */}
      {/* THE MEASURE GOES DOWN TO THE LEVELS. Without it a 400 host opens
          sublevels at 230 and the menu becomes a staircase: the number written
          at each call site stays as the floor, and this raises it. */}
      {/* A QUESTION ASKED IN HERE IS PART OF THE MENU. The forms ask before
          they destroy («remove the licence?», «sign out?»): the dialog leaves
          the menu open behind it, and answering is not a press outside. */}
      <ConfirmInsidePopoverContext.Provider value={true}>
      <MenuWidthProvider width={width}>
      <div className="max-h-[min(70vh,560px)] overflow-y-auto">
        <IdentityMenuItems data={identity} width={width} onClose={onClose} openLevel={openLevel} />

        <div className="border-t border-app-border" />
        <TopicsMenuItems
          isMobile={false}
          {...commands}
          onClose={onClose}
          openLevel={openLevel}
        />

        <div className="border-t border-app-border" />
        <SidebarSystemMenu
          signals={signals}
          onOpenChangelog={(version) => { onClose(); commands.onOpenChangelog(version); }}
        />
      </div>
      </MenuWidthProvider>
      </ConfirmInsidePopoverContext.Provider>
    </PresencePopover>
  );
}
