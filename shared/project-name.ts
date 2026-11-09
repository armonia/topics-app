/**
 * THE NAME OF A PROJECT NOBODY REGISTERED, decided in one place.
 *
 * A card can point at a project that is neither registered nor offered by the
 * picker (a project removed from disk, an id typed by an agent, a folder used
 * as the id itself). The Kanban lanes (client) and the Plan tiles (server) both
 * need a heading for it, and each used to invent its own: the client cut the
 * hash off the slug, the server printed the raw id. Both now call this.
 *
 * A REGISTERED project (or a known folder) is named by
 * `server/services/project-display-name.ts`; this module only covers what that
 * one does not know.
 */

/** What is written when the project cannot be told: a sentence, not a code. */
export const UNKNOWN_PROJECT_NAME = "Progetto sconosciuto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A POSIX or Windows absolute path. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * The readable name carried by a project id, or `null` when it has none.
 *
 * - a PATH used as the id: its last folder, so `/Users/x/.openclaw/workspace/topics-app`
 *   is «topics-app» (no hash to cut: the folder name is the whole name);
 * - a board slug `name-hash` (`quadra-lh40qh`): the name without the hash;
 * - an UUID, or an id that is all hexadecimal: `null`. Cutting the last piece of
 *   an UUID does not make it readable (`405fbb0d-6fdd-4874-b52d` is the same code
 *   with four digits less), and a code is never a name.
 */
export function projectNameFromId(projectId: string): string | null {
  if (ABSOLUTE_PATH.test(projectId)) {
    const folder = projectId.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    return folder || null;
  }
  if (UUID.test(projectId)) return null;
  const withoutHash = projectId.replace(/-[^-]+$/, "");
  return /^[0-9a-f-]{12,}$/i.test(withoutHash) ? null : withoutHash;
}

/** `projectNameFromId`, with the sentence when the id has no name inside. */
export function unregisteredProjectName(projectId: string): string {
  return projectNameFromId(projectId) ?? UNKNOWN_PROJECT_NAME;
}
