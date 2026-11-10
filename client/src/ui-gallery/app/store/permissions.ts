/**
 * What the current person may do: their role's permissions, with the changes
 * made in Settings applied on top (a switch in «Squadra e permessi» really
 * changes what that role sees), and in ORBIT the levels set by team or by
 * person (`access-grants.ts`).
 */
import type { Permission, Persona } from '../../../ui/fixtures/org/people';
import { PERSONAS, ROLES, DEFAULT_PERSONA } from '../../../ui/fixtures/org/people';
import { world } from '../../orbit/world';
import { withAccess } from './access-grants';
import type { DemoState } from './state';

/* The people and roles of the multi-organization preview and of the organization's world: a state belongs to one edition, and its persona is found in either list. */
const ALL_PERSONAS: Persona[] = [...PERSONAS, ...world().people.personas];
const ALL_ROLES = [...ROLES, ...world().people.roles];

/** A role, offices or organizations changed in Settings > Team (slice `team`, written by that screen). */
interface PersonOverride { role?: string; offices?: Persona['offices']; orgs?: Persona['orgs'] }

export function personaOf(state: DemoState): Persona {
  const base = ALL_PERSONAS.find((p) => p.id === state.persona) ?? ALL_PERSONAS.find((p) => p.id === DEFAULT_PERSONA)!;
  const o = (state.slices.team as { overrides?: Record<string, PersonOverride> } | undefined)?.overrides?.[base.id];
  return o ? { ...base, role: o.role ?? base.role, offices: o.offices ?? base.offices, orgs: o.orgs ?? base.orgs } : base;
}

export function roleOf(persona: Persona) {
  return ALL_ROLES.find((r) => r.id === persona.role)!;
}

export function rolePermissions(state: DemoState, roleId: string): Set<Permission> {
  const role = ALL_ROLES.find((r) => r.id === roleId);
  const out = new Set<Permission>(role?.permissions ?? []);
  for (const [perm, on] of Object.entries(state.permissions[roleId] ?? {})) {
    if (on) out.add(perm as Permission);
    else out.delete(perm as Permission);
  }
  return out;
}

/** What the person's role gives, with the levels set by hand for their team or for them on top (ORBIT; the other edition has none). */
export function canDo(state: DemoState, persona: Persona, perm: Permission): boolean {
  return withAccess(state, persona, perm, rolePermissions(state, persona.role).has(perm));
}
