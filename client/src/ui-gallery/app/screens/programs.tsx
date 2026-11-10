/**
 * The places of the `programs` area: the programs of the organization by
 * area, the agent on a PC live, remote control with consent, smart search of
 * where documents live, competitors and migration, and where the agents run.
 * See `../kit.ts` for the contract. The wiring of each place is in
 * `./programs/`; the words are in `ctx.copy.programs`.
 */
import { Eye, Monitor, Plug, Repeat2, Search, Server, type LucideIcon } from 'lucide-react';
import { DOCUMENT_LOCATIONS, PROGRAMS, PROGRAM_AREAS, programSeed } from '../../../ui/fixtures/programs';
import type { AreaModule, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { ProgramsListScreen } from './programs/ListScreen';
import { PcAgentPage } from './programs/AgentPage';
import { RemotePage } from './programs/RemotePage';
import { ProgramSearchPage } from './programs/SearchPage';
import { MigrationPage } from './programs/MigrationPage';
import { AgentsPage } from './programs/AgentsPage';

const base = { org: 'nocera', nav: 'programs', needs: 'view:programs' } as const;

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'w06',
    path: '/programmi',
    samples: [P.programs()],
    title: (_p, ctx) => ctx.copy.programs.list.title,
    render: (_p, ctx) => <ProgramsListScreen ctx={ctx} />,
  },
  {
    ...base,
    id: 'w06',
    path: '/programmi/app/:id',
    samples: [P.program('prunes'), P.program('halley'), P.program('teamsystem'), P.program('publisys')],
    title: (p, ctx) => programSeed(p.id)?.name ?? ctx.copy.programs.list.title,
    render: (p, ctx) => <ProgramsListScreen ctx={ctx} selectedId={p.id} />,
  },
  {
    ...base,
    id: 'p02',
    path: '/programmi/agente',
    samples: [P.pcAgent()],
    title: (_p, ctx) => ctx.copy.programs.agent.root,
    render: (_p, ctx) => <PcAgentPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'e02',
    path: '/programmi/agente/controllo',
    samples: [P.remoteControl()],
    title: (_p, ctx) => ctx.copy.programs.remote.root,
    render: (_p, ctx) => <RemotePage ctx={ctx} />,
  },
  {
    ...base,
    id: 'p03',
    path: '/programmi/ricerca',
    samples: [P.programSearch()],
    title: (_p, ctx) => ctx.copy.programs.search.title,
    render: (_p, ctx) => <ProgramSearchPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'p04',
    path: '/programmi/migrazione',
    samples: [P.migration()],
    title: (_p, ctx) => ctx.copy.programs.migration.root,
    render: (_p, ctx) => <MigrationPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'e01',
    path: '/programmi/dove-girano',
    samples: [P.agents()],
    title: (_p, ctx) => ctx.copy.programs.agents.root,
    render: (_p, ctx) => <AgentsPage ctx={ctx} />,
  },
];

/** What search finds here: every program by name and by what it holds, and the places of the area. */
function search(ctx: Parameters<NonNullable<AreaModule['search']>>[0]): SearchEntry[] {
  const c = ctx.copy.programs;
  const group = c.common.searchGroup;
  const programs: SearchEntry[] = PROGRAMS.map((p) => {
    const area = PROGRAM_AREAS.find((a) => a.id === p.area)?.label ?? '';
    const docs = DOCUMENT_LOCATIONS.filter((d) => d.program === p.id).map((d) => `${d.document} ${d.keywords}`).join(' ');
    return {
      id: `program:${p.id}`,
      group,
      title: p.name,
      detail: c.common.searchOwns(area, c.common.connection[p.connection]),
      keywords: `${p.sub ?? ''} ${p.maker ?? ''} ${p.description} ${p.holds.map((h) => h.name).join(' ')} ${docs}`,
      path: P.program(p.id),
      icon: Plug,
      needs: 'view:programs',
    };
  });
  const place = (id: string, title: string, path: string, icon: LucideIcon, keywords: string): SearchEntry => ({
    id: `programs:${id}`, group, title, path, icon, keywords, needs: 'view:programs',
  });
  return [
    ...programs,
    place('agent', c.agent.root, P.pcAgent(), Monitor, c.agent.keywords),
    place('remote', c.remote.root, P.remoteControl(), Eye, c.remote.keywords),
    place('search', c.search.title, P.programSearch(), Search, c.search.keywords),
    place('migration', c.migration.root, P.migration(), Repeat2, c.migration.keywords),
    place('agents', c.agents.root, P.agents(), Server, c.agents.keywords),
  ];
}

export const PROGRAMS_AREA: AreaModule = { screens: SCREENS, search };
