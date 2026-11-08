/**
 * The two reads of the load screen (`/schermo/<machine>`), the only routes a
 * device paired as a screen may reach (`lib/screen-scope.ts`):
 *
 *  - `GET /api/system/screen-data[?machine=<id>]`, the slow one (every 20 s):
 *      readout   the machine's processes and sleep countdown (`machine-readout.ts`)
 *      machines  the usage hub's view of the machines (the PC's state and gauges)
 *  - `GET /api/system/screen-sessions[?machine=<id>]`, the live one (every few
 *    seconds): the live sessions and what each costs (`services/session-consumption.ts`),
 *    the same answer the Processes view and the card drawer read.
 *
 * Two routes because their cost and cadence differ: the readout is cached 20 s
 * and the hub's census 30 s, while the sessions move with every model round.
 * The server does the choosing and hands over only what the page shows, because
 * a screen sits on a machine where no secret should be.
 *
 * A hub that does not answer is `null` in its place, never an empty list read
 * as «nothing to show»; the page says the hub is down.
 */
import type { AppContext } from "../types";
import { getSessionConsumption } from "../services/session-consumption-wiring";
import type { RemoteReport } from "../services/session-consumption";
import { HUB_DEFAULT_URL, upstreamBase } from "./hub";

const HUB_TIMEOUT_MS = 5_000;

export interface ScreenDataDeps {
  fetchImpl?: typeof fetch;
  /** Read on every request; null means there is no hub here. */
  hubBase?: () => string | null;
}

type ReadoutAnswer = {
  machine?: { name?: string } | null;
  readout?: {
    procs?: Array<{ memMB?: number; cpuPct?: number | null; job?: boolean }>;
    cores?: number;
    screen?: { jobs?: Array<{ project?: string | null; what?: string; who?: string | null; since?: number | null }> } | null;
  } | null;
};

export function createScreenDataRoute(
  readout: (url: URL) => Promise<Response>,
  deps: ScreenDataDeps = {},
): (url: URL) => Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hubBase = deps.hubBase ?? (() => upstreamBase("TOPICS_HUB_URL", HUB_DEFAULT_URL));

  async function hubMachines(): Promise<unknown> {
    const base = hubBase();
    if (!base) return null;
    try {
      const res = await fetchImpl(`${base}/api/machines`, { signal: AbortSignal.timeout(HUB_TIMEOUT_MS), redirect: "manual" });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  return async (url: URL) => {
    const [readoutRes, machines] = await Promise.all([readout(url), hubMachines()]);
    return Response.json({ readout: await readoutRes.json(), machines }, { headers: { "cache-control": "no-store" } });
  };
}

/**
 * What the paired machine says of the work the Mac sent it: the jobs its sleep
 * keeper lists and the load of the processes flagged as sent work (a test
 * suite from the Mac). The load is one figure for all the jobs; the consumption
 * divides it (`attachRemoteJobs`).
 */
export function remoteReportOf(answer: ReadoutAnswer): RemoteReport | null {
  const r = answer.readout;
  if (!r) return null;
  const jobs = (r.screen?.jobs ?? []).map((j) => ({ project: j.project ?? null, what: j.what ?? "", who: j.who ?? null, since: j.since ?? null }));
  if (jobs.length === 0) return null;
  const sent = (r.procs ?? []).filter((p) => p.job === true);
  const cores = r.cores && r.cores > 0 ? r.cores : null;
  const cpuOfOneCore = sent.some((p) => typeof p.cpuPct === "number") ? sent.reduce((s, p) => s + (p.cpuPct ?? 0), 0) : null;
  return {
    machine: typeof answer.machine?.name === "string" && answer.machine.name ? answer.machine.name : null,
    jobs,
    load: {
      memMB: sent.length ? sent.reduce((s, p) => s + (p.memMB ?? 0), 0) : null,
      // On the machine's own 0-100 scale, like every other CPU figure of the answer.
      cpuPct: cpuOfOneCore !== null && cores ? cpuOfOneCore / cores : null,
    },
  };
}

export function createScreenSessionsRoute(ctx: AppContext, readout: (url: URL) => Promise<Response>): (url: URL) => Promise<Response> {
  return async (url: URL) => {
    const remote = url.searchParams.get("machine") ? remoteReportOf((await (await readout(url)).json()) as ReadoutAnswer) : null;
    const answer = await getSessionConsumption(ctx).read({ remote });
    return Response.json(answer, { headers: { "cache-control": "no-store" } });
  };
}
