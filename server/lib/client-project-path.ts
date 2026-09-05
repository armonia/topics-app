import { isClientProjectPathAccepted } from "./broad-cwd";
import { agentAuthOk } from "./agent-auth";

/**
 * WHO MAY WRITE INTO THE PROJECT ALLOWLIST.
 *
 * `services/known-project-dirs.ts` is the boundary of every route that takes a
 * `path` from a client (`resolveProjectPath`, the file routes, `/preview/`,
 * the project icon). Four of its sources are fed by a request:
 *
 *   - a terminal session cwd            (`POST /api/terminal/sessions`)
 *   - a registered project              (`POST /api/projects`)
 *   - `topic.projectPath`               (`POST`/`PATCH /api/topics`)
 *   - a `project:` token in `ui_state`  (`PUT /api/ui-state/:key`)
 *
 * The first was closed on 2026-09-03, when a phone with an owner cookie could
 * open a shell in `~/.ssh` and read it back through `/api/files/content`. The
 * other three land in the same set in two calls, so they answer to the same
 * predicate rather than to three variants of it.
 *
 * Two exemptions, both because refusing would take nothing away from them:
 *  - LOOPBACK has no `deviceId` (see the identity axis in `server.ts`): it is
 *    the desktop app on this machine, which already opens a folder picker and
 *    a shell;
 *  - an AGENT carries the daemon token, and it already runs commands here.
 *
 * Returns true when the write must be REFUSED, so the call site reads as a
 * guard and the default (no identity resolved) is "not gated".
 */
export function clientProjectPathRefused(
  req: Request,
  path: string,
  ctx: {
    requestIdentity?: (req: Request) => { role: "owner" | "guest"; deviceId: string | null } | null;
    resolveProjectPath: (inputPath: string) => string | null;
  },
): boolean {
  if (!ctx.requestIdentity?.(req)?.deviceId) return false;
  if (agentAuthOk(req)) return false;
  return !isClientProjectPathAccepted(path, ctx.resolveProjectPath);
}

/** The message every refusal carries, so a client can match one string. */
export const CLIENT_PROJECT_PATH_ERROR = "path must be inside a known project";
