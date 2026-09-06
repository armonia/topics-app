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
 * panel anyway.
 */
import { useCallback, useEffect, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { getSession, subscribeSession, type SessionState } from '@/lib/auth/session';
import { etichettaIdentita } from './identityLabel';
import { useIdentityPresence } from '@/hooks/useIdentityPresence';
import { usePresenceSummary } from '@/hooks/usePresenceSummary';
import { openPersonProfile } from '@/state/profileTarget';
import { IDENTITY_GLYPH_BOX, IDENTITY_GLYPH_INK, ROW_INSET } from '@/lib/selectionStyles';
import { chipClass } from './identityChip';
import { PALLINO_OK } from './chromeSignals';
import { ProfileMenu, type SidebarCommands } from './ProfileMenu';
import { prefetchAccountPanel } from './accountPanelLazy';
import { TopicsLoadDot } from './TopicsLoadDot';
import { friendChips, firstName } from './friendChips';
import { useFriendPresence } from '@/hooks/useFriendPresence';
import { workSignals } from './workSignals';
import { useAgentActivityCounts } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';
import { useLoad } from '@/state/systemLoad';
import { useT } from '@/hooks/useT';

export function IdentityBlock({ onOpenDevices, commands, alarm = false }: {
  onOpenDevices?: () => void;
  commands: SidebarCommands;
  /** Something that cannot wait behind a gesture: the websocket is down, or
   *  there is a notice on the data. It rides on the card's dot. */
  alarm?: boolean;
}) {
  const presence = useIdentityPresence();
  const friends = useFriendPresence();
  const chips = friendChips(friends.rows);
  return (
    // ONE INSET ON ALL THREE SIDES. This is the last thing in the column, so
    // its bottom gap is read against its own left and right gaps, side by side,
    // and any difference shows. `ROW_INSET` is that one number, and it lives
    // here so nothing can add a second one on top of it.
    <div
      data-testid="identity-block"
      className="flex flex-col gap-1 text-[11px]"
      style={{ paddingInline: ROW_INSET, paddingBottom: ROW_INSET }}
    >
      <FriendChipsRow chips={chips} />
      <UserCard
        presence={presence}
        friends={friends}
        commands={commands}
        onOpenDevices={onOpenDevices}
        alarm={alarm}
      />
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
              : <span className="flex h-full w-full items-center justify-center rounded-full bg-primary/20 text-[7px] font-semibold leading-none text-app-text">
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
function UserCard({ presence, friends, commands, onOpenDevices, alarm }: {
  presence: ReturnType<typeof useIdentityPresence>;
  friends: ReturnType<typeof useFriendPresence>;
  commands: SidebarCommands;
  onOpenDevices?: () => void;
  alarm: boolean;
}) {
  const tr = useT();
  // `getSession`, not «loading»: the store may already know (last answer kept
  // on this device), and a first frame without the card is the shift the cache
  // exists to remove.
  const [session, setSession] = useState<SessionState>(getSession);
  const [devices, setDevices] = useState<{ connected: number; total: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<HTMLButtonElement | null>(null);
  const { counts, summary } = usePresenceSummary();
  const agentCounts = useAgentActivityCounts(useTerminalSessions(), useTopics());
  const load = useLoad();
  useEffect(() => subscribeSession(setSession), []);

  const who = etichettaIdentita(presence.io, session);

  const readDevices = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/devices', { credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json() as { devices: Array<{ connected: boolean; revokedAt: number | null }> };
      const live = (b.devices ?? []).filter((d) => d.revokedAt === null);
      setDevices({ connected: live.filter((d) => d.connected).length, total: live.length });
    } catch { /* transient: the card keeps no count rather than lie about one */ }
  }, []);

  useEffect(() => {
    const ask = () => { void readDevices(); };
    // After the first paint: nobody needs the device count in the first frame,
    // and a synchronous state write on mount is what `set-state-in-effect` flags.
    const first = setTimeout(ask, 0);
    window.addEventListener('topics:auth-pair-resolved', ask);
    window.addEventListener('topics:auth-device-revoked', ask);
    return () => {
      clearTimeout(first);
      window.removeEventListener('topics:auth-pair-resolved', ask);
      window.removeEventListener('topics:auth-device-revoked', ask);
    };
  }, [readDevices]);

  if (session.status !== 'paired') return null;
  const local = session.as === 'loopback';
  const DeviceIcon = local ? Monitor : Smartphone;

  const awaitingDone = agentCounts ? agentCounts.awaiting - agentCounts.awaitingInput : 0;
  const signals = workSignals({
    openSessions: counts?.openSessions ?? 0,
    workingSessions: counts?.workingSessions ?? 0,
    activeTasks: counts?.activeTasks ?? 0,
    awaitingInput: agentCounts?.awaitingInput ?? 0,
    awaitingDone: awaitingDone > 0 ? awaitingDone : 0,
  });
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
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={prefetchAccountPanel}
        onFocus={prefetchAccountPanel}
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
                : <span className="flex h-full w-full items-center justify-center rounded-full bg-primary text-[7px] font-semibold leading-none text-white">{who.iniziali}</span>)
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
          {load?.totalMB != null && <span>{load.partial ? '~' : ''}{formatMB(load.totalMB)}</span>}
          {load?.totalCpu != null && <span>{Math.round(load.totalCpu)}%</span>}
        </span>
        <TopicsLoadDot alarm={alarm} />
      </button>

      {open && (
        <ProfileMenu
          anchorEl={card}
          onClose={() => setOpen(false)}
          who={who}
          DeviceIcon={DeviceIcon}
          facts={{
            device: who.dettaglio,
            now: summary ?? null,
            devices,
            waiting,
          }}
          orgs={presence.orgs}
          friends={friends}
          signals={signals}
          commands={commands}
          onOpenDevices={onOpenDevices}
        />
      )}
    </>
  );
}

/** Gigabytes past a thousand: the card has one line, and four digits of memory
 *  next to a name read as a phone number. */
function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}
