import { useEffect, useState } from 'react';
import { Globe2, ShieldCheck, UserPlus } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { peopleApi, type PersonSummary } from '@/lib/api';
import { ProfileHeader, ProfileTopicsStats } from './ProfileHeader';
import { ProfileDropdown } from './ProfileDropdown';
import { PeopleList } from './PeopleList';
import { FriendsTab } from './FriendsTab';
import { PrivacySection } from './PrivacySection';
import { ProfileStatsSection } from '../Settings/ProfileStatsSection';
import { DiscordSection } from '../Settings/DiscordSection';
import { useSelf } from './useSelf';

/**
 * YOUR OWN PROFILE, the same page a stranger gets.
 *
 * -- WHAT LEFT, AND WHY ------------------------------------------------------
 * This pane used to open on a strip of three tabs and the first of them stacked
 * the shareable banner, the public link, Discord and the account under your
 * face. None of that answers "who is this person": it is configuration, it is
 * about the INSTALLATION, and it made the profile unreadable as a profile. It
 * did not get deleted, it went where configuration lives (Settings), and what
 * stays here is what a public page shows: the face, the name, the login, the
 * bio, where they are, who follows them, and the Topics figures.
 *
 * -- ONE COUNTER, ONE LIST, NO SECOND BAR ------------------------------------
 * A counter already names what it opens, so the dropdown shows THAT list and
 * nothing else.
 *
 * -- AND THE TWO THINGS THAT USED TO LIVE ONLY IN SETTINGS ------------------
 * The Settings panel stopped carrying who you are (USERMENU-05), and two pieces
 * existed only there, so they moved here before the pages left:
 *  · «People», the directory of whoever you could follow, a door next to the
 *    two counters it sits beside;
 *  · «Outside Topics», next to Privacy: the figures, the banner, the public
 *    page (publish, open, copy, revoke, and the cost as its sub-option) and
 *    the Discord presence. They answer one question, what somebody who is not
 *    here sees of you. Not inside Privacy: Privacy is a menu of switches, and
 *    the public page has a URL, two buttons and an error to show beside them.
 *
 * -- THE STATE LIVES ABOVE, IN THE PANE --------------------------------------
 * Which dropdown is open is a prop, not local state: the pane also receives it
 * from a deep link ("manage friends" in the sidebar), and a component that
 * owned it would have to sync a prop into state inside an effect, which is the
 * cascade this codebase already banned.
 */

/** The panels the profile can open on itself. `null` is the page alone. */
export type ProfilePanel = 'followers' | 'following' | 'friends' | 'privacy' | 'people' | 'outside' | null;

export function SelfProfile({ open, onOpen }: {
  open: ProfilePanel;
  onOpen: (panel: ProfilePanel) => void;
}) {
  const t = useT();
  const { me, directory, ready, update } = useSelf();
  // The list carries the panel it belongs to: between one panel and the next
  // the answer of the previous request must not be drawn under the new title.
  const [listed, setListed] = useState<{ panel: ProfilePanel; people: PersonSummary[] } | null>(null);

  const meId = me?.id ?? null;
  const wanted = open === 'followers' || open === 'following' ? open : null;

  useEffect(() => {
    if (!meId || !wanted) return;
    let canceled = false;
    const request = wanted === 'followers' ? peopleApi.followers(meId) : peopleApi.following(meId);
    request.then(
      ({ people }) => { if (!canceled) setListed({ panel: wanted, people }); },
      () => { if (!canceled) setListed({ panel: wanted, people: [] }); },
    );
    return () => { canceled = true; };
  }, [meId, wanted]);

  if (!ready) return null;
  if (!me) {
    return (
      <p data-testid="self-profile-missing" className="text-prose text-app-text-muted">
        {t('profile.notFound')}
      </p>
    );
  }

  // A second click on the same trigger closes it: the counter is a toggle, like
  // every menu button in the app, and not a one way door.
  const toggle = (panel: ProfilePanel) => () => onOpen(open === panel ? null : panel);
  const people = listed?.panel === wanted ? listed.people : null;

  // The directory minus you: a follow button pointing at yourself can only fail.
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

  const title = open === 'privacy' ? t('settings.page.privacy.title')
    : open === 'outside' ? t('profile.outside.title')
    : open === 'people' ? t('profile.people')
    : open === 'friends' ? t('profile.friend.mine')
    : open === 'following' ? t('profile.following')
    : t('profile.followers');

  return (
    <div data-testid="self-profile" className="space-y-5">
      <ProfileHeader
        persona={me}
        onChanged={update}
        onOpenFollowers={toggle('followers')}
        onOpenFollowing={toggle('following')}
        afterCounters={
          <>
            <span className="text-app-text-tertiary">·</span>
            <button
              type="button"
              onClick={toggle('people')}
              aria-expanded={open === 'people'}
              data-testid="profile-people-open"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-prose text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:min-h-11"
            >
              <UserPlus size={13} />
              {t('profile.people')}
            </button>
          </>
        }
        actions={
          <>
          <button
            type="button"
            onClick={toggle('privacy')}
            aria-expanded={open === 'privacy'}
            data-testid="profile-privacy-open"
            className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-compact coarse:min-h-11 ${
              open === 'privacy'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-app-border text-app-text-secondary hover:bg-app-hover hover:text-app-text'
            }`}
          >
            <ShieldCheck size={13} />
            {t('settings.section.privacy')}
          </button>
          <button
            type="button"
            onClick={toggle('outside')}
            aria-expanded={open === 'outside'}
            data-testid="profile-outside-open"
            className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-compact coarse:min-h-11 ${
              open === 'outside'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-app-border text-app-text-secondary hover:bg-app-hover hover:text-app-text'
            }`}
          >
            <Globe2 size={13} />
            {t('profile.outside.title')}
          </button>
          </>
        }
        panel={open === null ? null : (
          <ProfileDropdown
            title={title}
            onClose={() => onOpen(null)}
            testId={`profile-${open}-panel`}
          >
            {open === 'privacy' && <PrivacySection />}
            {open === 'outside' && (
              <div className="space-y-4">
                <ProfileStatsSection />
                <DiscordSection />
              </div>
            )}
            {open === 'people' && (
              <PeopleList people={others} emptyText={t('profile.people.empty')} testId="list-people" />
            )}
            {/* Friendship is asked and answered, so it is the one panel with
                more than a list inside: it is opened by the sidebar link that
                reads "manage friends", never by a counter. */}
            {open === 'friends' && <FriendsTab />}
            {open === 'followers' && (
              <PeopleList
                people={people ?? []}
                emptyText={t('profile.followers.emptyFollowers')}
                testId="list-followers"
              />
            )}
            {open === 'following' && (
              <PeopleList
                people={people ?? []}
                emptyText={t('profile.followers.emptyFollowing')}
                testId="list-following"
              />
            )}
          </ProfileDropdown>
        )}
      />
      <ProfileTopicsStats persona={me} />
    </div>
  );
}
