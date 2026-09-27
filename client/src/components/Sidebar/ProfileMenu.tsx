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
 * The panel therefore reads as FIVE groups, hairline between each: the
 * account, the people, the agents, the commands of the column, the app.
 *
 * ── AND THE MENU DOES NOT REPEAT THE CARD ───────────────────────────────────
 * The card that opens it already says your name and what the machine is
 * spending. The menu says the things the card cannot: the address you are
 * signed in with, the way in when there is no account, the names of the people
 * behind the chips, the exact numbers behind the dot.
 */
import { Suspense, useCallback, useLayoutEffect, useState } from 'react';
import { Building2, Monitor, Users } from 'lucide-react';
import { MenuWidthProvider, SubmenuItem } from '../Shared/SubmenuItem';
import { PresencePopover } from './PresencePopover';
import { FaceStack, MenuAction, PresenceList } from './PresenceList';
import { TopicsMenuItems, type TopicsMenuItemsProps } from './TopicsMenuItems';
import { AccountPanel } from './accountPanelLazy';
import { SidebarSystemMenu } from './SidebarSystemMenu';
import { CHIP_INK_DIM, ORG_MARKS_IN_CHIP } from './identityChip';
import { PALLINO_OK, SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';
import { mergePeople } from './orgPresence';
import type { OrgWithPresence } from '@/hooks/useIdentityPresence';
import type { FriendPresence } from '@/hooks/useFriendPresence';
import type { LabelIdentity } from './identityLabel';
import type { WorkSignal } from './workSignals';
import { apriProfilo } from '@/state/profileTarget';
import { useT } from '@/hooks/useT';

/** One row of `/api/auth/devices`, trimmed to what the submenu draws: a name,
 *  whether it holds a live socket right now, and whether it is this one. */
export interface LiveDevice {
  id: string;
  name: string;
  connected: boolean;
  current: boolean;
}

/** A glyph component, taken as a prop: which device you are on was decided by
 *  the card, and deciding it twice is how the two disagree. */
type Glyph = React.ComponentType<{ size?: number; className?: string }>;

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
  anchorEl, onClose, who, DeviceIcon, devices, orgs, friends, signals, commands, onOpenDevices,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  who: LabelIdentity;
  DeviceIcon: Glyph;
  /** The authorised devices, `null` while the first fetch has not answered
   *  yet - treated the same as an empty list here, since it settles before a
   *  person has time to open this menu. */
  devices: LiveDevice[] | null;
  orgs: OrgWithPresence[];
  friends: FriendPresence;
  /** What is running right now, already picked and tiered by `workSignals`. */
  signals: WorkSignal[];
  commands: SidebarCommands;
  onOpenDevices?: () => void;
}) {
  const width = useAnchorWidth(anchorEl, MIN_WIDTH);

  return (
    <PresencePopover
      anchorEl={anchorEl}
      onClose={onClose}
      testId="profile-menu"
      width={width}
    >
      {/* THE PANEL SCROLLS, THE WINDOW DOES NOT. Everything the chrome knows is
          in here now, and the account block plus the performance panel opened
          is taller than a small laptop screen. The popover flips above the card
          by itself; what it cannot do is shrink, so the cap lives here. */}
      {/* THE MEASURE GOES DOWN TO THE LEVELS. Without it a 400 host opens
          sublevels at 230 and the menu becomes a staircase: the number written
          at each call site stays as the floor, and this raises it. */}
      <MenuWidthProvider width={width}>
      <div className="max-h-[min(70vh,560px)] overflow-y-auto">
        <Suspense fallback={null}>
          <AccountPanel
            who={who}
            DeviceIcon={DeviceIcon}
            onOpenProfile={() => { onClose(); apriProfilo('profile'); }}
          />
        </Suspense>

        <div className="border-t border-app-border" />
        <FriendsSection friends={friends} onClose={onClose} />
        <OrgsSection orgs={orgs} onClose={onClose} />
        <DevicesSection devices={devices} onOpenDevices={onOpenDevices} onClose={onClose} />

        <div className="border-t border-app-border" />
        <TopicsMenuItems
          isMobile={false}
          {...commands}
          onClose={onClose}
        />

        <div className="border-t border-app-border" />
        <SidebarSystemMenu
          signals={signals}
          onOpenChangelog={(version) => { onClose(); commands.onOpenChangelog(version); }}
        />
      </div>
      </MenuWidthProvider>
    </PresencePopover>
  );
}

/**
 * YOUR FRIENDS, and whoever of them is waiting for an answer.
 *
 * The chips at the foot of the column show who is HERE; this section is the
 * whole graph, present and absent, which is a list and belongs behind a
 * gesture. A pending request tints the count amber, because it is the only
 * thing in here that somebody is waiting on, and it is answered right in the
 * section: sending a person to a page to press "accept" is the round trip the
 * panel exists to remove.
 */
function FriendsSection({ friends, onClose }: { friends: FriendPresence; onClose: () => void }) {
  const tr = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const { incoming, accept, decline, rows, faces: online } = friends;
  const pending = incoming.length;

  const answer = useCallback(async (id: string, yes: boolean) => {
    setBusy(id);
    try {
      await (yes ? accept(id) : decline(id));
    } catch {
      // The rule refused it (the request was withdrawn while the panel held
      // it). The hook reloads on its own tick and the row corrects itself.
    }
    setBusy(null);
  }, [accept, decline]);

  return (
    <SubmenuItem
      icon={Users}
      label={tr('statusBar.friends.title')}
      testId="profile-menu-friends"
      minWidth={244}
      // A COUNT ONLY WHEN THERE IS SOMETHING TO COUNT. It used to read «0 of
      // 7 online», which spends the tail of the row on the one state that has
      // nothing to say: how many friends you have is not news, and «0 of» is a
      // zero dressed as a measurement. The tail speaks when somebody is there,
      // or when somebody is waiting for an answer, and stays quiet otherwise -
      // the same rule the chips at the foot of the column already follow.
      tail={pending > 0 || online.length > 0 ? (
        <span
          data-testid="friends-count"
          data-pending={pending > 0 ? 'true' : 'false'}
          className={`flex-shrink-0 tabular-nums ${pending > 0 ? SEGNALE_ATTESA : SEGNALE_OK}`}
          title={pending > 0 ? tr('statusBar.friends.pending', { n: pending }) : undefined}
        >
          {pending > 0
            ? tr('statusBar.friends.pendingCount', { n: pending })
            : tr('statusBar.friends.online', { n: online.length })}
        </span>
      ) : undefined}
    >
      {pending > 0 && (
        <div data-testid="friends-requests" className="border-b border-app-border py-1">
          <div className="px-3 pb-0.5 pt-1 text-micro uppercase tracking-wide text-app-text-muted">
            {tr('profile.friend.incoming')}
          </div>
          {incoming.map((p) => (
            <div key={p.id} className="flex items-center gap-2 px-3 py-1">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
                {p.github?.avatarUrl
                  ? <img src={p.github.avatarUrl} alt="" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-nano font-semibold leading-none text-app-text">
                      {p.displayName.slice(0, 1).toUpperCase()}
                    </span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-mini text-app-text">{p.displayName}</span>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void answer(p.id, true)}
                data-testid={`friend-accept-${p.id}`}
                title={tr('profile.friend.accept')}
                className="flex-shrink-0 rounded border border-primary px-1.5 py-0.5 text-mini text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {tr('profile.friend.accept')}
              </button>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void answer(p.id, false)}
                data-testid={`friend-decline-${p.id}`}
                title={tr('profile.friend.decline')}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-mini text-app-text-tertiary hover:bg-app-hover disabled:opacity-50"
              >
                {tr('profile.friend.decline')}
              </button>
            </div>
          ))}
        </div>
      )}
      <PresenceList people={rows} empty={tr('statusBar.friends.none')} hint={tr('statusBar.friends.noneHint')} />
      <div className="border-t border-app-border py-1">
        <MenuAction onClick={() => { onClose(); apriProfilo('followers'); }} testId="friends-open-all">
          {tr('statusBar.friends.manage')}
        </MenuAction>
      </div>
    </SubmenuItem>
  );
}

/**
 * THE GROUPS YOU ARE IN, one section, with their people inside.
 *
 * They used to be a chip on the band, which made a permanent slot of an answer
 * that changes twice a year: which organisations you belong to is not something
 * you check hourly, and the chip was spending a third of the band's width to
 * say "one". Here the row says how many, opens onto who is in them, and keeps
 * the door to managing them at the bottom.
 *
 * AND IT IS THERE AT ZERO, because "what is an organisation, and how do I end
 * up in one" is a question only somebody in none can have.
 */
function OrgsSection({ orgs, onClose }: { orgs: OrgWithPresence[]; onClose: () => void }) {
  const tr = useT();
  const people = mergePeople(orgs.map((o) => o.people));
  const online = people.filter((p) => p.presente).length;
  const only = orgs.length === 1 ? orgs[0] : null;

  return (
    <SubmenuItem
      icon={Building2}
      label={only ? only.nome : tr('statusBar.orgs.title')}
      testId="profile-menu-orgs"
      minWidth={244}
      tail={
        <span data-testid="orgs-count" className={`flex-shrink-0 tabular-nums ${online > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}>
          {orgs.length === 0 ? '0' : tr('statusBar.orgs.presence', { n: online, tot: people.length })}
        </span>
      }
    >
      {orgs.length === 0 ? (
        <div className="px-3 py-2 text-mini text-app-text-secondary">{tr('statusBar.orgs.noneHint')}</div>
      ) : only ? (
        <PresenceList people={only.people} empty={tr('statusBar.orgs.alone')} />
      ) : (
        <div className="max-h-[240px] overflow-y-auto">
          {orgs.map((o) => (
            <div key={o.id} data-testid="org-section">
              <div className="flex items-center gap-2 px-3 pb-0.5 pt-1.5 text-micro uppercase tracking-wide text-app-text-muted">
                <OrgLogo org={o} />
                <span className="min-w-0 flex-1 truncate normal-case">{o.nome}</span>
                <FaceStack faces={o.faces} max={ORG_MARKS_IN_CHIP} total={o.online} />
                <span className={`flex-shrink-0 tabular-nums ${o.online > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}>
                  {tr('statusBar.friends.count', { n: o.online, tot: o.membri })}
                </span>
              </div>
              <PresenceList people={o.people} empty={tr('statusBar.orgs.alone')} />
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-app-border py-1">
        <MenuAction onClick={() => { onClose(); apriProfilo('organization'); }} testId="org-open-manage">
          {only ? tr('statusBar.orgs.manageOne') : tr('statusBar.orgs.manageAll')}
        </MenuAction>
      </div>
    </SubmenuItem>
  );
}

/**
 * THE AUTHORISED DEVICES, listed here instead of behind a button that only
 * navigated to Settings.
 *
 * It used to be one door with a count in its tail («Authorised devices · 0 of
 * 2 connected»), which told you the number and then made you leave the panel
 * to learn what the two devices even were. The row now opens onto the same
 * list `Settings/DevicesSection` draws, in miniature, and «Gestisci i
 * dispositivi» stays as the one door left, for the gesture that panel alone
 * still owns: revoking one.
 */
function DevicesSection({ devices, onOpenDevices, onClose }: {
  devices: LiveDevice[] | null;
  onOpenDevices?: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  if (!onOpenDevices) return null;
  const list = devices ?? [];
  const online = list.filter((d) => d.connected).length;

  return (
    <SubmenuItem
      icon={Monitor}
      label={tr('statusBar.me.devicesRow')}
      testId="profile-menu-devices"
      minWidth={244}
      tail={list.length > 0 ? (
        <span data-testid="devices-count" className={`flex-shrink-0 tabular-nums ${online > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}>
          {tr('statusBar.me.devicesCount', { n: online, tot: list.length })}
        </span>
      ) : undefined}
    >
      {list.length === 0 ? (
        <div className="px-3 py-2 text-mini text-app-text-secondary">{tr('devices.none')}</div>
      ) : (
        <div className="max-h-[240px] overflow-y-auto py-1">
          {list.map((d) => (
            <div key={d.id} data-testid="device-row" className="flex items-center gap-2 px-3 py-1 text-mini">
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${d.connected ? PALLINO_OK : 'bg-app-text-muted/40'}`} />
              <span className="min-w-0 flex-1 truncate text-app-text">{d.name}</span>
              {d.current && <span className="flex-shrink-0 text-app-text-muted">{tr('devices.youAreHere')}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-app-border py-1">
        <MenuAction onClick={() => { onClose(); onOpenDevices(); }} testId="devices-open-manage">
          {tr('statusBar.me.devicesManage')}
        </MenuAction>
      </div>
    </SubmenuItem>
  );
}

/** A group's mark: the image when there is one, its initials when there is not.
 *  THE INITIALS ARE THE LOGO, so they have to read: one indigo for both themes
 *  measured 4.46:1 in dark, a fail by four hundredths, so each theme steps away
 *  from the ground it sits on. */
function OrgLogo({ org }: { org: OrgWithPresence }) {
  const cls = 'h-3.5 w-3.5 text-nano';
  return org.logoUrl
    ? <img
        src={org.logoUrl}
        alt=""
        className={`${cls} flex-shrink-0 rounded-full object-cover`}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    : <span className={`${cls} flex flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-bold text-indigo-700 dark:text-indigo-300`}>
        {org.nome.slice(0, 2).toUpperCase()}
      </span>;
}
