import { useT } from '@/hooks/useT';
import { ShieldCheck } from 'lucide-react';
import { ProfileHeader, ProfileTopicsStats } from './ProfileHeader';
import { ProfileDropdown } from './ProfileDropdown';
import { FollowersSection, type PeopleTab } from './FollowersSection';
import { PrivacySection } from './PrivacySection';
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
 * -- FOLLOWERS AND PRIVACY ARE STILL ONE GESTURE AWAY -------------------------
 * They are dropdowns now, opened from the thing they are about: the counters
 * open the people, the shield opens what this page publishes. A tab named
 * "Privacy" next to your face said the profile was a control panel; a shield
 * next to the follow button says the page has a switch, which is true.
 *
 * -- THE STATE LIVES ABOVE, IN THE PANE --------------------------------------
 * Which dropdown is open is a prop, not local state: the pane also receives it
 * from a deep link ("manage friends" in the sidebar), and a component that
 * owned it would have to sync a prop into state inside an effect, which is the
 * cascade this codebase already banned.
 */

/** The panels the profile can open on itself. `null` is the page alone. */
export type ProfilePanel = PeopleTab | 'privacy' | null;

export function SelfProfile({ open, onOpen }: {
  open: ProfilePanel;
  onOpen: (panel: ProfilePanel) => void;
}) {
  const t = useT();
  const { me, ready, update } = useSelf();

  if (!ready) return null;
  if (!me) {
    return (
      <p data-testid="self-profile-missing" className="text-[13px] text-app-text-muted">
        {t('profile.notFound')}
      </p>
    );
  }

  // A second click on the same trigger closes it: the counter is a toggle, like
  // every menu button in the app, and not a one way door.
  const toggle = (panel: ProfilePanel) => () => onOpen(open === panel ? null : panel);

  return (
    <div data-testid="self-profile" className="space-y-5">
      <ProfileHeader
        persona={me}
        onChanged={update}
        onOpenFollowers={toggle('followers')}
        onOpenFollowing={toggle('following')}
        actions={
          <button
            type="button"
            onClick={toggle('privacy')}
            aria-expanded={open === 'privacy'}
            data-testid="profile-privacy-open"
            className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] coarse:min-h-11 ${
              open === 'privacy'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-app-border text-app-text-secondary hover:bg-app-hover hover:text-app-text'
            }`}
          >
            <ShieldCheck size={13} />
            {t('settings.section.privacy')}
          </button>
        }
        panel={
          open === 'privacy' ? (
            <ProfileDropdown
              title={t('settings.page.privacy.title')}
              onClose={() => onOpen(null)}
              testId="profile-privacy-panel"
            >
              <PrivacySection />
            </ProfileDropdown>
          ) : open ? (
            <ProfileDropdown
              title={t('settings.page.followers.title')}
              onClose={() => onOpen(null)}
              testId="profile-people-panel"
            >
              {/* The window keeps its own switcher (friends, followers,
                  following, people): they are four lists of the SAME subject,
                  and splitting them across four dropdowns would put back on the
                  profile the strip this card took off it. */}
              <FollowersSection initialTab={open} />
            </ProfileDropdown>
          ) : null
        }
      />
      <ProfileTopicsStats persona={me} />
    </div>
  );
}
