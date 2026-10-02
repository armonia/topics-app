/**
 * WHO YOU ARE AND WHO IS AROUND: the identity block of the user menu.
 *
 * The account and the plan, the friends and the groups, the devices and the
 * nodes, written once and mounted twice: at the top of the user card's menu on
 * the desktop, and at the top of the title menu on the phone, where the user
 * card does not exist (USERMENU-09). Before, the phone reached sign-in, rename
 * and revoke only through the Settings panel; two hosts of one component cannot
 * drift.
 *
 * THREE GROUPS, hairline between them. What you are and what you pay (the
 * account, the plan right under it), who is around (friends, groups), and the
 * machines (this one's devices, then the nodes the board spans: both are
 * computers, and the devices level already points at the nodes' requests).
 *
 * The data comes from `useIdentityMenuData`, which each host calls once: the
 * desktop card needs it for the card itself, the phone only while its menu is
 * open. This module is the menu's body, loaded with the menu.
 */
import { Suspense, useCallback, useState } from 'react';
import { Building2, Users } from 'lucide-react';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { FaceStack, MenuAction, PresenceList } from './PresenceList';
import { AccountPanel } from './accountPanelLazy';
import { DevicesLevel } from './DevicesLevel';
import { NodesLevel, PlanLevel } from './FormLevels';
import { CHIP_INK_DIM, ORG_MARKS_IN_CHIP } from './identityChip';
import { SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';
import { mergePeople } from './orgPresence';
import type { OrgWithPresence } from '@/hooks/useIdentityPresence';
import type { FriendPresence } from '@/hooks/useFriendPresence';
import type { IdentityMenuData } from '@/hooks/useIdentityMenuData';
import type { UserMenuLevel } from '@/lib/openUserMenu';
import { apriProfilo } from '@/state/profileTarget';
import { useT } from '@/hooks/useT';

export function IdentityMenuItems({ data, width, onClose, openLevel = null }: {
  data: IdentityMenuData;
  /** The host panel's width: the levels' floor and ceiling. */
  width: number;
  onClose: () => void;
  /** A level asked for by `openUserMenu`, open from the first render. */
  openLevel?: UserMenuLevel | null;
}) {
  return (
    <>
      <Suspense fallback={null}>
        <AccountPanel
          who={data.who}
          onOpenProfile={() => { onClose(); apriProfilo('profile'); }}
        />
      </Suspense>
      <PlanLevel defaultOpen={openLevel === 'plan'} />

      <div className="border-t border-app-border" />
      {/* THE LEVELS OF NAMES ARE AS WIDE AS THE MENU, NOT AS THEIR LONGEST
          LINE. A level is a fixed box that grows to its content, so one
          unwrapped sentence pulled it out: with the host's width as the
          ceiling too, a long name truncates and a hint wraps. */}
      <FriendsSection friends={data.friends} width={width} onClose={onClose} />
      <OrgsSection orgs={data.orgs} width={width} onClose={onClose} />

      <div className="border-t border-app-border" />
      <DevicesLevel
        devices={data.devices}
        failed={data.devicesFailed}
        width={width}
        onReadDevices={data.readDevices}
        defaultOpen={openLevel === 'devices'}
      />
      <NodesLevel defaultOpen={openLevel === 'nodes'} />
    </>
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
function FriendsSection({ friends, width, onClose }: {
  friends: FriendPresence;
  /** The host panel's width: the level's floor and its ceiling. */
  width: number;
  onClose: () => void;
}) {
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
      maxWidth={width}
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
function OrgsSection({ orgs, width, onClose }: {
  orgs: OrgWithPresence[];
  /** The host panel's width: the level's floor and its ceiling. */
  width: number;
  onClose: () => void;
}) {
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
      maxWidth={width}
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
