/**
 * The frame of the team pages: the header with the way to the place
 * (`Squadra / Tecnica`), the strip «Team · Permessi» (each a place with its own
 * address) and the page under it.
 */
import type { ReactNode } from 'react';
import { ShieldCheck, Users } from 'lucide-react';
import clsx from 'clsx';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { PAGE_GUTTER, SECTION_STRIP } from '../../../../ui/shell/layout';
import { SubNav } from '../../../../ui/shell/SubNav';
import type { CrumbModel } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { SP } from '../../paths';

export type TeamPlace = 'team' | 'permissions';

export function TeamFrame({ ctx, place, crumbs, wide, actions, children }: {
  ctx: ScreenCtx;
  place: TeamPlace;
  crumbs: CrumbModel[];
  /** The permissions matrix is wider than the lists. */
  wide?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const c = ctx.copy.sarimTeam;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={crumbs}>{actions}</PaneHeader>
      <div className={SECTION_STRIP}>
        <SubNav
          label={c.navLabel}
          items={[
            { id: 'team', label: c.nav.team, icon: Users, active: place === 'team' },
            { id: 'permissions', label: c.nav.permissions, icon: ShieldCheck, active: place === 'permissions' },
          ]}
          onSelect={(id) => ctx.go(id === 'team' ? SP.team() : SP.teamPermissions())}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={clsx('flex w-full flex-col gap-4 py-5', PAGE_GUTTER, wide ? 'max-w-[1280px]' : 'max-w-[1080px]')}>
          {children}
        </div>
      </div>
    </div>
  );
}
