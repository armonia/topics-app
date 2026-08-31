import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { peopleApi, type PersonWithProfile, type PersonSummary } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { ProfileHeader, ProfileTopicsStats } from './ProfileHeader';
import { PeopleList } from './PeopleList';
import { ProfileDropdown } from './ProfileDropdown';
import { FriendshipBar } from './FriendshipBar';

/**
 * SOMEBODY ELSE'S PROFILE: the same page as yours, minus what is yours alone.
 *
 * It is deliberately the SAME component pair as your own profile (the header
 * and the Topics figures), because the day the two drift is the day nobody can
 * tell what other people actually see of them. What changes is only what is
 * missing: no privacy switches, no GitHub login editor, and a Follow button
 * where your own page has nothing.
 *
 * "NOT AVAILABLE" IS A REAL ANSWER. A person who switched their profile off
 * gives a 404 here, and the page says so in one line instead of spinning: the
 * request will not succeed later either, and a spinner that never ends is how a
 * deliberate refusal gets reported as a bug.
 */
export function PersonProfile({ personId, onBack }: { personId: string; onBack: () => void }) {
  const t = useT();
  // ONE STATE CARRYING ITS OWN ID, instead of three that get cleared by hand.
  // Resetting them at the top of the effect is a synchronous setState in an
  // effect body, which is the cascade `react-hooks/set-state-in-effect` stops,
  // and it was also a real defect: between the reset and the answer the page
  // showed the PREVIOUS person for one frame. Here the record carries the id it
  // is about, so a record for somebody else is simply not drawn.
  const [loaded, setLoaded] = useState<{ id: string; persona: PersonWithProfile | null }>(
    { id: '', persona: null },
  );
  const [missing, setMissing] = useState<string | null>(null);
  const [tab, setTab] = useState<'followers' | 'following' | null>(null);
  const [listed, setListed] = useState<{ tab: string; people: PersonSummary[] } | null>(null);

  useEffect(() => {
    let canceled = false;
    peopleApi.get(personId).then(
      (p) => { if (!canceled) setLoaded({ id: personId, persona: p }); },
      () => { if (!canceled) setMissing(personId); },
    );
    return () => { canceled = true; };
  }, [personId]);

  useEffect(() => {
    if (!tab) return;
    let canceled = false;
    const request = tab === 'followers' ? peopleApi.followers(personId) : peopleApi.following(personId);
    request.then(
      ({ people }) => { if (!canceled) setListed({ tab, people }); },
      () => { if (!canceled) setListed({ tab, people: [] }); },
    );
    return () => { canceled = true; };
  }, [tab, personId]);

  const openList = useCallback((s: 'followers' | 'following') => () => {
    setTab((cur) => (cur === s ? null : s));
  }, []);

  const persona = loaded.id === personId ? loaded.persona : null;
  const list = listed?.tab === tab ? listed.people : null;

  return (
    <div data-testid="person-profile" className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        data-testid="person-profile-back"
        className="inline-flex items-center gap-1.5 text-[12px] text-app-text-muted hover:text-primary coarse:min-h-11"
      >
        <ArrowLeft size={13} />
        {t('profile.back')}
      </button>

      {missing === personId && (
        <p data-testid="person-profile-missing" className="text-[13px] text-app-text-muted">
          {t('profile.notFound')}
        </p>
      )}

      {persona && (
        <>
          <ProfileHeader
            persona={persona}
            onChanged={(p) => setLoaded({ id: personId, persona: p })}
            onOpenFollowers={persona.counts ? openList('followers') : undefined}
            onOpenFollowing={persona.counts ? openList('following') : undefined}
            panel={tab && list ? (
              <ProfileDropdown
                title={tab === 'followers' ? t('profile.followers') : t('profile.following')}
                onClose={() => setTab(null)}
                testId={`person-panel-${tab}`}
              >
                <PeopleList
                  people={list}
                  emptyText={t('profile.followers.private')}
                  testId={`person-list-${tab}`}
                />
              </ProfileDropdown>
            ) : null}
          />
          {/* Only on somebody else, and only when the server said where we
              stand. `isMe` has no friendship with itself, and an old server
              that does not send the field draws no strip at all rather than
              guessing `none` and offering to befriend a stranger by mistake. */}
          {!persona.isMe && persona.friendship && (
            <FriendshipBar personId={personId} initial={persona.friendship} />
          )}
          <ProfileTopicsStats persona={persona} />
        </>
      )}
    </div>
  );
}
