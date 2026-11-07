import type { AppContext, RouteHandler } from "../types";
import { runBounded, SPAWN_TIMEOUT } from "../lib/bounded-spawn";
import { augmentPath } from "../utils/path-env";

export type CronCliResult =
  | { ok: true; stdout: string }
  | { ok: false; status: number; message: string };

/** One `jarvis-channels cron <args>` call: the router gets a stub in the tests. */
export type CronCli = (args: string[]) => Promise<CronCliResult>;

/**
 * One `jarvis-channels cron …` call, the scheduler of Jarvis.
 *
 * I lavori programmati di Jarvis li tiene `jarvis-channels` (dal 03/11): la
 * sua riga di comando è l'unica porta, nessun gateway e nessun token passano
 * da Topics. Forma dell'errore, misurata: exit 1, una riga su stderr
 * («job X: non trovato», «job X: ambiguo»), e per `run --json` anche
 * `{ok:false, reason:"not-found"}` su stdout. Un job che non c'è è un 400;
 * tutto il resto (binario assente, scadenza, uscita strana) è un 502.
 */
export async function jarvisChannelsCron(args: string[], opts: { bin?: string | null } = {}): Promise<CronCliResult> {
  const bin = opts.bin === undefined ? Bun.which("jarvis-channels", { PATH: augmentPath() }) : opts.bin;
  if (!bin) return { ok: false, status: 502, message: "jarvis-channels not found on PATH" };
  const r = await runBounded([bin, "cron", ...args], {
    env: { ...process.env, PATH: augmentPath() },
    stdin: "ignore",
    stderr: "pipe",
    timeoutMs: SPAWN_TIMEOUT.query,
  });
  if (r.spawnFailed) return { ok: false, status: 502, message: `jarvis-channels did not start: ${r.spawnError ?? "unknown error"}` };
  if (r.timedOut) return { ok: false, status: 502, message: `jarvis-channels cron ${args[0] ?? ""} timed out` };
  if (r.exitCode === 0) return { ok: true, stdout: r.stdout };
  const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").pop() || `exit ${r.exitCode}`;
  const missing = /non trovato|ambiguo|not-found/.test(r.stderr + r.stdout);
  return { ok: false, status: missing ? 400 : 502, message: tail };
}

/** A job as the panel reads it: the shape `readCronJobs` takes (ISO times). */
export interface CronJobView {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Record<string, unknown> | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

function isoOf(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The jobs of `cron list --json --all` in the panel's shape, or null when the
 * answer is not a list. jarvis-channels dà i tempi in millisecondi dentro
 * `state` (`nextRunAtMs`, `lastRunAtMs`): il pannello li legge in ISO in cima.
 */
export function readJobList(stdout: string): CronJobView[] | null {
  let d: any;
  try { d = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(d?.jobs)) return null;
  return d.jobs.flatMap((j: any): CronJobView[] => {
    if (!j || typeof j.id !== "string" || !j.id) return [];
    const state = j.state ?? {};
    return [{
      id: j.id,
      name: typeof j.name === "string" && j.name ? j.name : j.id,
      enabled: j.enabled !== false,
      schedule: j.schedule && typeof j.schedule === "object" ? j.schedule : null,
      nextRunAt: isoOf(state.nextRunAtMs),
      lastRunAt: isoOf(state.lastRunAtMs),
      lastStatus: typeof state.lastStatus === "string" ? state.lastStatus : null,
    }];
  });
}

// `--all`: senza, `--json` lascia fuori i job spenti, e il pannello li riaccende da qui.
const LIST_ARGS = ["list", "--json", "--all"];

export function createCronRouter(ctx: AppContext, cli: CronCli = (args) => jarvisChannelsCron(args)): RouteHandler {
  const { readJSON, json, matchRoute, broadcastToAll } = ctx;

  async function listJobs(): Promise<{ ok: true; jobs: CronJobView[] } | { ok: false; status: number; message: string }> {
    const r = await cli(LIST_ARGS);
    if (!r.ok) return r;
    const jobs = readJobList(r.stdout);
    return jobs ? { ok: true, jobs } : { ok: false, status: 502, message: "jarvis-channels cron list: the answer is not a job list" };
  }

  // Re-fetch the job list and broadcast it to all clients (best-effort).
  async function broadcastCronList() {
    const r = await listJobs();
    if (r.ok) broadcastToAll({ type: "cron:updated", jobs: r.jobs });
  }

  return async function cronRouter(req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {

    if (method === "GET" && pathname === "/api/cron/jobs") {
      const r = await listJobs();
      // 502, not 200 with an empty list: the panel reads `res.ok`, and a
      // scheduler that does not answer must not look like every job was deleted.
      if (!r.ok) return json({ jobs: [], warning: `Scheduler error: ${r.message}` }, 502);
      return json({ jobs: r.jobs });
    }

    // `--id`, non posizionale: un id che comincia con «-» non diventa un'opzione.
    // Un id vuoto non arriva alla CLI: lì «» è il prefisso di ogni job.
    const jobMatch = matchRoute(pathname, "/api/cron/jobs/:jobId");
    const cronJobMatch = jobMatch?.jobId ? jobMatch : null;
    if (cronJobMatch && method === "PATCH") {
      const patch = await readJSON(req);
      // Il pannello cambia solo acceso/spento; altro non ha un comando qui.
      if (typeof patch?.enabled !== "boolean") return json({ error: "Only `enabled` can be changed" }, 400);
      const r = await cli([patch.enabled ? "enable" : "disable", "--id", cronJobMatch.jobId]);
      if (!r.ok) return json({ error: `Scheduler error: ${r.message}` }, r.status);
      await broadcastCronList();
      return json({ ok: true });
    }

    const runMatch = matchRoute(pathname, "/api/cron/jobs/:jobId/run");
    const cronRunMatch = runMatch?.jobId ? runMatch : null;
    if (cronRunMatch && method === "POST") {
      // `cron run` parte subito, dovuto o no, e torna appena avviato: il giro finisce nel registro.
      const r = await cli(["run", "--id", cronRunMatch.jobId, "--json"]);
      if (!r.ok) return json({ error: `Scheduler error: ${r.message}` }, r.status);
      let out: any;
      try { out = JSON.parse(r.stdout); } catch { out = undefined; }
      // Un «sì» che non dice di essere partito non timbra la riga come eseguita.
      if (out?.ok !== true) return json({ error: `Not run: ${out?.reason ?? "the scheduler gave no reason"}` }, 409);
      await broadcastCronList();
      return json({ ok: true });
    }

    if (cronJobMatch && method === "DELETE") {
      const r = await cli(["rm", "--id", cronJobMatch.jobId]);
      if (!r.ok) return json({ error: `Scheduler error: ${r.message}` }, r.status);
      await broadcastCronList();
      return json({ ok: true });
    }

    return null;
  };
}
