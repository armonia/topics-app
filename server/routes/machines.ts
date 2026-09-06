/**
 * Routes — `/api/machines` (Phase D · migration 020)
 */
import type { AppContext, RouteHandler } from "../types";
import type { OutboundType } from "../../shared/ws-outbound";
import { MachineInUseError } from "../services/machine-store";

const NAME_MAX = 200;

function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

export function createMachinesRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON, matchRoute, errorResponse, machineStore, broadcastToAll } = ctx;
  const emit = (type: OutboundType, machine: unknown) =>
    broadcastToAll({ type, machine, payload_version: 1 });

  return async function machinesRouter(req, _url, pathname, method) {
    if (method === "GET" && pathname === "/api/machines") {
      return json({ machines: machineStore.list() });
    }
    {
      const params = matchRoute(pathname, "/api/machines/:id");
      if (params) {
        if (method === "GET") {
          const m = machineStore.get(params.id);
          if (!m) return errorResponse(404, "Machine not found");
          return json(m);
        }
        if (method === "PATCH") {
          const body = await readJSON(req);
          if (!body) return errorResponse(400, "body required");
          const name = stripCtrl(body.name);
          if (!name) return errorResponse(400, "name required");
          if (name.length > NAME_MAX) return errorResponse(400, `name too long (max ${NAME_MAX})`);
          const m = machineStore.rename(params.id, name);
          if (!m) return errorResponse(404, "Machine not found");
          emit("machine:updated", m);
          return json(m);
        }
        if (method === "DELETE") {
          try {
            const ok = machineStore.delete(params.id);
            if (!ok) return errorResponse(404, "Machine not found");
            emit("machine:deleted", { id: params.id });
            return json({ ok: true });
          } catch (err: any) {
            if (err instanceof MachineInUseError) {
              return errorResponse(409, err.message);
            }
            throw err;
          }
        }
      }
    }
    return null;
  };
}
