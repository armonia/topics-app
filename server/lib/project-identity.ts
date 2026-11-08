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

/**
 * The checkout of a project, given EITHER of its two names.
 *
 * A card's `project_id` is the board id (`topics-app-ar3jt5`, from the path),
 * while `projectStore.get` wants the store id (a UUID). The remote-node lane
 * asked the store directly with the card's id, so on a real board it found no
 * checkout, no `origin`, and parked every card meant for a node. It never
 * showed: the lane's tests use stores keyed by the same id the card carries.
 */
export function projectPathOfAnyId(
  db: Pick<Database, "query">,
  getPath: (storeId: string) => string | null | undefined,
  projectId: string,
): string | null {
  return getPath(canonicalProjectIdentity(db, projectId).storeId) ?? null;
}
