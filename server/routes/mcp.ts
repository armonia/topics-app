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
import { ensureMcpFleet, remountMcpFleet, mcpFleetStatus } from "../providers/native/mcp-fleet";
import { startMcpAuthorization } from "../providers/native/mcp-oauth";

export function createMcpRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, errorResponse } = ctx;

  return async (req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> => {
    if (pathname === "/api/mcp/fleet" && method === "GET") {
      await ensureMcpFleet();
      return json(mcpFleetStatus());
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
