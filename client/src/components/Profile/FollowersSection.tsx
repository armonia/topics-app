import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonSummary } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { PeopleList } from './PeopleList';
import { useSelf } from './useSelf';

/**
 * FOLLOWERS, FOLLOWING, AND WHERE NEW ONES COME FROM.
 *
 * -- WHY THE RELATION IS ONE WAY ---------------------------------------------
 * "Friends" here never meant friendship: it meant "the people in my
 * organisation", a list nobody chose and nobody could change, that appeared
 * whole the day you joined a group and emptied the day you left it. A follow is
 * a decision, it belongs to the person who makes it, and it does not need the
 * other side to agree. That is why there are two lists and not one: they are
 * genuinely different sets, and a symmetric model would have had to pick which
 * of the two to lie about.
 *
 * -- WHY THERE IS A THIRD TAB ------------------------------------------------
 * A follow graph with no way to find anybody stays empty forever. "People" is
 * the discovery pool: whoever this installation can already see, which today is
 * the people you share an organisation with. The organisation is not NAMED
 * anywhere here, because on a profile surface it is not part of the answer: it
 * is only how the name reached the list.
 */

type Tab = 'followers' | 'following' | 'people';

export function FollowersSection({ initialTab = 'followers' }: { initialTab?: Tab }) {
  const t = useT();
  const { me, directory, ready } = useSelf();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [followers, setFollowers] = useState<PersonSummary[] | null>(null);
  const [following, setFollowing] = useState<PersonSummary[] | null>(null);

  const meId = me?.id ?? null;

  useEffect(() => {
    if (!meId) return;
    let canceled = false;
    void Promise.allSettled([peopleApi.followers(meId), peopleApi.following(meId)]).then(([f, s]) => {
      if (canceled) return;
      setFollowers(f.status === 'fulfilled' ? f.value.people : []);
      setFollowing(s.status === 'fulfilled' ? s.value.people : []);
    });
    return () => { canceled = true; };
  }, [meId]);

  const chooseTab = useCallback((s: Tab) => () => setTab(s), []);

  if (!ready) return null;

  // The directory minus me: a row with a follow button pointing at yourself is
  // a button that can only fail.
  const others: PersonSummary[] = directory
    .filter((p) => !p.isMe)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      githubLogin: p.githubLogin,
      github: p.github,
      viewerFollows: p.viewerFollows,
      isMe: false,
    }));

  const tabs: Array<[Tab, string, number | null]> = [
    ['followers', t('profile.followers'), followers?.length ?? null],
    ['following', t('profile.following'), following?.length ?? null],
    ['people', t('profile.people'), others.length],
  ];

  return (
    <div data-testid="followers-section" className="space-y-3">
      <div className="flex items-center gap-1" role="tablist" aria-label={t('settings.page.followers.title')}>
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={chooseTab(id)}
            data-testid={`followers-tab-${id}`}
            className={`rounded-md px-3 py-1.5 text-[12.5px] coarse:min-h-11 ${
              tab === id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
            }`}
          >
            {label}
            {n !== null && <span className="ml-1.5 tabular-nums text-app-text-tertiary">{n}</span>}
          </button>
        ))}
      </div>

      {tab === 'followers' && (
        <PeopleList
          people={followers ?? []}
          emptyText={t('profile.followers.emptyFollowers')}
          testId="list-followers"
        />
      )}
      {tab === 'following' && (
        <PeopleList
          people={following ?? []}
          emptyText={t('profile.followers.emptyFollowing')}
          testId="list-following"
        />
      )}
      {tab === 'people' && (
        <PeopleList people={others} emptyText={t('profile.followers.emptyFollowing')} testId="list-people" />
      )}
    </div>
  );
}
