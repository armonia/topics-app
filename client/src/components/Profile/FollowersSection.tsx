import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonaSommaria } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { PeopleList } from './PeopleList';
import { useIo } from './useIo';

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

type Scheda = 'followers' | 'following' | 'people';

export function FollowersSection({ schedaIniziale = 'followers' }: { schedaIniziale?: Scheda }) {
  const t = useT();
  const { io, rubrica, pronto } = useIo();
  const [scheda, setScheda] = useState<Scheda>(schedaIniziale);
  const [follower, setFollower] = useState<PersonaSommaria[] | null>(null);
  const [seguiti, setSeguiti] = useState<PersonaSommaria[] | null>(null);

  const ioId = io?.id ?? null;

  useEffect(() => {
    if (!ioId) return;
    let annullato = false;
    void Promise.allSettled([peopleApi.followers(ioId), peopleApi.following(ioId)]).then(([f, s]) => {
      if (annullato) return;
      setFollower(f.status === 'fulfilled' ? f.value.people : []);
      setSeguiti(s.status === 'fulfilled' ? s.value.people : []);
    });
    return () => { annullato = true; };
  }, [ioId]);

  const scegli = useCallback((s: Scheda) => () => setScheda(s), []);

  if (!pronto) return null;

  // The directory minus me: a row with a follow button pointing at yourself is
  // a button that can only fail.
  const altri: PersonaSommaria[] = rubrica
    .filter((p) => !p.isMe)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      githubLogin: p.githubLogin,
      github: p.github,
      viewerFollows: p.viewerFollows,
      isMe: false,
    }));

  const schede: Array<[Scheda, string, number | null]> = [
    ['followers', t('profile.followers'), follower?.length ?? null],
    ['following', t('profile.following'), seguiti?.length ?? null],
    ['people', t('profile.people'), altri.length],
  ];

  return (
    <div data-testid="followers-section" className="space-y-3">
      <div className="flex items-center gap-1" role="tablist" aria-label={t('settings.page.followers.title')}>
        {schede.map(([id, etichetta, n]) => (
          <button
            key={id}
            role="tab"
            aria-selected={scheda === id}
            onClick={scegli(id)}
            data-testid={`followers-tab-${id}`}
            className={`rounded-md px-3 py-1.5 text-[12.5px] coarse:min-h-11 ${
              scheda === id
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
            }`}
          >
            {etichetta}
            {n !== null && <span className="ml-1.5 tabular-nums text-app-text-tertiary">{n}</span>}
          </button>
        ))}
      </div>

      {scheda === 'followers' && (
        <PeopleList
          persone={follower ?? []}
          vuoto={t('profile.followers.emptyFollowers')}
          testId="list-followers"
        />
      )}
      {scheda === 'following' && (
        <PeopleList
          persone={seguiti ?? []}
          vuoto={t('profile.followers.emptyFollowing')}
          testId="list-following"
        />
      )}
      {scheda === 'people' && (
        <PeopleList persone={altri} vuoto={t('profile.followers.emptyFollowing')} testId="list-people" />
      )}
    </div>
  );
}
