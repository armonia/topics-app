import { useCallback, useState } from 'react';
import { type FriendPerson } from '@/lib/api';
import { useFriendship } from '@/hooks/useFriendship';
import { useT } from '@/hooks/useT';
import { openPersonProfile } from '@/state/profileTarget';
import { PersonAvatar } from './PersonAvatar';

/**
 * THE ONE PLACE A REQUEST CAN BE ANSWERED.
 *
 * Without this tab the flow had a hole big enough to make the whole feature
 * useless: a request could be SENT from the other person's profile, but it
 * could only be ANSWERED by navigating to the profile of somebody you might
 * not know is asking. "Somebody asked to be your friend" has to be somewhere
 * you can find without already knowing who it is, and this is that somewhere.
 *
 * THREE GROUPS AND NOT THREE TABS, deliberately. They are three states of one
 * relation, they are all small, and the one that needs an answer is the one on
 * top. Three tabs would have hidden the only actionable group behind a click,
 * which is the same defect in a nicer shape.
 *
 * A ROW STAYS AFTER IT IS ANSWERED. Accepting moves the row from "asked you" to
 * "friends" because the list is refetched, and that move IS the feedback. What
 * it must never do is vanish with no trace: a row that disappears on click
 * leaves you unsure whether you accepted or refused.
 */
export function FriendsTab() {
  const t = useT();
  // The polling, the hidden-window guard and the refresh-after-a-gesture all
  // live in the hook, which was written for this screen and until now had no
  // caller. This component only draws.
  const { friends, incoming, outgoing, pronto, accept, decline, cancel } = useFriendship();
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(async (id: string, what: 'accept' | 'decline' | 'cancel') => {
    setBusy(id);
    try {
      await (what === 'accept' ? accept(id) : what === 'decline' ? decline(id) : cancel(id));
    } catch {
      // The rule refused it (409: the request was withdrawn while this screen
      // held it). The hook reloads on its own tick and the row corrects itself.
    }
    setBusy(null);
  }, [accept, decline, cancel]);

  // Nothing until the first answer is in: an empty state that turns into three
  // lists half a second later reads as a bug in the lists, not as loading.
  if (!pronto) return null;

  const row = (p: FriendPerson, actions: Array<{ what: 'accept' | 'decline' | 'cancel'; label: string; tone: 'primary' | 'quiet'; testId: string }>) => (
    <li key={p.id} className="flex items-center gap-3 rounded-md border border-app-border px-3 py-2">
      <button
        type="button"
        onClick={() => openPersonProfile(p.id)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left coarse:min-h-11"
      >
        <PersonAvatar github={p.github} size={32} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-app-text">{p.displayName}</span>
      </button>
      {actions.map((a) => (
        <button
          key={a.what}
          type="button"
          disabled={busy === p.id}
          onClick={() => void act(p.id, a.what)}
          data-testid={`${a.testId}-${p.id}`}
          className={`flex-shrink-0 rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-60 coarse:min-h-11 ${
            a.tone === 'primary'
              ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
              : 'border-app-border text-app-text hover:bg-app-hover'
          }`}
        >
          {a.label}
        </button>
      ))}
    </li>
  );

  const group = (title: string, people: FriendPerson[], testId: string, actions: Parameters<typeof row>[1]) => (
    people.length > 0 && (
      <section className="space-y-1.5">
        <h3 className="text-[11.5px] uppercase tracking-wide text-app-text-tertiary">{title}</h3>
        <ul data-testid={testId} className="space-y-1">{people.map((p) => row(p, actions))}</ul>
      </section>
    )
  );

  const empty = friends.length === 0 && incoming.length === 0 && outgoing.length === 0;

  return (
    <div data-testid="friends-tab" className="space-y-4">
      {group(t('profile.friend.incoming'), incoming, 'list-friends-incoming', [
        { what: 'accept', label: t('profile.friend.accept'), tone: 'primary', testId: 'friend-accept' },
        { what: 'decline', label: t('profile.friend.decline'), tone: 'quiet', testId: 'friend-decline' },
      ])}
      {group(t('profile.friend.mine'), friends, 'list-friends', [
        { what: 'cancel', label: t('profile.friend.remove'), tone: 'quiet', testId: 'friend-remove' },
      ])}
      {group(t('profile.friend.outgoing'), outgoing, 'list-friends-outgoing', [
        { what: 'cancel', label: t('profile.friend.withdraw'), tone: 'quiet', testId: 'friend-withdraw' },
      ])}
      {empty && (
        <p data-testid="friends-tab-empty" className="text-[12px] text-app-text-muted">
          {t('profile.friend.empty')}
        </p>
      )}
    </div>
  );
}
