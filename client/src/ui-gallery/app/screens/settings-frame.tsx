/**
 * The frame every settings page sits in, shared by the areas that own one
 * (settings, team): the grouped list of sections on the left, the page on the
 * right. Areas call `settingsFrame(ctx, section, page)` from their `render`.
 */
import type { ReactNode } from 'react';
import {
  Building2, Palette, Sparkles, Package, Rocket, Users, ShieldCheck, Network, Share2,
  Lock, Server, EyeOff, BadgeCheck, ScrollText, type LucideIcon,
} from 'lucide-react';
import type { SettingsSection } from '../../../ui/copy/app';
import { SettingsLayout } from '../../../ui/settings/SettingsLayout';
import type { ScreenCtx } from '../kit';
import { P } from '../paths';

const GROUPS: Array<{ key: 'org' | 'people' | 'rules' | 'topics'; sections: Array<[SettingsSection, LucideIcon]> }> = [
  { key: 'org', sections: [['generale', Building2], ['settore', Package], ['avvio', Rocket]] }, // allow-italian: identifier compared by value, not shown
  { key: 'people', sections: [['persone', Network], ['squadra', Users], ['struttura', ShieldCheck], ['condivisioni', Share2]] },
  { key: 'rules', sections: [['sicurezza', Lock], ['dove-gira', Server], ['anonimizzazione', EyeOff], ['conformita', BadgeCheck], ['registro', ScrollText]] },
  { key: 'topics', sections: [['aspetto', Palette], ['prodotto', Sparkles]] },
];

export function settingsFrame(ctx: ScreenCtx, section: SettingsSection, page: { actions?: ReactNode; children: ReactNode }) {
  const a = ctx.copy.app;
  return (
    <SettingsLayout
      crumbs={[{ label: a.settingsRoot }, { label: a.settingsSections[section] }]}
      groups={GROUPS.map((g) => ({
        label: a.settingsGroups[g.key],
        sections: g.sections.map(([id, icon]) => ({ id, icon, label: a.settingsSections[id] })),
      }))}
      activeId={section}
      onSelect={(id) => ctx.go(P.settings(id))}
      actions={page.actions}
      phone={ctx.phone}
    >
      {page.children}
    </SettingsLayout>
  );
}
