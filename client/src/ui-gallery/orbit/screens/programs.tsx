/**
 * ORBIT edition, area «Programmi»: the programs of the questionnaire (SAP, (allow-italian: quotes the Italian interface)
 * Enviro, WinWaste, Zucchetti, Excel, Word, mail and PEC, the tender portals)
 * and RENTRI, with what Topics reads and writes in each, the flows that use
 * them and the controls to test, connect and disconnect them. The words are in
 * `ctx.copy.orbitAdmin.programs`, the programs in `fixtures/orbit-org/programs.ts`.
 */
import { programById, world } from '../world';
import type { AreaModule, ScreenDef } from '../../app/kit';
import { SP } from '../paths';
import { ProgramsListPage } from './programs/ListPage';
import { ProgramPage } from './programs/ProgramPage';

const base = { org: world().key, nav: 'programs', needs: 'view:programs', tabKey: () => 'orbit-programs' } as const;

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'orbit-programs',
    path: '/programmi',
    samples: [SP.programs()],
    title: (_p, ctx) => ctx.copy.orbitAdmin.programs.title,
    render: (_p, ctx) => <ProgramsListPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-program',
    path: '/programmi/:id',
    samples: world().samples.programs.map((id) => SP.program(id)),
    tab: (p) => ({ label: programById(p.id)?.name }),
    title: (p, ctx) => programById(p.id)?.name ?? ctx.copy.orbitAdmin.programs.title,
    render: (p, ctx) => <ProgramPage ctx={ctx} id={p.id} />,
  },
];

export const ORBIT_PROGRAMS_AREA: AreaModule = {
  screens: SCREENS,
};
