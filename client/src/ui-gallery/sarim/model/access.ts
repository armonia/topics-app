/**
 * What a person may do in a section and on a flow, in four levels. The
 * defaults come from the team: the direction manages everything, a team works
 * on the flows of its own area (and those where one of its people has a step)
 * and only sees the others, the board of auditors sees everything and changes
 * nothing. What an admin changed on the
 * permissions page (slice `sarim.access`, written by that page) wins over the
 * default: a team or one person (an exception) can be given another level on a
 * flow or a section.
 *
 * With the defaults no card disappears: a person who only «sees» a flow still
 * finds its cards in the to-do list, they just cannot move them.
 */
import type { DemoState } from '../../app/store/state';
import type { Permission, Persona } from '../../../ui/fixtures/org/people';
import { personaById, teamById, world } from '../world';
import type { SarimTeamId } from '../../../ui/fixtures/sarim-org/people';
import {
  ACCESS_ACTIONS, accessSlice, atLeast, setSection, teamIdOf,
  type AccessAction, type AccessGrants, type AccessLevel, type AccessSection, type AccessSlice,
} from '../../app/store/access-grants';
import { rolePermissions } from '../../app/store/permissions';

export { ACCESS_ACTIONS, accessSlice, atLeast };
export type { AccessAction, AccessLevel, AccessSection, AccessSlice };

/** The role ids that see everything and change nothing, and the one that manages everything. */
const MANAGER_ROLE = world().people.managerRole;
const VIEWER_ROLE = world().people.viewerRole;

/** The team of a person: their area, the board of auditors apart. */
export function teamOfPersona(persona: Persona): SarimTeamId {
  return teamIdOf(persona) ?? world().people.managerTeam;
}

/** The permission that lets a section be opened and the one that lets it be worked in. */
const SECTION_PERMISSIONS: Record<AccessSection, { view: Permission; work: Permission }> = {
  inbox: { view: 'view:inbox', work: 'edit:data' },
  flows: { view: 'view:flows', work: 'edit:data' },
  documents: { view: 'view:knowledge', work: 'edit:data' },
  rules: { view: 'view:knowledge', work: 'edit:data' },
  contracts: { view: 'view:contracts', work: 'edit:contracts' },
  data: { view: 'view:data', work: 'edit:data' },
  programs: { view: 'view:programs', work: 'run:tests' },
};

/** What the role of a person gives, without anything set by hand: the check the defaults are made of. */
const roleHas = (state: DemoState, persona: Persona, perm: Permission) => rolePermissions(state, persona.role).has(perm);

/** The level a person has in a section: a hand-set level (person, then team), else from the role. */
export function sectionLevel(state: DemoState, persona: Persona, section: AccessSection): AccessLevel {
  const set = setSection(accessSlice(state), persona, section);
  if (set) return set;
  return defaultSectionLevel(state, persona, section);
}

function defaultSectionLevel(state: DemoState, persona: Persona, section: AccessSection): AccessLevel {
  if (persona.role === MANAGER_ROLE) return 'manage';
  const need = SECTION_PERMISSIONS[section];
  if (!roleHas(state, persona, need.view)) return 'none';
  if (persona.role === VIEWER_ROLE) return 'view';
  return roleHas(state, persona, need.work) ? 'work' : 'view';
}

/** The level a person has on one flow: a hand-set level (person, then team), else the team's default. */
export function flowLevel(state: DemoState, persona: Persona, flowId: string): AccessLevel {
  const slice = accessSlice(state);
  const set = slice.people[persona.id]?.flows?.[flowId] ?? slice.teams[teamOfPersona(persona)]?.flows?.[flowId];
  if (set) return set;
  const base = defaultFlowLevel(state, persona, flowId);
  /* The level set on the whole «Flussi» section caps the flows nobody set by hand. */
  const section = setSection(slice, persona, 'flows');
  return section === undefined || atLeast(section, base) ? base : section;
}

function defaultFlowLevel(state: DemoState, persona: Persona, flowId: string): AccessLevel {
  const team = teamOfPersona(persona);
  if (persona.role === MANAGER_ROLE) return 'manage';
  if (defaultSectionLevel(state, persona, 'flows') === 'none') return 'none';
  if (persona.role === VIEWER_ROLE || team === world().people.viewerTeam) return 'view';
  const flow = world().opsFlows.find((f) => f.id === flowId);
  /* A team works on the flows of its own area and on those where one of its people has a step (Tecnica approves interventions, Flotta checks the plates). */
  const hasStep = flow?.steps.some((s) => s.actor.kind === 'person' && s.actor.id === persona.id) ?? false;
  return flow?.area === team || hasStep ? 'work' : 'view';
}

/* ---------- the defaults of a team, for the matrix ---------- */

/** The person whose role and steps stand for a team: its leader. */
const leadOf = (team: SarimTeamId) => personaById(teamById(team)?.lead ?? '');

/** The level a team has in a section before anything is set by hand. */
export function defaultTeamSection(state: DemoState, team: SarimTeamId, section: AccessSection): AccessLevel {
  const lead = leadOf(team);
  return lead ? defaultSectionLevel(state, lead, section) : 'none';
}

/** The level a team has on a flow before anything is set by hand. */
export function defaultTeamFlow(state: DemoState, team: SarimTeamId, flowId: string): AccessLevel {
  const lead = leadOf(team);
  return lead ? defaultFlowLevel(state, lead, flowId) : 'none';
}

/** Whether the role of the team's leader gives the action before anything is set by hand. */
export function defaultTeamAction(state: DemoState, team: SarimTeamId, action: Permission): boolean {
  const lead = leadOf(team);
  return lead ? roleHas(state, lead, action) : false;
}

/* ---------- the levels set by hand, as the matrix writes them ---------- */

/** One row of the matrix: a section, a flow or an action. */
export type AccessRow =
  | { kind: 'section'; id: AccessSection }
  | { kind: 'flow'; id: string }
  | { kind: 'action'; id: AccessAction };

/** What a cell holds: a level, or a yes or no for an action. */
export type AccessValue = AccessLevel | boolean;

/** Who a change is for: a whole team or one person (an exception). */
export type AccessScope = { team: SarimTeamId } | { person: string };

const grantsOf = (slice: AccessSlice, scope: AccessScope): AccessGrants | undefined =>
  'team' in scope ? slice.teams[scope.team] : slice.people[scope.person];

/** The value set by hand for a row, if any. */
export function handValue(slice: AccessSlice, scope: AccessScope, row: AccessRow): AccessValue | undefined {
  const g = grantsOf(slice, scope);
  if (!g) return undefined;
  return row.kind === 'section' ? g.sections?.[row.id] : row.kind === 'flow' ? g.flows?.[row.id] : g.actions?.[row.id];
}

/** The slice with a row set by hand to `value`; `undefined` takes the hand-set value away (back to the default). */
export function withHandValue(slice: AccessSlice, scope: AccessScope, row: AccessRow, value: AccessValue | undefined): AccessSlice {
  const key = 'team' in scope ? 'teams' : 'people';
  const id = 'team' in scope ? scope.team : scope.person;
  const grants: AccessGrants = { ...(slice[key][id] ?? {}) };
  const part = row.kind === 'section' ? 'sections' : row.kind === 'flow' ? 'flows' : 'actions';
  const next: Record<string, AccessValue> = { ...((grants[part] as Record<string, AccessValue> | undefined) ?? {}) };
  if (value === undefined) delete next[row.id];
  else next[row.id] = value;
  if (Object.keys(next).length) (grants as Record<string, unknown>)[part] = next;
  else delete (grants as Record<string, unknown>)[part];
  const map = { ...slice[key] };
  if (grants.sections || grants.flows || grants.actions) map[id] = grants;
  else delete map[id];
  return { ...slice, [key]: map };
}

/** Every row set by hand, for a scope. */
export function handRows(slice: AccessSlice, scope: AccessScope): Array<{ row: AccessRow; value: AccessValue }> {
  const g = grantsOf(slice, scope);
  if (!g) return [];
  return [
    ...Object.entries(g.sections ?? {}).map(([id, value]) => ({ row: { kind: 'section', id } as AccessRow, value: value as AccessValue })),
    ...Object.entries(g.flows ?? {}).map(([id, value]) => ({ row: { kind: 'flow', id } as AccessRow, value: value as AccessValue })),
    ...Object.entries(g.actions ?? {}).map(([id, value]) => ({ row: { kind: 'action', id } as AccessRow, value: value as AccessValue })),
  ];
}

/** The key of a row, for a select option and a data attribute: `section:inbox`, `flow:sarim-fir`, `action:admin`. */
export const rowKey = (row: AccessRow) => `${row.kind}:${row.id}`;

export function parseRowKey(key: string): AccessRow | undefined {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return kind === 'section' || kind === 'flow' || kind === 'action' ? ({ kind, id } as AccessRow) : undefined;
}

/** The default of a team on a row: what its leader's role gives, before anything is set by hand. */
export function defaultTeamValue(state: DemoState, team: SarimTeamId, row: AccessRow): AccessValue {
  if (row.kind === 'section') return defaultTeamSection(state, team, row.id);
  if (row.kind === 'flow') return defaultTeamFlow(state, team, row.id);
  return defaultTeamAction(state, team, row.id);
}

/** What a team has on a row: the value set by hand, else its default. */
export function teamValue(state: DemoState, team: SarimTeamId, row: AccessRow): AccessValue {
  return handValue(accessSlice(state), { team }, row) ?? defaultTeamValue(state, team, row);
}
