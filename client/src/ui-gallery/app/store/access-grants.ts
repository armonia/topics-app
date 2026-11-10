/**
 * The levels an admin sets by hand on the permissions page of the SARIM
 * edition (slice `sarim.access`): per team or per person (an exception), for
 * a section, for a flow or for one of the four actions. This file holds the
 * shape of the slice and how a hand-set level reaches the permissions the
 * container checks (`canDo`), so the sidebar, the buttons and the cards follow
 * a change at once. It reads only the fixtures and the slice, never the role
 * checks, so `permissions.ts` and `sarim/model/access.ts` can both import it.
 */
import type { Permission, Persona } from '../../../ui/fixtures/org/people';
import { teamIdOfPerson } from '../../sarim/world';
import type { SarimTeamId } from '../../../ui/fixtures/sarim-org/people';
import type { DemoState } from './state';

export type AccessLevel = 'none' | 'view' | 'work' | 'manage';

export type AccessSection = 'inbox' | 'flows' | 'documents' | 'contracts' | 'data' | 'rules' | 'programs';

/** The actions the matrix switches on and off: a yes or a no, not a level. */
export type AccessAction = 'approve:contracts' | 'sign:contracts' | 'export' | 'admin';

export const ACCESS_ACTIONS: AccessAction[] = ['approve:contracts', 'sign:contracts', 'export', 'admin'];

export const ACCESS_LEVELS: AccessLevel[] = ['none', 'view', 'work', 'manage'];

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, work: 2, manage: 3 };

/** Whether `level` reaches at least `needed`. */
export const atLeast = (level: AccessLevel, needed: AccessLevel) => RANK[level] >= RANK[needed];

/** Levels set by hand: per team (id) or per person, for a flow, a section or an action. */
export interface AccessGrants {
  flows?: Record<string, AccessLevel>;
  sections?: Partial<Record<AccessSection, AccessLevel>>;
  actions?: Partial<Record<AccessAction, boolean>>;
}

export interface AccessSlice {
  teams: Record<string, AccessGrants>;
  /** Exceptions: one person with another level than their team. */
  people: Record<string, AccessGrants>;
}

export const ACCESS_SLICE = 'sarim.access';

export const ACCESS_INITIAL: AccessSlice = { teams: {}, people: {} };

export function accessSlice(state: DemoState): AccessSlice {
  return { ...ACCESS_INITIAL, ...((state.slices[ACCESS_SLICE] as Partial<AccessSlice> | undefined) ?? {}) };
}

/** The team of a person of SARIM; undefined for a person of the other edition. */
export const teamIdOf = (persona: Persona): SarimTeamId | undefined => teamIdOfPerson(persona.id);

/** The section level set by hand for a person (their exception first, then their team's), if any. */
export function setSection(slice: AccessSlice, persona: Persona, section: AccessSection): AccessLevel | undefined {
  const team = teamIdOf(persona);
  return slice.people[persona.id]?.sections?.[section] ?? (team ? slice.teams[team]?.sections?.[section] : undefined);
}

function setAction(slice: AccessSlice, persona: Persona, action: AccessAction): boolean | undefined {
  const team = teamIdOf(persona);
  return slice.people[persona.id]?.actions?.[action] ?? (team ? slice.teams[team]?.actions?.[action] : undefined);
}

/** The surface permissions and the sections that open them: «Conoscenza» opens with documents or rules. */
const VIEW_OF: Partial<Record<Permission, AccessSection[]>> = {
  'view:inbox': ['inbox'],
  'view:flows': ['flows'],
  'view:contracts': ['contracts'],
  'view:data': ['data'],
  'view:knowledge': ['documents', 'rules'],
  'view:programs': ['programs'],
};

/**
 * Whether a person has a permission once the levels set by hand are applied
 * to what their role gives (`base`). A level reaches a permission only where
 * one was set: «Vede» on a section opens its surface (`view:*`), «Lavora» on
 * Dati or Contratti lets them edit (`edit:data`, `edit:contracts`), «Gestisce»
 * on Flussi lets them change the structure (`edit:structure`); an action is
 * the yes or no that was set. Everything else stays as the role says.
 */
export function withAccess(state: DemoState, persona: Persona, perm: Permission, base: boolean): boolean {
  if (!teamIdOf(persona)) return base;
  const slice = accessSlice(state);
  const views = VIEW_OF[perm];
  if (views) {
    const hand = views.map((s) => setSection(slice, persona, s));
    if (hand.every((h) => h === undefined)) return base;
    return hand.some((h) => (h === undefined ? base : atLeast(h, 'view')));
  }
  const need = ({ 'edit:data': ['data', 'work'], 'edit:contracts': ['contracts', 'work'], 'edit:structure': ['flows', 'manage'] } as Partial<Record<Permission, [AccessSection, AccessLevel]>>)[perm];
  if (need) {
    const level = setSection(slice, persona, need[0]);
    return level === undefined ? base : atLeast(level, need[1]);
  }
  if ((ACCESS_ACTIONS as Permission[]).includes(perm)) return setAction(slice, persona, perm as AccessAction) ?? base;
  return base;
}
