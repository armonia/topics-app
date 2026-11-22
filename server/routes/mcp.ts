/**
 * What is mounted RIGHT NOW, so nobody has to read the server's stdout.
 *
 * THE SILENCE THIS REPLACES. A globally configured MCP server can be absent for
 * four different reasons: the inheritance rule dropped it, it is in the deny
 * list, its connection failed, or the session is on the reduced profile. Until
 * this endpoint existed the only trace of any of that was one line printed on
 * the server's stdout at spawn time, which nobody reads: a missing tool was
 * indistinguishable from a bug, and people went looking in the wrong place.
 *
 * IT MOUNTS ON READ, on purpose. Asking "what is mounted?" of a fleet that was
 * never mounted has one honest answer, and it is not an empty list: opening the
 * screen connects the fleet, so the connection state it shows is measured, not
 * assumed.
 */

import type { AppContext, RouteHandler } from "../types";
import { ensureMcpFleet, remountMcpFleet, mcpFleetStatus, executeMcpTool, mcpToolSpecs } from "../providers/native/mcp-fleet";
import { startMcpAuthorization } from "../providers/native/mcp-oauth";
import { agentAuthOk } from "../lib/agent-auth";
import { detectAgents } from "../lib/detect-agents";
import { buildAgentToolsInventory } from "../lib/agent-tools";
import { readAgentToolsSettings, writeAgentToolsSettings, writeAgentToolFilter } from "../lib/agent-tools-settings";
import { readAgents, registryHome } from "../agents/registry";
import { resolveAgentToolFilter, filterByName, parseAgentToolFilter } from "../agents/tool-filter";
import { homedir } from "node:os";

/** Same roster `/api/agent-config` reads: the engine's own agents, by id and name. */
function registryAgents(): Array<{ id: string; name: string }> {
  return readAgents(registryHome(), (p) => p.replace(/^~(?=\/|$)/, homedir())).map((a) => ({ id: a.id, name: a.name }));
}

export function createMcpRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, errorResponse } = ctx;

  return async (req: Request, url: URL, pathname: string, method: string): Promise<Response | null> => {
    if (pathname === "/api/mcp/fleet" && method === "GET") {
      // `?peek=1` answers with what is mounted NOW, without mounting: the tail
      // of the user menu's Tools row asks every time the menu opens, and
      // opening a menu must not start a fleet of MCP processes. The level
      // itself reads without it, and that read mounts.
      // `?agent=<id>` is the native engine asking for ITS turn's MCP config:
      // the fleet status narrowed to what that agent's filter allows, the same
      // rule the catalog page shows (`agents/tool-filter.ts`).
      const agentId = url.searchParams.get("agent");
      const scoped = (status: ReturnType<typeof mcpFleetStatus>) => {
        if (!agentId) return status;
        const filter = resolveAgentToolFilter(agentId, readAgentToolsSettings());
        return { ...status, servers: filterByName(filter, status.servers) };
      };
      if (url.searchParams.get("peek") === "1") return json(scoped(mcpFleetStatus()));
      await ensureMcpFleet();
      return json(scoped(mcpFleetStatus()));
    }
    /**
     * One call on the machine's MCP fleet, for a native turn running in its own
     * process (`providers/native/turn-host.ts`). The fleet stays mounted here;
     * the answer carries the fleet's current specs, so a child the call just
     * mounted is offered to the turn's next round.
     */
    if (pathname === "/api/mcp/call" && method === "POST") {
      // Runs any tool of the machine's MCP servers: only Topics' own processes.
      if (!agentAuthOk(req)) return errorResponse(401, "daemon token required");
      const body = await readJSON(req) as { name?: unknown; input?: unknown } | null;
      if (typeof body?.name !== "string") return errorResponse(400, "name required");
      await ensureMcpFleet();
      const input = body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {};
      const result = await executeMcpTool(body.name, input);
      return json({ result, specs: mcpToolSpecs() });
    }
    /**
     * The agents' tools as one inventory (MCP, skills, CLIs), for the user menu
     * page and for `topics tools`. `?project=<dir>` adds that project's own
     * `.mcp.json` and skills.
     */
    if (pathname === "/api/agent-tools" && method === "GET") {
      await ensureMcpFleet();
      return json(buildAgentToolsInventory({
        projectDir: url.searchParams.get("project"),
        settings: readAgentToolsSettings(),
        fleet: mcpFleetStatus(),
        clis: detectAgents(),
        agents: registryAgents(),
        toolSpecs: mcpToolSpecs(),
        // `?agent=<id>` is the gateway asking for ITS mountable children: the
        // catalog narrowed to that agent's filter, same rule as the fleet above.
        agentId: url.searchParams.get("agent"),
      }));
    }
    /** Park or mount an MCP server, or change the extra sources. */
    if (pathname === "/api/agent-tools/settings" && method === "POST") {
      const body = await readJSON(req) as { park?: unknown; mount?: unknown; extraMcpFiles?: unknown; extraSkillDirs?: unknown } | null;
      const current = readAgentToolsSettings();
      let parked = current.parkedMcp;
      if (typeof body?.park === "string") parked = [...parked, body.park];
      if (typeof body?.mount === "string") parked = parked.filter((n) => n !== body.mount);
      const saved = writeAgentToolsSettings({
        parkedMcp: parked,
        ...(Array.isArray(body?.extraMcpFiles) ? { extraMcpFiles: body.extraMcpFiles as string[] } : {}),
        ...(Array.isArray(body?.extraSkillDirs) ? { extraSkillDirs: body.extraSkillDirs as string[] } : {}),
      });
      await remountMcpFleet();
      return json(saved);
    }
    /** Sets one agent's tool filter: `{ agent, mode: 'all'|'selected', servers }`. */
    if (pathname === "/api/agent-tools/agent-filter" && method === "POST") {
      const body = await readJSON(req) as { agent?: unknown } & Record<string, unknown> | null;
      const agentId = typeof body?.agent === "string" ? body.agent.trim() : "";
      if (!agentId) return errorResponse(400, "agent required");
      try {
        const filter = parseAgentToolFilter(body);
        const saved = writeAgentToolFilter(agentId, filter);
        return json(saved);
      } catch (err) {
        return errorResponse(400, err instanceof Error ? err.message : String(err));
      }
    }
    if (pathname === "/api/mcp/fleet/refresh" && method === "POST") {
      await remountMcpFleet();
      return json(mcpFleetStatus());
    }
    /**
     * Begin the sign-in for one OAuth-protected server.
     *
     * ANSWERS BEFORE THE SIGN-IN HAPPENS, which is the whole shape of this
     * route. Discovery and client registration are awaited here because they
     * are the steps that fail for a reason worth showing; the part that waits
     * on a person is the loopback listener, and holding an http request open
     * for the five minutes they might take would be a request that dies of its
     * own timeout while the sign-in is still going fine.
     *
     * There is no second route to poll. When the callback lands, this re-mounts
     * through `remountMcpFleet`, the same call the panel's own re-check button
     * makes, so the fleet the panel is already polling turns green on its own.
     */
    if (pathname === "/api/mcp/oauth/start" && method === "POST") {
      const body = (await readJSON(req)) as { server?: unknown } | null;
      const server = typeof body?.server === "string" ? body.server.trim() : "";
      if (!server) return errorResponse(400, "a server name is required");
      try {
        const { authorizeUrl, completion } = await startMcpAuthorization(server);
        void completion
          .then((ok) => (ok ? remountMcpFleet() : undefined))
          .catch(() => { /* a re-mount that fails leaves the old status, which is honest */ });
        return json({ authorizeUrl });
      } catch (err) {
        // 502: what failed is the conversation with somebody else's
        // authorization server, not the request this client made.
        return errorResponse(502, err instanceof Error ? err.message : String(err));
      }
    }
    return null;
  };
}
