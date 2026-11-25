/**
 * GET /api/system/machine-security: the security probes of THIS machine.
 *
 * Every Topics server answers it, so the machine that shows a node asks it what
 * the node would say about itself, with the same code and the permissions of
 * the user it runs as. Read-only. The answer is kept for a minute: several
 * windows or rounds do not become several rounds of commands.
 */
import type { RouteHandler } from "../types";
import type { MachineSecurityReport } from "../../shared/machine-health";
import { probeMachineSecurity } from "../lib/machine-security";
import { createLocalProbeEnv } from "../lib/machine-security-env";

const TTL_MS = 60_000;

/** One probe per data folder: the route and the tray's health round share the same cached answer. */
const probes = new Map<string, () => Promise<MachineSecurityReport>>();

export function localSecurityProbe(appDataDir: string, now: () => number = Date.now): () => Promise<MachineSecurityReport> {
  const known = probes.get(appDataDir);
  if (known) return known;
  let cached: { at: number; report: MachineSecurityReport } | null = null;
  let inFlight: Promise<MachineSecurityReport> | null = null;
  const probe = (): Promise<MachineSecurityReport> => {
    if (cached && now() - cached.at < TTL_MS) return Promise.resolve(cached.report);
    if (inFlight) return inFlight;
    inFlight = probeMachineSecurity(createLocalProbeEnv(appDataDir))
      .then((report) => { cached = { at: now(), report }; return report; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  probes.set(appDataDir, probe);
  return probe;
}

export function createMachineSecurityRoute(appDataDir: string): RouteHandler {
  const probe = localSecurityProbe(appDataDir);
  return async (_req, _url, pathname, method) => {
    if (method !== "GET" || pathname !== "/api/system/machine-security") return null;
    return Response.json(await probe());
  };
}
