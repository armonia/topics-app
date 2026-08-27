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

export function createMcpRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async (_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> => {
    if (pathname === "/api/mcp/fleet" && method === "GET") {
      await ensureMcpFleet();
      return json(mcpFleetStatus());
    }
    if (pathname === "/api/mcp/fleet/refresh" && method === "POST") {
      await remountMcpFleet();
      return json(mcpFleetStatus());
    }
    return null;
  };
}
