/**
 * The agents registry on the wire.
 *
 *   GET  /api/agents  → { agents: AgentRecord[] }, read from the channel
 *                        engine's config. Empty when none is configured.
 *   POST /api/agents  { name, job, character? } → creates a new agent
 *                        folder and config entry. Authenticated: a guest
 *                        cannot create one.
 */
import { homedir } from "os";
import { join } from "path";
import { resolveAppDataDir } from "../lib/data-dir";
import { createAgent, readAgents, registryHome } from "../agents/registry";
import type { AppContext, RouteHandler } from "../types";

const expandTilde = (p: string): string => p.replace(/^~(?=\/|$)/, homedir());

export function createAgentsRouter(
  ctx: Pick<AppContext, "json" | "requestIdentity">,
  home: () => string = registryHome,
  agentsRoot: () => string = () => join(resolveAppDataDir(), "agents"),
): RouteHandler {
  return async function agentsRouter(req, _url, pathname, method) {
    if (pathname !== "/api/agents") return null;

    if (method === "GET") {
      return ctx.json({ agents: readAgents(home(), expandTilde) });
    }

    if (method === "POST") {
      if (ctx.requestIdentity?.(req)?.role === "guest") {
        return ctx.json({ error: "guest_forbidden" }, 403);
      }
      let body: { name?: unknown; job?: unknown; character?: unknown };
      try {
        body = await req.json();
      } catch {
        return ctx.json({ error: "invalid JSON body" }, 400);
      }
      try {
        const agent = createAgent(home(), agentsRoot(), {
          name: String(body.name ?? ""),
          job: String(body.job ?? ""),
          character: body.character === undefined ? undefined : String(body.character),
        });
        return ctx.json({ ok: true, agent });
      } catch (err) {
        return ctx.json({ error: (err as Error).message }, 400);
      }
    }

    return null;
  };
}
