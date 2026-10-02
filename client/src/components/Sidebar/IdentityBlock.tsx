/**
 * THE FOOT OF THE COLUMN: who is here, and one card that is you.
 *
 * ── WHAT IT WAS, AND WHY IT CHANGED ─────────────────────────────────────────
 * Three chips on one line, always the same three: me, my groups, my people.
 * Each opened a dropdown of its own. It was a good answer to "what am I part
 * of" and a poor one to what a person actually does with that corner of the
 * screen, for two reasons that both come down to the same thing - it spent
 * permanent room on answers that never change, and none on the one that does.
 *
 *   · WHICH GROUPS I BELONG TO changes twice a year. It was holding a third of
 *     the band's width to say "one", every day.
 *   · WHO IS AROUND changes all morning, and it was compressed into a count
 *     and two overlapped faces: a number cannot be greeted and cannot be
 *     clicked, so the only thing to do with it was open a panel and read the
 *     list underneath.
 *
 * So the band is now the other way round: PEOPLE ARE CHIPS, one per person who
 * is here (`friendChips`), on a row that scrolls sideways and DISAPPEARS when
 * nobody is around; and everything that is stable - the account, the groups,
 * the friends you have and the ones waiting for an answer, the commands of the
 * column, the machine's own numbers - lives behind the USER CARD, which is the
 * single door of this chrome (`ProfileMenu`).
 *
 * ── THE CARD SHOWS WHAT THE MACHINE IS SPENDING ─────────────────────────────
 * The card carries your face, your FIRST NAME and the load: megabytes, CPU, and
 * the dot whose colour is the verdict. The surname is dropped on purpose - it
 * is the half that truncates anyway in a 240px column, and it is on the account
 * block one click away. The numbers are the ones that used to sit next to the
 * word «Topics» at the top of the column and, before that, in a strip of
 * eleven-pixel digits down here: they come back to the foot of the column
 * because this is the card you glance at, and «is it fine» is the question that
 * gets asked all day.
 *
 * The work signals (agents running, turns waiting) went the other way, INTO the
 * menu: two families of digits in one 240px row is the pile this redesign was
 * called in to undo, and the sentence that explains them was always in the
 * panel anyway. One number comes back out, as a pill and not as a glyph: how
 * many agents are WORKING right now, a chat waiting on work its last turn left
 * running included, because that is the one figure you want without opening
 * anything, and it is the same list the menu names row by row
 * (`useActiveAgentRows`, `activeAgentCount`), so the pill and the list cannot
 * disagree. The card says that number wherever it says one: the pill, the
 * working digit in the menu's tail and the tooltip's phrase.
 */
import { Suspense, useEffect, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { usePresenceSummary } from '@/hooks/usePresenceSummary';
import { presenceSummary } from '../../../../shared/presence-phrase';
import { openPersonProfile } from '@/state/profileTarget';
import { IDENTITY_GLYPH_BOX, IDENTITY_GLYPH_INK, ROW_INSET } from '@/lib/selectionStyles';
import { chipClass } from './identityChip';
import { PALLINO_OK } from './chromeSignals';
import type { SidebarCommands } from './ProfileMenu';
import { ProfileMenu, prefetchProfileMenu } from './profileMenuLazy';
import { useIdentityMenuData, type IdentityMenuData } from '@/hooks/useIdentityMenuData';
import { OPEN_USER_MENU_EVENT, type OpenUserMenuDetail, type UserMenuRequest } from '@/lib/openUserMenu';
import { TopicsLoadDot } from './TopicsLoadDot';
import { friendChips, firstName } from './friendChips';
import { workSignals } from './workSignals';
import { activeAgentCount, useActiveAgentRows, useAgentActivityCounts } from '@/state/signals';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';
import { useLoad } from '@/state/systemLoad';
import { useLocale, useT } from '@/hooks/useT';
import { formatMemoryMB } from '@/lib/formatMemory';

export function IdentityBlock({ commands, alarm = false }: {
  commands: SidebarCommands;
  /** Something that cannot wait behind a gesture: the websocket is down, or
   *  there is a notice on the data. It rides on the card's dot. */
  alarm?: boolean;
}) {
  const identity = useIdentityMenuData();
  const chips = friendChips(identity.friends.rows);
  return (
    // ONE INSET ON ALL THREE SIDES. This is the last thing in the column, so
    // its bottom gap is read against its own left and right gaps, side by side,
    // and any difference shows. `ROW_INSET` is that one number, and it lives
    // here so nothing can add a second one on top of it.
    <div
      data-testid="identity-block"
      className="flex flex-col gap-1 text-mini"
      style={{ paddingInline: ROW_INSET, paddingBottom: ROW_INSET }}
    >
      <FriendChipsRow chips={chips} />
      <UserCard identity={identity} commands={commands} alarm={alarm} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. WHO IS HERE
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ONE CHIP PER PERSON WHO IS AROUND, and the row scrolls.
 *
 * A horizontal scroll normally hides content with nothing to say so, which is
 * the exact argument that took the organisation chips off a scrolling row a
 * month ago. It is the right shape HERE because the subject is different: the
 * groups were a CLOSED set that had to be countable at a glance (a fourth group
 * you only find by dragging is a group you do not know you are in), while the
 * people around you are an open, changing list whose first faces are the answer
 * and whose tail is "and some others". The same list, complete and named, is
 * one click below in the menu.
 *
 * IT IS NOT THERE WHEN NOBODY IS. The old chips stayed at zero so their place
 * could be learned; this row is not the only way in, so a permanent strip
 * saying "nobody" would be reserving daily space for the emptiest sentence in
 * the app.
 */
function FriendChipsRow({ chips }: { chips: ReturnType<typeof friendChips> }) {
  if (chips.length === 0) return null;
  return (
    <div
      data-testid="friend-chips"
      // `overflow-x-auto` with `scrollbar-hide`: the bar itself would be a
      // permanent grey line under the last row of the column, and the content
      // it would describe is faces that are already cut in half at the edge.
      className="flex flex-nowrap items-center gap-1 overflow-x-auto scrollbar-hide"
    >
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          data-testid="friend-chip"
          onClick={() => openPersonProfile(c.id)}
          className={`${chipClass(true)} flex-none max-w-[120px]`}
          title={c.fullName}
          aria-label={c.fullName}
        >
          <span className={`relative flex ${IDENTITY_GLYPH_BOX} flex-shrink-0 items-center justify-center`}>
            {c.avatarUrl
              ? <img src={c.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
              : <span className="flex h-full w-full items-center justify-center rounded-full bg-primary/20 text-nano font-semibold leading-none text-app-text">
                  {c.initials}
                </span>}
            {/* THE STATE, on the face and not beside it: everybody on this row
                is here, so the dot is not distinguishing one chip from
                another - it is saying what the row MEANS, and it has to be
                readable on a chip that is otherwise just a face and a name. */}
            <span className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-1 ring-app-chrome ${PALLINO_OK}`} />
          </span>
          <span className="truncate text-app-text">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. YOU, AND EVERYTHING BEHIND YOU
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * THE CARD: your face, your name, what the machine is spending.
 *
 * It is the only permanent control of this chrome, so it holds the three things
 * that have to be true without opening anything - you are signed in, as whom,
 * and the machine is fine - and it opens the one menu that holds the rest.
 */
function UserCard({ identity, commands, alarm }: {
  identity: IdentityMenuData;
  commands: SidebarCommands;
  alarm: boolean;
}) {
  const tr = useT();
  const locale = useLocale();
  const { session, who, readDevices } = identity;
  const [open, setOpen] = useState(false);
  // A level asked for from elsewhere (the bell's gear, an old deep link): the
  // menu remounts on every request so the level opens even when it is asked
  // for twice in a row (`lib/openUserMenu`).
  const [request, setRequest] = useState<UserMenuRequest>({ level: null, n: 0 });
  const [card, setCard] = useState<HTMLButtonElement | null>(null);
  const { counts } = usePresenceSummary();
  const roster = useTerminalSessions();
  const topics = useTopics();
  const agentCounts = useAgentActivityCounts(roster, topics);
  // The badge and the working digit in the tail of the menu's system row count
  // the SAME rows the menu lists, through one function: the working ones and
  // the chats waiting on background work (active-agent-row + background-agent-row).
  const agentRows = useActiveAgentRows(roster, topics);
  const activeAgents = activeAgentCount(agentRows);
  // With any background row, n >= b >= 1, so one agent is that one row.
  const agentsTitle = agentRows.background.length === 0
    ? tr('statusBar.signals.working', { n: activeAgents })
    : activeAgents === 1
      ? tr('statusBar.signals.withBackgroundOne')
      : tr('statusBar.signals.withBackgroundMany', { n: activeAgents, b: agentRows.background.length });
  const load = useLoad();

  useEffect(() => {
    const onRequest = (e: Event) => {
      const level = (e as CustomEvent<OpenUserMenuDetail>).detail?.level ?? null;
      readDevices();
      setRequest((r) => ({ level, n: r.n + 1 }));
      setOpen(true);
    };
    window.addEventListener(OPEN_USER_MENU_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_USER_MENU_EVENT, onRequest);
  }, [readDevices]);

  if (session.status !== 'paired') return null;
  const local = session.as === 'loopback';
  const DeviceIcon = local ? Monitor : Smartphone;

  const awaitingDone = agentCounts ? agentCounts.awaiting - agentCounts.awaitingInput : 0;
  // Two counts and no more: what is answering now, and how much is open. The
  // sessions parked on a question and the turns nobody read are the `waiting`
  // lines just below, spelled out in words.
  //
  // THE WORKING DIGIT IS THE BADGE'S NUMBER (BGVIS-03): the tail sums up the
  // level it opens, and a chat waiting on background work is a row of that
  // level. Read from the server's presence it would count by a rule of its own
  // (archived chats, sessions with no chat), and could say 1 beside a list
  // that reads "no agent is working". The open digit stays the installation's
  // count, which no list here names row by row.
  const signals = workSignals({
    openSessions: counts?.openSessions ?? 0,
    workingSessions: activeAgents,
  }).map((s) => (s.kind === 'working' ? { ...s, title: agentsTitle } : s));
  // THE TOOLTIP'S PHRASE SAYS THE SAME NUMBER. The route's `workingSessions`
  // counts open streams and busy terminals, so it leaves a chat waiting on
  // background work out by construction: composed from it, the tooltip read
  // "no agent at work" beside a badge reading 1. The open chats, the board
  // tasks, the project and the sessions outside Topics stay the route's. The
  // Discord presence keeps the route's number whole: it names no list.
  const summary = counts ? presenceSummary({ ...counts, workingSessions: activeAgents }, locale) : null;
  const waiting = [
    agentCounts && agentCounts.awaitingInput > 0
      ? tr('statusBar.agents.awaitingInput', { n: agentCounts.awaitingInput }) : '',
    awaitingDone > 0 ? tr('statusBar.agents.toLookAt', { n: awaitingDone }) : '',
  ].filter(Boolean);

  return (
    <>
      <button
        ref={setCard}
        data-testid="identity-me-profile"
        // READ AGAIN ON EVERY OPEN. A phone going on or offline sends no
        // event, and the devices row counts the connected ones in its tail:
        // a list read once at mount would show a stale count.
        onClick={() => {
          if (!open) {
            readDevices();
            setRequest((r) => ({ level: null, n: r.n }));
          }
          setOpen((v) => !v);
        }}
        onPointerEnter={prefetchProfileMenu}
        onFocus={prefetchProfileMenu}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={who.nome}
        // Always FULL: if this card is drawn at all you are paired.
        className={`${chipClass(true)} w-full min-w-0 text-left`}
        title={[`${who.nome}${who.dettaglio ? ` \u00b7 ${who.dettaglio}` : ''}`, summary ?? '', ...waiting].filter(Boolean).join('\n')}
      >
        {/* THE FACE, and only when there is a person: a disc holding the
            initial of "This computer" would be a fake avatar. */}
        <span data-testid="identity-glyph" className={`flex ${IDENTITY_GLYPH_BOX} flex-shrink-0 items-center justify-center`}>
          {who.personale
            ? (who.avatarUrl
                ? <img src={who.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
                : <span className="flex h-full w-full items-center justify-center rounded-full bg-primary text-nano font-semibold leading-none text-white">{who.iniziali}</span>)
            : <DeviceIcon size={IDENTITY_GLYPH_INK} className="text-app-text-secondary" />}
        </span>
        {/* THE FIRST NAME. The whole name is on the tooltip, on the accessible
            name and in the account block: what the card gives up is the half a
            240px column truncates anyway. */}
        <span data-testid="identity-name" className="truncate text-app-text">
          {who.personale ? firstName(who.nome) : who.nome}
        </span>
        {/* WHAT THE MACHINE IS SPENDING, and the dot that judges it. The dot
            owns the sampling (it is the single publisher of the load) and
            carries the alarm when the transport is down. */}
        <span
          data-testid="metrics-total"
          className="ml-auto flex flex-shrink-0 items-center gap-1 text-app-text-secondary tabular-nums"
        >
          {load?.totalMB != null && <span>{formatMemoryMB(load.totalMB, { partial: load.partial })}</span>}
          {load?.totalCpu != null && <span>{Math.round(load.totalCpu)}%</span>}
        </span>
        {/* AGENTS AT WORK, as a pill. After the load numbers and before the
            dot, so a badge appearing does not shove the name or the digits:
            the row is `ml-auto` up to here and only the dot moves. Rendered
            only above zero, so a closed test can ask for its absence. */}
        {activeAgents > 0 && (
          <span data-testid="identity-agents-badge" className="flex flex-shrink-0 items-center">
            <NotificationBadge
              count={activeAgents}
              title={agentsTitle}
              ariaLabel={agentsTitle}
            />
          </span>
        )}
        <TopicsLoadDot alarm={alarm} />
      </button>

      {/* The boundary only ever shows on a COLD open (no hover, no focus
          before the click): warmed by `prefetchProfileMenu`, the menu renders
          in this same pass. */}
      {open && (
        <Suspense fallback={null}>
          <ProfileMenu
            key={request.n}
            anchorEl={card}
            onClose={() => setOpen(false)}
            identity={identity}
            signals={signals}
            commands={commands}
            openLevel={request.level}
          />
        </Suspense>
      )}
    </>
  );
}

