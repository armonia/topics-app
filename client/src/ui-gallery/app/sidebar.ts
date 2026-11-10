/**
 * The sidebar of the current person: the organizations they belong to (they
 * add up like projects), inside each one only the surfaces their role may
 * open, with counts computed from the same cases the screens show. Row ids:
 * `<org>/<nav>` for a surface, `chat:<id>`, `pin:<id>`, `board`, an org key.
 */
import type { NavItemModel, OrgModel, SidebarModel } from '../../ui/types';
import type { OrgKey } from '../../ui/fixtures/org/types';
import type { Permission, Persona } from '../../ui/fixtures/org/people';
import { ORGS, ROLES } from '../../ui/fixtures/org/people';
import { FLOWS } from '../../ui/fixtures/org/flows';
import { ORBIT_FLOWS } from '../../ui/fixtures/orbit';
import type { DemoState } from './store/state';
import { queueFor } from './store/cases';
import { TESTS_INITIAL, trialsRunning, type TestsSlice } from './screens/team/testing';
import { VAULT_SLICE, type Vault } from './store/vault';
import { CONNECTIONS_INITIAL, connectionOf, connectionState, type ConnectionsSlice } from './screens/team/connectionState';
import type { NavId } from './kit';
import { P } from './paths';

/** The surfaces of each organization, in sidebar order, with their address. */
export const NAV_PATHS: Partial<Record<OrgKey, Array<[NavId & NavItemModel['kind'], string]>>> = {
  nocera: [
    ['today', P.today()], ['inbox', P.inbox()], ['flows', P.flows()], ['data', P.data()], ['knowledge', P.knowledge()],
    ['views', P.views()], ['channels', P.channels()], ['programs', P.programs()], ['overview', P.overview()], ['settings', P.settings()],
  ],
  orbit: [['callcenter', P.orbitCallCenter()], ['flows', P.orbitFlows()], ['overview', P.orbitOverview()]],
};

/** The chats of an organization in the sidebar, with what you need to see them. */
const CHATS: Partial<Record<OrgKey, Array<{ id: string; title: string; age: string; needs: Permission; subagents?: number }>>> = {
  nocera: [
    { id: 'nuovo-flusso-fatture', title: 'Nuovo flusso: fatture', age: '2m', needs: 'edit:structure', subagents: 1 }, // allow-italian: fixture data, shown as written
    { id: 'intervista-catasto', title: 'Intervista: catasto e ruoli', age: '1g', needs: 'admin' }, // allow-italian: fixture data, shown as written
  ],
};

const PINS = [
  { id: 'm365', label: 'Microsoft 365', monogram: 'M', color: '#c2410c' },
  { id: 'pec', label: 'PEC', kind: 'mail' as const },
  { id: 'halley', label: 'Halley', monogram: 'H', color: '#1d4ed8' },
  { id: 'prunes', label: 'Prunes', monogram: 'P', color: '#92400e' },
];

export function pathOfSidebarRow(id: string): string | undefined {
  if (id === 'board') return P.board();
  if (id.startsWith('chat:')) return P.chat(id.slice(5));
  if (id.startsWith('pin:')) {
    const pin = id.slice(4);
    return pin === 'pec' ? P.channels('pec') : P.program(pin);
  }
  const [org, nav] = id.split('/') as [OrgKey, string | undefined];
  if (!nav) return P.org(org);
  return NAV_PATHS[org]?.find(([n]) => n === nav)?.[1];
}

/**
 * The live flows of an organization. ORBIT keeps its full list (six, all live) in its own fixtures and only three of
 * them as step-by-step flows, so it is counted from that list: the sidebar, the Board and the Armonia page then agree
 * with the ORBIT screens.
 */
export function liveFlowCount(org: OrgKey): number {
  if (org === 'orbit') return ORBIT_FLOWS.length;
  return FLOWS.filter((f) => f.org === org && f.status === 'attivo').length; // allow-italian: identifier compared by value, not shown
}

export function sidebarModel(state: DemoState, persona: Persona, can: (p: Permission) => boolean, activeId: string | undefined, expanded: string[]): SidebarModel {
  const queue = queueFor(state, persona, 'nocera');
  const orgs: OrgModel[] = ORGS.filter((o) => persona.orgs.includes(o.id)).map((o) => {
    const nav = (NAV_PATHS[o.id] ?? [])
      .filter(([kind]) => can(`view:${kind}` as Permission))
      .map(([kind]): NavItemModel => ({
        id: `${o.id}/${kind}`,
        kind,
        count: kind === 'inbox' && queue.length ? queue.length : undefined,
        urgent: kind === 'inbox' && queue.some((c) => c.urgent),
      }));
    const chats = (CHATS[o.id] ?? []).filter((c) => can(c.needs)).map((c) => ({ id: `chat:${c.id}`, title: c.title, age: c.age, subagents: c.subagents }));
    const waiting = o.id === 'nocera' ? queue.length : 0;
    return {
      id: o.id,
      name: o.name,
      monogram: o.monogram,
      color: o.color,
      nav: nav.length ? nav : undefined,
      chats,
      expanded: nav.length ? expanded.includes(o.id) : undefined,
      attention: waiting ? 'needs-you' : undefined,
      count: waiting || undefined,
    };
  });
  const active = FLOWS.filter((f) => f.status === 'attivo' && persona.orgs.includes(f.org)); // allow-italian: identifier compared by value, not shown
  const live = persona.orgs.reduce((n, o) => n + liveFlowCount(o), 0);
  const robots = active.reduce((n, f) => n + f.steps.filter((s) => s.kind === 'robot').length, 0);
  // Trials running now, counted by the rule c02 uses for its «In collaudo»: flows and new versions in test, plus pieces in test.
  const testing = trialsRunning((state.slices.tests as TestsSlice | undefined) ?? TESTS_INITIAL, persona.orgs);
  const role = ROLES.find((r) => r.id === persona.role);
  // The Halley robot of Nocera stops on 05/11 (password changed in Halley, n11) and stays stopped until a new one is
  // in the vault, from whichever screen, or while someone disconnected it: the strip asks the connection, as n16 does.
  const halley = connectionOf('halley');
  const halleyNow = halley ? connectionState(halley, (state.slices.connections as ConnectionsSlice | undefined) ?? CONNECTIONS_INITIAL, (state.slices[VAULT_SLICE] as Vault | undefined) ?? {}) : 'connected';
  const halleyStopped = persona.orgs.includes('nocera') && halleyNow !== 'connected';
  const numbers: Array<[string, string]> = [['robot', String(robots)], ['agenti PC', '2'], ['collaudi', String(testing)]]; // allow-italian: fixture data, shown as written
  return {
    inboxCount: queue.length || undefined,
    board: can('view:board') ? { flows: live, inbox: queue.length } : undefined,
    pinned: can('view:programs') ? PINS.map((p) => ({ ...p, id: `pin:${p.id}` })) : undefined,
    orgs,
    activeId,
    system: can('view:flows')
      ? halleyStopped
        ? { tone: 'warn', headline: 'Robot Halley fermo', detail: halleyNow === 'todo' ? 'scollegato' : 'dalle 09:50', numbers } // allow-italian: fixture data, shown as written
        : { tone: 'ok', headline: 'Tutto ok', detail: `${live} flussi girano`, numbers } // allow-italian: fixture data, shown as written
      : undefined,
    identity: { name: persona.name, monogram: persona.monogram, color: persona.color, detail: role?.label ?? '' },
  };
}
