/**
 * ORBIT edition, areas «Impostazioni» and «Preferenze»: Organization (the real (allow-italian: quotes the Italian interface)
 * facts with their sources), Agents (what they do and never do), the Registro
 * (all of the organization, `/impostazioni/<section>`, allow-italian: quotes the Italian address); Appearance and
 * Notifications (of the person, `/preferenze/<section>`, open to everyone).
 * Every section is one address, in the same frame: the header with its crumbs
 * and the strip of sibling sections. (allow-italian: quotes the Italian address)
 */
import type { ReactNode } from 'react';
import type { OrbitSettingsSection } from '../../../ui/copy/orbit-admin';
import type { AreaModule, ScreenCtx, ScreenDef, SearchEntry } from '../../app/kit';
import { AgentsPage } from './settings/AgentsPage';
import { AppearancePage } from './settings/AppearancePage';
import { LogScreen } from './settings/LogScreen';
import { NotificationsPage } from './settings/NotificationsPage';
import { OrganizationPage } from './settings/OrganizationPage';
import { SECTIONS, SECTION_ICON, SECTION_PATH, isPersonSection } from './settings/sections';
import { world } from '../world';

const PAGES: Record<OrbitSettingsSection, (ctx: ScreenCtx) => ReactNode> = {
  organizzazione: (ctx) => <OrganizationPage ctx={ctx} />,
  agenti: (ctx) => <AgentsPage ctx={ctx} />,
  registro: (ctx) => <LogScreen ctx={ctx} />,
  aspetto: (ctx) => <AppearancePage ctx={ctx} />,
  notifiche: (ctx) => <NotificationsPage ctx={ctx} />,
};

/** The sections of the organization share one tab, the ones of the person another. */
const SCREENS: ScreenDef[] = SECTIONS.map((section) => ({
  id: 'orbit-settings',
  path: SECTION_PATH[section],
  org: world().key,
  nav: 'org',
  needs: isPersonSection(section) ? undefined : 'view:settings',
  tabKey: () => (isPersonSection(section) ? 'orbit-prefs' : 'orbit-settings'),
  samples: [SECTION_PATH[section]],
  title: (_p, ctx) => ctx.copy.orbitAdmin.settings.sections[section],
  render: (_p, ctx) => PAGES[section](ctx),
}));

export const ORBIT_SETTINGS_AREA: AreaModule = {
  screens: SCREENS,
  search: (ctx) => {
    const s = ctx.copy.orbitAdmin.settings;
    return SECTIONS.map((section): SearchEntry => ({
      id: `orbit-settings:${section}`,
      kind: 'impostazioni',
      group: isPersonSection(section) ? s.prefsGroup : ctx.copy.orbitAdmin.common.searchGroups.settings,
      title: s.sections[section],
      detail: s.search[section].detail,
      keywords: s.search[section].keywords,
      path: SECTION_PATH[section],
      icon: SECTION_ICON[section],
      needs: isPersonSection(section) ? undefined : 'view:settings',
    }));
  },
};
