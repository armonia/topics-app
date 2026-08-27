/**
 * WHAT THIS CHAT INHERITED, for one topic.
 *
 * Topics spawns the real CLI with `--setting-sources user,project,local`, so a
 * session already runs with the user's hooks, skills, custom commands, MCP
 * servers and permission rules. What did not exist was the place to LOOK at
 * them: the app inherited an entire environment and showed nothing of it, so
 * the only way to answer "why did that hook fire" or "where did this tool go"
 * was to open the four settings files by hand.
 *
 * ONE GET, NO WRITES. Editing a person's global configuration from here is a
 * separate decision; this route only reports. It is cheap enough to answer on
 * open (a handful of small files) and it never spawns anything, unlike the MCP
 * fleet route which mounts on read.
 *
 *   GET /api/topics/:id/environment -> SessionEnvironment
 */

import { getDatabase } from "../db";
import { resolveSessionEnvironment } from "../lib/session-environment";
import type { AppContext, RouteHandler } from "../types";

/**
 * Is this topic the agent of a board task? Same question the spawn asks
 * (`blockImageReads` in providers/claude/args.ts): a dispatched session runs
 * with the guard hook Topics installs, and the list has to match reality.
 */
function isDispatched(topicId: string): boolean {
  try {
    return !!getDatabase().prepare("SELECT 1 FROM tasks WHERE assigned_topic_id = ? LIMIT 1").get(topicId);
  } catch {
    // No board on this installation: it is a chat like any other.
    return false;
  }
}

export function createSessionEnvironmentRouter(ctx: AppContext): RouteHandler {
  const { json, matchRoute } = ctx;

  return async function sessionEnvironmentRouter(
    _req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    const params = matchRoute(pathname, "/api/topics/:id/environment");
    if (!params || method !== "GET") return null;

    const topic = ctx.getTopicById(params.id);
    if (!topic) return json({ error: "Topic not found" }, 404);

    return json(
      resolveSessionEnvironment({
        // The agent's working directory is where the project and local settings
        // files are read from. A topic without one runs in the server's cwd.
        cwd: topic.projectPath || process.cwd(),
        mcpPolicy: topic.mcpPolicy ?? null,
        provider: topic.provider ?? null,
        topicsGuard: isDispatched(topic.id),
      }),
    );
  };
}
