/**
 * Which projects belong to a group's page, and which do not.
 *
 * A separate module for the same two reasons `membri.ts` is one: Fast Refresh
 * refuses a file that exports both a component and a plain function, and
 * separating this out gives the rule its own test
 * (`OrgProjectsSection.test.ts`) instead of a filter buried in a component body
 * that could silently drift back to "show everything" without breaking a
 * single thing.
 */

export interface OrgProjectRow {
  id: string;
  name: string;
  path: string;
  incognito?: boolean;
  orgId?: string | null;
}

/**
 * A project is THIS group's when its own `orgId` says so, never because it
 * happens to be visible on the installation. `orgId: null` (no group) is
 * scoped OUT everywhere: a personal project is not this group's project on
 * ANY group's page, its own included.
 */
export function scopeProjectsToOrg(projects: readonly OrgProjectRow[], orgId: string | null): OrgProjectRow[] {
  if (!orgId) return [];
  return projects.filter((p) => !p.incognito && p.orgId === orgId);
}
