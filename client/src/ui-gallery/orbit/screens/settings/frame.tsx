/**
 * The frame of the ORBIT settings pages and of the person's preferences: the
 * header with the crumbs (`ORBIT / Impostazioni / Agenti`, allow-italian: quotes the Italian interface; `Preferenze /
 * Aspetto`), the strip of sections under it (the same `SubNav` as every area
 * with sub-sections) and the page below. Each section is one address
 * (`/impostazioni/<section>` or `/preferenze/<section>`, see `sections.ts`). (allow-italian: quotes an address segment)
 */
import type { ReactNode } from 'react';
import type { OrbitSettingsSection } from '../../../../ui/copy/orbit-admin';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { PAGE_GUTTER, SECTION_STRIP } from '../../../../ui/shell/layout';
import { SubNav } from '../../../../ui/shell/SubNav';
import type { ScreenCtx } from '../../../app/kit';
import { orgCrumbs, personCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { ORG_SECTIONS, PERSON_SECTIONS, SECTION_ICON, SECTION_PATH, isPersonSection } from './sections';

export function SettingsFrame({ ctx, section, actions, children }: { ctx: ScreenCtx; section: OrbitSettingsSection; actions?: ReactNode; children: ReactNode }) {
  const s = ctx.copy.orbitAdmin.settings;
  const person = isPersonSection(section);
  const siblings = person ? PERSON_SECTIONS : ORG_SECTIONS;
  const crumbs = person
    ? personCrumbs(ctx, [{ label: s.prefsRoot, to: SP.prefs() }, { label: s.sections[section] }])
    : orgCrumbs(ctx, [{ label: s.root, to: SP.settings() }, { label: s.sections[section] }]);
  return (
    <div data-section={section} className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={crumbs}>{actions}</PaneHeader>
      <div className={SECTION_STRIP}>
        <SubNav
          label={person ? s.prefsRoot : s.root}
          items={siblings.map((id) => ({ id, label: s.sections[id], icon: SECTION_ICON[id], active: id === section }))}
          onSelect={(id) => ctx.go(SECTION_PATH[id as OrbitSettingsSection])}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`w-full max-w-[880px] py-5 ${PAGE_GUTTER}`}>{children}</div>
      </div>
    </div>
  );
}
