import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";

export interface CanonicalProjectIdentity {
  storeId: string;
  boardId: string;
  aliases: readonly string[];
}

/** Resolve the two persisted names of one registered project without widening to a path sibling. */
export function canonicalProjectIdentity(
  db: Pick<Database, "query">,
  projectId: string,
): CanonicalProjectIdentity {
  try {
    const rows = db.query("SELECT id, path FROM projects").all() as Array<{ id: string; path: string }>;
    const project = rows.find((candidate) => candidate.id === projectId)
      ?? rows.find((candidate) => projectIdForPath(candidate.path) === projectId);
    if (project) {
      const boardId = projectIdForPath(project.path);
      return {
        storeId: project.id,
        boardId,
        aliases: project.id === boardId ? [boardId] : [boardId, project.id],
      };
    }
  } catch {
    // Reduced schemas have no project catalogue. Preserve their literal boundary.
  }
  return { storeId: projectId, boardId: projectId, aliases: [projectId] };
}

export function projectAliasPlaceholders(identity: CanonicalProjectIdentity): string {
  return identity.aliases.map(() => "?").join(",");
}
