import { useCallback, useState } from 'react';
import { peopleApi, type PersonSummary } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { openPersonProfile } from '@/state/profileTarget';
import { PersonAvatar } from './PersonAvatar';

/**
 * A LIST OF PEOPLE WHERE EVERY ROW IS A DOOR.
 *
 * The old list opened an accordion in place: the face, the login and two
 * numbers unfolded under the row you tapped. It made the profile a detail of
 * the list, which is backwards. Here a row goes TO the profile, the same
 * profile you would reach from a presence popover or from a mention, so there
 * is one page about a person and not one per place they are mentioned.
 *
 * The follow button lives on the row and stops the click from reaching the row
 * itself: following somebody from a list must not also navigate away from the
 * list you are following them in.
 */
export function PeopleList({ people, emptyText, testId }: {
  people: PersonSummary[];
  /** What to say when there is nobody. Not an empty box: a sentence. */
  emptyText: string;
  testId: string;
}) {
  const t = useT();
  const [follows, setFollows] = useState<Record<string, boolean>>({});

  const toggleFollow = useCallback(async (p: PersonSummary) => {
    const current = follows[p.id] ?? p.viewerFollows;
    setFollows((s) => ({ ...s, [p.id]: !current }));
    try {
      const r = current ? await peopleApi.unfollow(p.id) : await peopleApi.follow(p.id);
      setFollows((s) => ({ ...s, [p.id]: r.following }));
    } catch {
      setFollows((s) => ({ ...s, [p.id]: current }));
    }
  }, [follows]);

  if (people.length === 0) {
    return <p data-testid={`${testId}-empty`} className="text-[12px] text-app-text-muted">{emptyText}</p>;
  }

  return (
    <ul data-testid={testId} className="space-y-1">
      {people.map((p) => {
        const isFollowing = follows[p.id] ?? p.viewerFollows;
        return (
          <li key={p.id} className="rounded-md border border-app-border">
            <div
              role="button"
              tabIndex={0}
              onClick={() => openPersonProfile(p.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openPersonProfile(p.id); }}
              data-testid={`person-row-${p.id}`}
              className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-app-hover coarse:min-h-11"
            >
              <PersonAvatar github={p.github} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-app-text">
                  {p.github?.name || p.displayName}
                </span>
                <span className="block truncate text-[11px] text-app-text-muted">
                  {p.githubLogin ? `@${p.githubLogin}` : t('profile.noGithub')}
                </span>
              </span>
              {!p.isMe && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void toggleFollow(p); }}
                  aria-pressed={isFollowing}
                  data-testid={`person-follow-${p.id}`}
                  className={`flex-shrink-0 rounded border px-2 py-1 text-[11.5px] coarse:min-h-11 ${
                    isFollowing
                      ? 'border-app-border text-app-text-secondary hover:bg-app-hover'
                      : 'border-primary text-primary hover:bg-primary/10'
                  }`}
                >
                  {isFollowing ? t('profile.unfollow') : t('profile.follow')}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
