import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";

export interface CanonicalProjectIdentity {
  storeId: string;
  boardId: string;
  aliases: readonly string[];
}

export type ProjectIdentityResolver = (projectId: string) => CanonicalProjectIdentity;

/** Build a request-scoped resolver. A board id requires one catalogue scan, then both aliases are memoized. */
export function createProjectIdentityResolver(
  db: Pick<Database, "query">,
): ProjectIdentityResolver {
  const catalog = new Map<string, CanonicalProjectIdentity>();
  let catalogueLoaded = false;

  const remember = (storeId: string, path: string): CanonicalProjectIdentity => {
    const boardId = projectIdForPath(path);
    const identity = {
      storeId,
      boardId,
      aliases: storeId === boardId ? [boardId] : [boardId, storeId],
    } satisfies CanonicalProjectIdentity;
    for (const alias of identity.aliases) catalog.set(alias, identity);
    return identity;
  };

  return (projectId: string) => {
    const known = catalog.get(projectId);
    if (known) return known;
    try {
      const direct = db.query("SELECT id, path FROM projects WHERE id = ?").get(projectId) as
        | { id: string; path: string }
        | null;
      if (direct) return remember(direct.id, direct.path);
      if (!catalogueLoaded) {
        catalogueLoaded = true;
        const rows = db.query("SELECT id, path FROM projects").all() as Array<{ id: string; path: string }>;
        for (const row of rows) remember(row.id, row.path);
        const resolved = catalog.get(projectId);
        if (resolved) return resolved;
      }
    } catch {
      // Reduced schemas have no project catalogue. Preserve their literal boundary.
    }
    const literal = { storeId: projectId, boardId: projectId, aliases: [projectId] } as const;
    catalog.set(projectId, literal);
    return literal;
  };
}

/** Resolve the two persisted names of one registered project without widening to a path sibling. */
export function canonicalProjectIdentity(
  db: Pick<Database, "query">,
  projectId: string,
): CanonicalProjectIdentity {
  return createProjectIdentityResolver(db)(projectId);
}

export function projectAliasPlaceholders(identity: CanonicalProjectIdentity): string {
  return identity.aliases.map(() => "?").join(",");
}
