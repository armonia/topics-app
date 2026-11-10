/**
 * The places of the `settings` area: General, Appearance, The product, Sector,
 * Start-up, Security and speed, Where it runs, Anonymization, Compliance. See
 * `../kit.ts` for the contract. Each page lives in `settings/<page>.tsx`; this
 * file declares where they sit and what search can find.
 */
import { BadgeCheck, Building2, EyeOff, Lock, Package, Palette, Rocket, Server, Sparkles, type LucideIcon } from 'lucide-react';
import type { AreaModule, ScreenCtx, ScreenDef } from '../kit';
import type { SettingsSection } from '../../../ui/copy/app';
import { P } from '../paths';
import { GeneralPage } from './settings/general';
import { AppearancePage } from './settings/appearance';
import { ProductPage } from './settings/product';
import { SectorPage } from './settings/sector';
import { StartupPage } from './settings/startup';
import { SecurityPage } from './settings/security';
import { HostingPage } from './settings/hosting';
import { AnonymizationPage } from './settings/anonymization';
import { CompliancePage } from './settings/compliance';

type Mine = 'generale' | 'aspetto' | 'prodotto' | 'settore' | 'avvio' | 'sicurezza' | 'dove-gira' | 'anonimizzazione' | 'conformita';

interface Page {
  /** The mockup id this place draws. */
  id: string;
  section: Mine;
  icon: LucideIcon;
  render: (ctx: ScreenCtx) => React.ReactNode;
}

const PAGES: Page[] = [
  { id: 'set-general', section: 'generale', icon: Building2, render: (ctx) => <GeneralPage ctx={ctx} /> },
  { id: 'd02', section: 'aspetto', icon: Palette, render: (ctx) => <AppearancePage ctx={ctx} /> },
  { id: 'g01', section: 'prodotto', icon: Sparkles, render: (ctx) => <ProductPage ctx={ctx} /> },
  { id: 'k01', section: 'settore', icon: Package, render: (ctx) => <SectorPage ctx={ctx} /> },
  { id: 'o01', section: 'avvio', icon: Rocket, render: (ctx) => <StartupPage ctx={ctx} /> },
  { id: 'g04', section: 'sicurezza', icon: Lock, render: (ctx) => <SecurityPage ctx={ctx} /> },
  { id: 's06', section: 'dove-gira', icon: Server, render: (ctx) => <HostingPage ctx={ctx} /> },
  { id: 'g02', section: 'anonimizzazione', icon: EyeOff, render: (ctx) => <AnonymizationPage ctx={ctx} /> },
  { id: 'q03', section: 'conformita', icon: BadgeCheck, render: (ctx) => <CompliancePage ctx={ctx} /> },
];

const sectionTitle = (ctx: ScreenCtx, section: SettingsSection) => ctx.copy.app.settingsSections[section];

const screens: ScreenDef[] = PAGES.map((page) => ({
  id: page.id,
  path: P.settings(page.section),
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings(page.section)],
  title: (_p, ctx) => sectionTitle(ctx, page.section),
  render: (_p, ctx) => page.render(ctx),
}));

export const SETTINGS_AREA: AreaModule = {
  screens,
  search: (ctx) =>
    PAGES.map((page) => {
      const words = ctx.copy.settings.search[page.section];
      return {
        id: `settings-${page.section}`,
        group: ctx.copy.app.settingsRoot,
        title: words.title,
        detail: words.detail,
        keywords: words.keywords,
        path: P.settings(page.section),
        icon: page.icon,
        needs: 'view:settings' as const,
      };
    }),
};
