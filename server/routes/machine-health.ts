/**
 * GET /api/machines/health: the last round of the machines' health
 * (`boot/machine-health.ts`), the same data the tray reads from
 * `machines-health.json`. The client draws the security mark of every machine
 * row from it (MACHINE-06). Read-only; before the first round, or with an
 * unreadable file, the answer is an empty list and the client shows `unknown`.
 */
import { readFile } from "node:fs/promises";
import type { MachinesHealthFile } from "../../shared/machine-health";
import type { RouteHandler } from "../types";

const EMPTY: MachinesHealthFile = { at: 0, machines: [] };

export function createMachineHealthRoute(filePath: string): RouteHandler {
  return async (_req, _url, pathname, method) => {
    if (method !== "GET" || pathname !== "/api/machines/health") return null;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MachinesHealthFile>;
      return Response.json({ at: parsed.at ?? 0, machines: Array.isArray(parsed.machines) ? parsed.machines : [] } satisfies MachinesHealthFile);
    } catch {
      return Response.json(EMPTY);
    }
  };
}
