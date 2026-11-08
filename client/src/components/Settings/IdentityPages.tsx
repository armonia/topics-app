/**
 * THE ORGANISATION PAGE, with its title.
 *
 * It used to be one of three identity pages drawn in two hosts (the Settings
 * panel and the Profile tab). The Profile tab is now the one host of who you
 * are (USERMENU-05): the profile and the followers are its own header and
 * panels, and this page is what the tab shows for the group you administer.
 *
 * The page has a TITLE and a line saying what it is for: that is what tells a
 * page apart from a box in the middle of a scroll.
 */
import { useState, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { IdentitySection } from './IdentitySection';
import { OrgProjectsSection } from './OrgProjectsSection';

function PageHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="border-b border-app-border pb-3">
      <h2 className="text-title font-semibold text-app-text">{title}</h2>
      <p className="mt-1 text-compact leading-relaxed text-app-text-secondary">{blurb}</p>
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
 * THE GROUP YOU ADMINISTER: members, roles, and the projects it owns.
 *
 * `orgId` is state HERE, not inside either child: `IdentitySection` is the
 * only place that knows which group is selected (the picker, above two
 * groups), and `OrgProjectsSection` is the only place that needs to know it
 * to scope its list. Before this, the projects panel had no `orgId` at all
 * and fetched every non-incognito project on the installation regardless of
 * which group's page was open — a personal project and Armonia's showed up
 * on Danceroom's page exactly as they did on Armonia's, because nothing told
 * the panel a second group existed.
 */
export function OrganizationPage() {
  const [orgId, setOrgId] = useState<string | null>(null);
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
      <IdentitySection onOrgChange={setOrgId} />
      <OrgProjectsSection orgId={orgId} />
    </Page>
  );
}
