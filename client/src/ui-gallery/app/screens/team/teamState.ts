/**
 * What the readers did to the team, on top of the people of the example: the
 * slice `team`. A persona's role, offices and organizations can be changed
 * here (`overrides`), invitations wait here until the person answers, and
 * the changes asked of the structure wait here until somebody does them.
 */
import type { OrgKey, Office } from '../../../../ui/fixtures/org/types';
import { PERSONAS, ROLES, type Persona } from '../../../../ui/fixtures/org/people';
import { SEED_INVITES, SEED_PROPOSALS, type ChangeProposal } from '../../../../ui/fixtures/team';

export interface PersonOverride {
  role?: string;
  offices?: Office[];
  orgs?: OrgKey[];
}

export interface InviteState {
  id: string;
  email: string;
  role: string;
  orgs: OrgKey[];
  /** ISO date-time of the last mail. */
  sentAt: string;
  by: string;
}

export interface TeamSlice {
  proposals: ChangeProposal[];
  overrides: Record<string, PersonOverride>;
  invites: InviteState[];
}

export const TEAM_INITIAL: TeamSlice = {
  proposals: SEED_PROPOSALS,
  overrides: {},
  invites: SEED_INVITES.map((i) => ({ id: i.id, email: i.email, role: i.role, orgs: i.orgs as OrgKey[], sentAt: i.sentAt, by: i.by })),
};

/** A persona with the changes made in Settings applied. */
export function effectivePersona(p: Persona, slice: TeamSlice): Persona {
  const o = slice.overrides[p.id];
  return o ? { ...p, role: o.role ?? p.role, offices: o.offices ?? p.offices, orgs: o.orgs ?? p.orgs } : p;
}

export const effectivePeople = (slice: TeamSlice): Persona[] => PERSONAS.map((p) => effectivePersona(p, slice));

export const roleLabel = (id: string): string => ROLES.find((r) => r.id === id)?.label ?? id;
