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
import { Suspense, useCallback, useState } from 'react';
import { Bot, Building2, MessagesSquare, UserRound, Users } from 'lucide-react';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { PresencePopover } from './PresencePopover';
import { FaceStack, MenuAction, PresenceList } from './PresenceList';
import { TopicsMenuItems, type TopicsMenuItemsProps } from './TopicsMenuItems';
import { AccountPanel } from './accountPanelLazy';
import { SidebarSystemMenu } from './SidebarSystemMenu';
import { CHIP_INK_DIM, ORG_MARKS_IN_CHIP } from './identityChip';
import { SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';
import { mergePeople } from './orgPresence';
import type { OrgWithPresence } from '@/hooks/useIdentityPresence';
import type { FriendPresence } from '@/hooks/useFriendPresence';
import type { LabelIdentity } from './identityLabel';
import type { LocalFacts } from './AccountPanel';
import type { SignalKind, WorkSignal } from './workSignals';
import { apriProfilo } from '@/state/profileTarget';
import { openSettings } from '@/lib/openSettings';
import { useT } from '@/hooks/useT';
import { useActiveAgentRows, type ActiveAgentRow } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';

/** A glyph component, taken as a prop: which device you are on was decided by
 *  the card, and deciding it twice is how the two disagree. */
type Glyph = React.ComponentType<{ size?: number; className?: string }>;

/** The commands of the column, as they arrive from `App`: everything the
 *  «Topics» dropdown used to hold, minus the two things this menu decides for
 *  itself (which hand it is drawn for, and how it closes). */
export type SidebarCommands = Omit<TopicsMenuItemsProps, 'isMobile' | 'onClose'> & {
  onOpenChangelog: (version: string) => void;
};

/** The width of this panel. Wider than the people-list default (244) because
 *  it holds an email field and a code field: at 244 an address is typed into a
 *  two-word window. */
const WIDTH = 288;

export function ProfileMenu({
  anchorEl, onClose, who, DeviceIcon, facts, orgs, friends, signals, commands, onOpenDevices,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  who: LabelIdentity;
  DeviceIcon: Glyph;
  facts: LocalFacts;
  orgs: OrgWithPresence[];
  friends: FriendPresence;
  /** What is running right now, already picked and tiered by `workSignals`. */
  signals: WorkSignal[];
  commands: SidebarCommands;
  onOpenDevices?: () => void;
}) {
  const tr = useT();

  return (
    <PresencePopover
      anchorEl={anchorEl}
      onClose={onClose}
      testId="profile-menu"
      width={WIDTH}
      titolo={
        <>
          <UserRound size={12} className="flex-shrink-0 text-app-text-muted" />
          <span className="truncate">{tr('statusBar.account.title')}</span>
        </>
      }
    >
      {/* THE PANEL SCROLLS, THE WINDOW DOES NOT. Everything the chrome knows is
          in here now, and the account block plus the performance panel opened
          is taller than a small laptop screen. The popover flips above the card
          by itself; what it cannot do is shrink, so the cap lives here. */}
      <div className="max-h-[min(70vh,560px)] overflow-y-auto">
        <Suspense fallback={null}>
          <AccountPanel
            who={who}
            DeviceIcon={DeviceIcon}
            facts={facts}
            doors={
              <>
                <MenuAction onClick={() => { onClose(); apriProfilo('profile'); }} testId="identity-me-open-profile">
                  {tr('statusBar.me.openProfile')}
                </MenuAction>
                {onOpenDevices && (
                  <MenuAction onClick={() => { onClose(); onOpenDevices(); }} testId="identity-me-devices">
                    {tr('statusBar.devicesTitle')}
                  </MenuAction>
                )}
              </>
            }
          />
        </Suspense>

        <div className="border-t border-app-border" />
        <FriendsSection friends={friends} onClose={onClose} />
        <OrgsSection orgs={orgs} />

        <div className="border-t border-app-border" />
        <AgentsRow signals={signals} />

        <div className="border-t border-app-border" />
        <TopicsMenuItems
          isMobile={false}
          {...commands}
          onClose={onClose}
        />

        <div className="border-t border-app-border" />
        <SidebarSystemMenu
          onOpenChangelog={(version) => { onClose(); commands.onOpenChangelog(version); }}
        />
      </div>
    </PresencePopover>
  );
}

/**
 * WHAT IS RUNNING, as a row that opens onto WHO.
 *
 * The glyphs (agents working, open sessions) used to sit in the header of this
 * panel, where they were a number with no way to ask "which ones". They are the
 * tail of this row now, and the level beside it names each agent at work and
 * each one parked on a question.
 *
 * TWO OF THEM, never a third: `workSignals` says which, and why the counts that
 * used to compete for the same tail are named in the level instead.
 *
 * TWO SCOPES, AND THEY ARE NOT THE SAME QUESTION. The rows and the badge on
 * the card are what THIS window's signals can see, from one derivation
 * (`useActiveAgentRows`), so a row cannot exist without being counted. The
 * glyphs in the tail are the INSTALLATION's own counts, served by
 * `/api/system/presence` (see `usePresenceSummary`: the server counts once so
 * that this row and the published presence cannot drift). A machine with
 * sessions running behind another window will therefore show a tail digit
 * larger than the badge, and that is the honest reading of both.
 *
 * Read-only rows: there is no shared helper to jump from a row to its session
 * yet, and a row that looks like a button and does nothing is worse than text.
 */
function AgentsRow({ signals }: { signals: WorkSignal[] }) {
  const tr = useT();
  const { working, awaitingInput } = useActiveAgentRows(useTerminalSessions(), useTopics());
  return (
    <SubmenuItem
      icon={Bot}
      label={tr('statusBar.agents.title')}
      testId="profile-menu-agents"
      minWidth={220}
      tail={signals.length > 0 ? (
        <span data-testid="presence-summary" className="flex flex-shrink-0 items-center gap-1.5 tabular-nums">
          {signals.map((s) => <Signal key={s.kind} kind={s.kind} n={s.n} />)}
        </span>
      ) : undefined}
    >
      <div className="max-h-[240px] overflow-y-auto py-1">
        {working.map((r) => <AgentLine key={`${r.kind}:${r.id}`} row={r} testId="active-agent-row" alive />)}
        {awaitingInput.length > 0 && (
          <>
            <div className={`px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide ${SEGNALE_ATTESA}`}>
              {tr('statusBar.agents.awaitingHeading')}
            </div>
            {awaitingInput.map((r) => <AgentLine key={`${r.kind}:${r.id}`} row={r} testId="awaiting-agent-row" />)}
          </>
        )}
        {working.length === 0 && awaitingInput.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-app-text-secondary">{tr('statusBar.agents.none')}</div>
        )}
      </div>
    </SubmenuItem>
  );
}

/** One agent, one line: the glyph says what kind of thing it is, the label
 *  says which. The working glyph pulses, like its digit in the tail. */
function AgentLine({ row, testId, alive = false }: { row: ActiveAgentRow; testId: string; alive?: boolean }) {
  const Icon = row.kind === 'terminal' ? Bot : MessagesSquare;
  return (
    <div data-testid={testId} data-kind={row.kind} className="flex items-center gap-2 px-3 py-1 text-[11px] text-app-text" title={row.label}>
      <Icon size={12} className={`flex-shrink-0 ${alive ? `animate-pulse ${SEGNALE_OK}` : SEGNALE_ATTESA}`} />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
    </div>
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
  const total = friends.friends.length;
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
      tail={
        <span
          data-testid="friends-count"
          data-pending={pending > 0 ? 'true' : 'false'}
          className={`flex-shrink-0 tabular-nums ${pending > 0 ? SEGNALE_ATTESA : online.length > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}
          title={pending > 0 ? tr('statusBar.friends.pending', { n: pending }) : undefined}
        >
          {tr('statusBar.friends.count', { n: online.length, tot: total })}
        </span>
      }
    >
      {pending > 0 && (
        <div data-testid="friends-requests" className="border-b border-app-border py-1">
          <div className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-app-text-muted">
            {tr('profile.friend.incoming')}
          </div>
          {incoming.map((p) => (
            <div key={p.id} className="flex items-center gap-2 px-3 py-1">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
                {p.github?.avatarUrl
                  ? <img src={p.github.avatarUrl} alt="" className="h-full w-full object-cover" />
                  : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[8px] font-semibold leading-none text-app-text">
                      {p.displayName.slice(0, 1).toUpperCase()}
                    </span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-app-text">{p.displayName}</span>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void answer(p.id, true)}
                data-testid={`friend-accept-${p.id}`}
                title={tr('profile.friend.accept')}
                className="flex-shrink-0 rounded border border-primary px-1.5 py-0.5 text-[10.5px] text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {tr('profile.friend.accept')}
              </button>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void answer(p.id, false)}
                data-testid={`friend-decline-${p.id}`}
                title={tr('profile.friend.decline')}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-app-text-tertiary hover:bg-app-hover disabled:opacity-50"
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
function OrgsSection({ orgs }: { orgs: OrgWithPresence[] }) {
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
        <div className="px-3 py-2 text-[11px] text-app-text-secondary">{tr('statusBar.orgs.noneHint')}</div>
      ) : only ? (
        <PresenceList people={only.people} empty={tr('statusBar.orgs.alone')} />
      ) : (
        <div className="max-h-[240px] overflow-y-auto">
          {orgs.map((o) => (
            <div key={o.id} data-testid="org-section">
              <div className="flex items-center gap-2 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-app-text-muted">
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
        <MenuAction onClick={() => openSettings('organization')} testId="org-open-manage">
          {only ? tr('statusBar.orgs.manageOne') : tr('statusBar.orgs.manageAll')}
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
  const cls = 'h-3.5 w-3.5 text-[7px]';
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

/**
 * ONE SIGNAL: a glyph and a number, and the colour of its tier.
 *
 * The glyph is the noun ("sessions", "turns", "tasks") drawn instead of spelled:
 * a word costs six times what the icon costs and says the same thing. The
 * `title` gives the word back to whoever hovers, and to whoever reads with a
 * screen reader.
 */
function Signal({ kind, n }: { kind: SignalKind; n: number }) {
  const tr = useT();
  const { Icon, tint, label, alive } = SIGNALS[kind];
  return (
    <span className={`flex items-center gap-0.5 ${tint}`} title={tr(label, { n })}>
      <Icon size={11} className={alive ? 'animate-pulse' : undefined} />
      <span>{n}</span>
    </span>
  );
}

/** Glyph, tier colour and sentence for each signal. One table, so a new signal
 *  is a line here and not a fourth place to keep in sync. */
const SIGNALS: Record<SignalKind, {
  Icon: typeof Bot;
  tint: string;
  label: string;
  alive?: boolean;
}> = {
  // The only pulsing one: it is the only one where something is happening
  // while you look at it.
  working: { Icon: Bot, tint: SEGNALE_OK, label: 'statusBar.signals.working', alive: true },
  open: { Icon: MessagesSquare, tint: CHIP_INK_DIM, label: 'statusBar.signals.open' },
};
