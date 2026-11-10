/**
 * The places of the `team` area: testing (c01, c02), who may change the
 * structure (c03), the team (t01), sharing (t02), people and connections
 * (n16) and the log that cannot be edited (n15). See `../kit.ts` for the
 * contract.
 */
import { ClipboardCheck, Network, ScrollText, Share2, ShieldCheck, Users } from 'lucide-react';
import { ROLES } from '../../../ui/fixtures/org/people';
import { CONNECTIONS } from '../../../ui/fixtures/team';
import type { AreaModule, SearchEntry } from '../kit';
import { P } from '../paths';
import { CONNECTIONS_INITIAL, connectionState, type ConnectionsSlice } from './team/connectionState';
import { CONNECTIONS_SCREEN } from './team/connections';
import { FLOW_TEST_SCREEN } from './team/flowTest';
import { REGISTRY_SCREEN } from './team/registry';
import { SHARES_SCREEN } from './team/shares';
import { SQUAD_SCREEN } from './team/squad';
import { STRUCTURE_SCREEN } from './team/structure';
import { TEAM_INITIAL, effectivePeople, roleLabel, type TeamSlice } from './team/teamState';
import { TEST_ALL_SCREEN } from './team/testAll';
import { vaultSlice } from '../store/vault';

export const TEAM_AREA: AreaModule = {
  screens: [FLOW_TEST_SCREEN, TEST_ALL_SCREEN, STRUCTURE_SCREEN, SQUAD_SCREEN, SHARES_SCREEN, CONNECTIONS_SCREEN, REGISTRY_SCREEN],
  search: (ctx) => {
    const t = ctx.copy.team;
    const [team] = ctx.slice<TeamSlice>('team', TEAM_INITIAL);
    const [conns] = ctx.slice<ConnectionsSlice>('connections', CONNECTIONS_INITIAL);
    const people: SearchEntry[] = effectivePeople(team).map((p) => ({
      id: `team-person-${p.id}`,
      group: t.search.groupPeople,
      title: p.name,
      detail: roleLabel(p.role),
      keywords: `${t.search.keywords.person} ${p.role} ${roleLabel(p.role)}`,
      path: P.settings('squadra'),
      icon: Users,
      needs: 'view:settings',
    }));
    const roles: SearchEntry[] = ROLES.map((r) => ({
      id: `team-role-${r.id}`,
      group: t.search.groupPeople,
      title: r.label,
      detail: r.description,
      keywords: `${t.search.keywords.role} ${r.id}`,
      path: P.settings('squadra'),
      icon: ShieldCheck,
      needs: 'view:settings',
    }));
    const connections: SearchEntry[] = CONNECTIONS.map((c) => ({
      id: `team-connection-${c.id}`,
      group: t.search.groupConnections,
      title: c.name,
      detail: `${c.how} · ${t.connections.states[connectionState(c, conns, vaultSlice(ctx)[0])]}`,
      keywords: `${c.what} ${t.search.keywords.connection}`,
      path: P.settings('persone'),
      icon: Network,
      needs: 'view:settings',
    }));
    const settings: SearchEntry[] = [
      { id: 'team-log', group: t.search.groupSettings, title: t.search.log, detail: t.search.logDetail, keywords: t.search.keywords.log, path: P.settings('registro'), icon: ScrollText, needs: 'view:settings' },
      { id: 'team-structure', group: t.search.groupSettings, title: t.search.structure, detail: t.search.structureDetail, keywords: t.search.keywords.structure, path: P.settings('struttura'), icon: ShieldCheck, needs: 'view:settings' },
      { id: 'team-shares', group: t.search.groupSettings, title: t.search.shares, detail: t.search.sharesDetail, keywords: t.search.keywords.shares, path: P.settings('condivisioni'), icon: Share2, needs: 'view:settings' },
      { id: 'team-test-all', group: t.search.groupSettings, title: t.search.testAll, detail: t.search.testAllDetail, keywords: t.search.keywords.testAll, path: P.testAll(), icon: ClipboardCheck, needs: 'view:flows' },
    ];
    return [...people, ...roles, ...connections, ...settings];
  },
};

