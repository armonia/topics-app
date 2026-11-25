/**
 * ORBIT edition, area «Squadra»: the teams of ORBIT with their leader and the
 * six agents of Topics, the page of one team, the permission matrix by team
 * (an admin changes it, and the container applies it at once), and the page of
 * one person or one agent. The words are in `ctx.copy.orbitTeam` (teams and
 * permissions) and `ctx.copy.orbitAdmin.team` (a person's and an agent's page).
 */
import { agentById, personaById, teamById, world } from '../world';
import type { AreaModule, ScreenCtx, ScreenDef } from '../../app/kit';
import { SP } from '../paths';
import { PermissionsPage } from './team/PermissionsPage';
import { PersonPage } from './team/PersonPage';
import { TeamDetail } from './team/TeamDetail';
import { TeamPage } from './team/TeamPage';

const base = { org: world().key, nav: 'org', needs: 'view:team', tabKey: () => 'orbit-team' } as const;

/** The tab of the section: its name, whichever of its pages is on show (the page says the rest in its crumbs). A person keeps their own name. */
const sectionTab = (_p: unknown, ctx: ScreenCtx) => ({ label: ctx.copy.orbitTeam.title });

const teamName = (id: string, agents: string) => (id === world().people.agentsTeam.id ? agents : teamById(id)?.label ?? id);

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'orbit-team',
    tab: sectionTab,
    path: '/squadra',
    samples: [SP.team()],
    title: (_p, ctx) => ctx.copy.orbitTeam.title,
    render: (_p, ctx) => <TeamPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-permissions',
    tab: sectionTab,
    path: '/squadra/permessi', // allow-italian: address segment, not shown
    samples: [SP.teamPermissions()],
    title: (_p, ctx) => `${ctx.copy.orbitTeam.title} · ${ctx.copy.orbitTeam.permissions.crumb}`,
    render: (_p, ctx) => <PermissionsPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-team-of',
    tab: sectionTab,
    path: '/squadra/team/:team', // allow-italian: address segment, not shown
    samples: [SP.teamOf('legale'), SP.teamOf(world().people.agentsTeam.id)],
    title: (p, ctx) => `${ctx.copy.orbitTeam.title} · ${teamName(p.team, ctx.copy.orbitTeam.agentsTeam)}`,
    render: (p, ctx) => <TeamDetail ctx={ctx} id={p.team} />,
  },
  {
    ...base,
    id: 'orbit-person',
    path: '/squadra/:id',
    samples: world().samples.persons.map((id) => SP.person(id)),
    tab: (p) => ({ label: personaById(p.id)?.short ?? agentById(p.id)?.name }),
    title: (p, ctx) => personaById(p.id)?.name ?? agentById(p.id)?.name ?? ctx.copy.orbitTeam.title,
    render: (p, ctx) => <PersonPage ctx={ctx} id={p.id} />,
  },
];

export const ORBIT_TEAM_AREA: AreaModule = {
  screens: SCREENS,
};
