/**
 * THE IDENTITY PAGES, in one place.
 *
 * The same pages were drawn in two places, the Settings panel and the standalone
 * "Profile" pane, and the two lists had already drifted: the account and the
 * organisation projects only ever showed up in the panel. Two copies of a screen
 * are two screens that answer the same question differently; here the source is
 * one and the two hosts show it.
 *
 * Each page has a TITLE and a line saying what it is for. That is not
 * decoration: it is what tells a page apart from a box in the middle of a
 * scroll. When you open "Privacy" you have to READ that you are in privacy, not
 * deduce it from a column of switches.
 *
 * THE ORGANISATION IS STILL HERE, and it is no longer part of the identity: it
 * is administration (`SETTINGS_SECTIONS`), it is not who you are
 * (`IDENTITY_SECTIONS`). The data model behind it did not move an inch, because
 * it is what carries grants and project visibility.
 */
import type { ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { ProfileStatsSection } from './ProfileStatsSection';
import { DiscordSection } from './DiscordSection';
import { AccountSection } from './AccountSection';
import { IdentitySection } from './IdentitySection';
import { OrgProjectsSection } from './OrgProjectsSection';
import { FollowersSection } from '../Profile/FollowersSection';
import { PrivacySection } from '../Profile/PrivacySection';
import { ProfileHeader } from '../Profile/ProfileHeader';
import { useIo } from '../Profile/useIo';

function PageHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="border-b border-app-border pb-3">
      <h2 className="text-[15px] font-semibold text-app-text">{title}</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">{blurb}</p>
    </div>
  );
}

function Page({ testid, titleKey, blurbKey, children }: {
  testid: string;
  titleKey: string;
  blurbKey: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="space-y-6" data-testid={testid}>
      <PageHeader title={t(titleKey)} blurb={t(blurbKey)} />
      {children}
    </div>
  );
}

/**
 * WHO YOU ARE. The header comes FIRST and there is no page title above it: a
 * heading reading "Your profile" over a photograph of you is a caption on a
 * mirror. The boxes that follow are the configuration, which is a different
 * question from "who is this", and they were the only answer for too long.
 */
export function ProfilePage() {
  const { io, aggiorna } = useIo();
  return (
    <div className="space-y-6" data-testid="settings-page-profile">
      {io && <ProfileHeader persona={io} onCambiata={aggiorna} />}
      <ProfileStatsSection />
      {/* The status published outside comes right after the figures it
          publishes: it is the same material, seen by whoever is not here. */}
      <DiscordSection />
      <AccountSection />
    </div>
  );
}

/** WHO IS AROUND YOU, and in which direction. */
export function FollowersPage() {
  return (
    <Page
      testid="settings-page-followers"
      titleKey="settings.page.followers.title"
      blurbKey="settings.page.followers.blurb"
    >
      <FollowersSection />
    </Page>
  );
}

/** WHAT YOU PUBLISH, and what the server therefore refuses to send. */
export function PrivacyPage() {
  return (
    <Page
      testid="settings-page-privacy"
      titleKey="settings.page.privacy.title"
      blurbKey="settings.page.privacy.blurb"
    >
      <PrivacySection />
    </Page>
  );
}

/** THE GROUP YOU ADMINISTER: members, roles, and the projects it owns. */
export function OrganizationPage() {
  return (
    <Page
      testid="settings-page-organization"
      titleKey="settings.page.organization.title"
      blurbKey="settings.page.organization.blurb"
    >
      {/* `IdentitySection` handles organisations end to end: the list from
          `/api/auth/orgs`, the picker when there is more than one, members,
          roles, creation and deletion. It was never missing a feature: it was
          missing a door with its destination written on it. */}
      <IdentitySection />
      <OrgProjectsSection />
    </Page>
  );
}
