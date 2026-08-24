import { useCallback, useState } from 'react';
import { peopleApi, type PersonaSommaria } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { apriProfiloPersona } from '@/state/profileTarget';
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
export function PeopleList({ persone, vuoto, testId }: {
  persone: PersonaSommaria[];
  /** What to say when there is nobody. Not an empty box: a sentence. */
  vuoto: string;
  testId: string;
}) {
  const t = useT();
  const [stato, setStato] = useState<Record<string, boolean>>({});

  const cambia = useCallback(async (p: PersonaSommaria) => {
    const adesso = stato[p.id] ?? p.viewerFollows;
    setStato((s) => ({ ...s, [p.id]: !adesso }));
    try {
      const r = adesso ? await peopleApi.unfollow(p.id) : await peopleApi.follow(p.id);
      setStato((s) => ({ ...s, [p.id]: r.following }));
    } catch {
      setStato((s) => ({ ...s, [p.id]: adesso }));
    }
  }, [stato]);

  if (persone.length === 0) {
    return <p data-testid={`${testId}-empty`} className="text-[12px] text-app-text-muted">{vuoto}</p>;
  }

  return (
    <ul data-testid={testId} className="space-y-1">
      {persone.map((p) => {
        const segue = stato[p.id] ?? p.viewerFollows;
        return (
          <li key={p.id} className="rounded-md border border-app-border">
            <div
              role="button"
              tabIndex={0}
              onClick={() => apriProfiloPersona(p.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') apriProfiloPersona(p.id); }}
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
                  onClick={(e) => { e.stopPropagation(); void cambia(p); }}
                  aria-pressed={segue}
                  data-testid={`person-follow-${p.id}`}
                  className={`flex-shrink-0 rounded border px-2 py-1 text-[11.5px] coarse:min-h-11 ${
                    segue
                      ? 'border-app-border text-app-text-secondary hover:bg-app-hover'
                      : 'border-primary text-primary hover:bg-primary/10'
                  }`}
                >
                  {segue ? t('profile.unfollow') : t('profile.follow')}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
