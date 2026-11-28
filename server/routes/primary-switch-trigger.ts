/**
 * `POST /__daemon/primary-switch`: the local half of `bun run primary switch <machine>`
 * (track T4). Behind the same loopback and daemon-token gate as every
 * `/__daemon/*` endpoint; it resolves the target among the paired machines,
 * builds the orchestrator's dependencies from the live server and runs it.
 * One switch at a time.
 */
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { getPrimaryRole } from "../lib/primary-role";
import { reclaimPrimary, restartThisServerSoon, setPrimaryFence } from "../lib/primary-fence";
import { resolveSecretsDir } from "../lib/data-dir";
import type { RowCounts, SwitchManifest } from "../lib/primary-switch";
import { NODE_PRIMARY_COMMIT_PATH, NODE_PRIMARY_INCOMING_PATH } from "./nodes-primary";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { isNodeSessionKey } from "../services/task-dispatcher-remote-node";
import { runPrimarySwitch, type CommitAnswer, type SwitchTarget, type WorkInFlight } from "../services/primary-switch-run";
import type { StopCause } from "../lib/abort-cause";
import { SERVER_VERSION } from "../ws-capabilities";

export interface PrimarySwitchTriggerDeps {
  ctx: Pick<AppContext, "db" | "STATE_DIR" | "APP_DATA_DIR" | "machineStore" | "activeStreams">;
  dispatcher: {
    drain: (reason: string) => void;
    undrain: (reason: string) => void;
    busyTurns: () => Array<{ taskId: string; sessionKey: string }>;
    /** The card runs on one node: the target's own, which its restart would kill. */
    nodeRunsOn: (machineId: string) => Array<{ taskId: string; sessionKey: string }>;
    nodeLaunchesInFlight: () => Array<{ taskId: string; sessionKey: string }>;
    parkNodeRun: (taskId: string, note: string) => Promise<boolean | null>;
  };
  release: (args: { taskId: string; requeue: boolean; reason?: string; by?: string }) => unknown;
  /** The scheduled jobs engine: paused with the drain, its runs waited for or parked like the cards. */
  schedule: {
    pauseStarts: () => void;
    resumeStarts: () => void;
    inFlightRuns: () => Array<{ runId: string; jobId: string }>;
    cancelOpenRuns: (jobId: string, reason: string) => number;
  };
  abortTurn: (sessionKey: string, cause: StopCause) => Promise<void>;
  fetch?: typeof fetch;
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const COMMIT_TIMEOUT_MS = 10 * 60_000;

/**
 * The bundle carries the whole DB, node tokens and the licence: it leaves only
 * over an encrypted channel. `https:` anywhere, or plain `http:` to this
 * computer's loopback, which is what an ssh tunnel to the node looks like.
 * Anything else (an `http:` LAN or tailnet address) is refused before a byte
 * is sent: this code cannot tell an encrypted network from an open one.
 */
export function encryptedChannelError(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return "the node address is not a URL";
  }
  if (u.protocol === "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol === "http:" && (host === "127.0.0.1" || host === "::1" || host === "localhost")) return null;
  return `the node is reached over ${u.protocol}//${u.host}, which is not encrypted: pair it over https or an ssh tunnel to 127.0.0.1`;
}

/** The calls to the receiver, with the same identity and epoch headers as every call to a node. */
export function primaryTransport(baseUrl: string, token: string, doFetch: typeof fetch = fetch) {
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    "User-Agent": `Topics/${SERVER_VERSION} (${osHostname()})`,
    Cookie: `${NODE_SESSION_COOKIE}=${token}`,
    ...(getPrimaryRole()?.outgoingHeaders() ?? {}),
    ...extra,
  });
  return {
    async upload(name: string, offset: number, bytes: Uint8Array): Promise<void> {
      const url = `${baseUrl}${NODE_PRIMARY_INCOMING_PATH}?name=${encodeURIComponent(name)}&offset=${offset}`;
      const res = await doFetch(url, {
        method: "PUT", body: bytes as Uint8Array<ArrayBuffer>, headers: headers({ "content-type": "application/octet-stream" }),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`upload of ${name} at ${offset}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
    async commit(manifest: SwitchManifest): Promise<CommitAnswer> {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${NODE_PRIMARY_COMMIT_PATH}`, {
          method: "POST", body: JSON.stringify(manifest), headers: headers({ "content-type": "application/json" }),
          signal: AbortSignal.timeout(COMMIT_TIMEOUT_MS),
        });
      } catch (err) {
        return { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
      }
      const body = await res.json().catch(() => null) as { counts?: RowCounts; code?: string; error?: string } | null;
      if (res.ok && body?.counts) return { kind: "accepted", counts: body.counts };
      // An explicit refusal names its code; anything else (5xx, a proxy page) is not a no.
      if (res.status >= 400 && res.status < 500 && typeof body?.code === "string") {
        return { kind: "refused", code: body.code, error: body.error ?? `HTTP ${res.status}` };
      }
      return { kind: "unknown", error: `HTTP ${res.status}` };
    },
  };
}

type Resolved = { ok: true; target: SwitchTarget; baseUrl: string; token: string } | { ok: false; error: string; code?: string };

export function resolveSwitchTarget(ctx: PrimarySwitchTriggerDeps["ctx"], ref: string): Resolved {
  const local = ctx.machineStore.upsertLocal();
  const machines = ctx.machineStore.list().filter((m) => m.id !== local.id);
  const wanted = ref.trim();
  const byId = machines.filter((m) => m.id === wanted);
  const byName = byId.length ? byId : machines.filter((m) => m.name === wanted);
  const matches = byName.length ? byName : machines.filter((m) => m.hostname === wanted);
  if (matches.length !== 1) {
    return { ok: false, error: matches.length ? `"${wanted}" names ${matches.length} machines: use the id` : `no other machine is called "${wanted}"` };
  }
  const m = matches[0]!;
  const baseUrl = m.baseUrl ?? "";
  const token = readNodeToken(ctx.STATE_DIR, m.id);
  if (!baseUrl || !token) return { ok: false, error: `${m.name} is not a paired node of this server` };
  const plain = encryptedChannelError(baseUrl);
  if (plain) return { ok: false, error: plain, code: "plain_channel" };
  return { ok: true, target: { id: m.id, hostname: m.hostname, name: m.name }, baseUrl, token };
}

let running = false;

const answer = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handlePrimarySwitch(req: Request, deps: PrimarySwitchTriggerDeps): Promise<Response> {
  if (running) return answer({ error: "a switch is already running", code: "switch_in_progress" }, 409);
  const body = await req.json().catch(() => null) as { machine?: unknown; drainTimeoutMs?: unknown } | null;
  if (typeof body?.machine !== "string" || !body.machine.trim()) return answer({ error: "machine is required", code: "invalid_input" }, 400);
  const role = getPrimaryRole();
  if (!role) return answer({ error: "the primary role is not wired on this server", code: "unavailable" }, 503);
  const resolved = resolveSwitchTarget(deps.ctx, body.machine);
  if (!resolved.ok) return answer({ error: resolved.error, code: resolved.code ?? "unknown_machine" }, resolved.code ? 409 : 404);
  const { ctx } = deps;
  const transport = primaryTransport(resolved.baseUrl, resolved.token, deps.fetch);
  running = true;
  try {
    const report = await runPrimarySwitch({
      db: ctx.db,
      stateDir: ctx.STATE_DIR,
      secretsDir: resolveSecretsDir(ctx.STATE_DIR),
      appDataDir: ctx.APP_DATA_DIR,
      projectsDir: join(homedir(), ".claude", "projects"),
      role,
      localMachineId: ctx.machineStore.upsertLocal().id,
      target: resolved.target,
      drain: (reason) => { deps.dispatcher.drain(reason); deps.schedule.pauseStarts(); },
      undrain: (reason) => { deps.schedule.resumeStarts(); deps.dispatcher.undrain(reason); },
      stillWorking: (): WorkInFlight[] => {
        // Runs on the TARGET die with its restart and its DB is set aside at boot, so they are
        // waited for like local turns. Runs on a third node keep running and are reattached by the
        // new primary, but only once the node named them: a launch still on its way to ANY machine
        // has no run id in the DB, so it is waited for or parked too.
        const byTask = new Map<string, WorkInFlight & { taskId: string }>();
        for (const c of [...deps.dispatcher.busyTurns(), ...deps.dispatcher.nodeRunsOn(resolved.target.id), ...deps.dispatcher.nodeLaunchesInFlight()]) {
          if (!byTask.has(c.taskId)) byTask.set(c.taskId, c);
        }
        const cards = [...byTask.values()];
        const covered = new Set(cards.map((c) => c.sessionKey));
        const chats = [...ctx.activeStreams.keys()].filter((sk) => !covered.has(sk)).map((sessionKey) => ({ sessionKey }));
        const jobs = deps.schedule.inFlightRuns().map((r) => ({ scheduledJobId: r.jobId, sessionKey: `scheduled-run:${r.runId}` }));
        return [...cards, ...chats, ...jobs];
      },
      park: async (work, note) => {
        // A run closed `cancelled` here, before the fence, travels closed: the new primary never starts it again.
        if (work.scheduledJobId) { deps.schedule.cancelOpenRuns(work.scheduledJobId, note); return; }
        // A run on the target is cancelled there and its card requeued with `node_run_id` cleared.
        if (work.taskId && isNodeSessionKey(work.sessionKey)) { await deps.dispatcher.parkNodeRun(work.taskId, note); return; }
        await deps.abortTurn(work.sessionKey, "superseded").catch(() => {});
        if (work.taskId) deps.release({ taskId: work.taskId, requeue: true, reason: note, by: "primary-switch" });
      },
      setFence: setPrimaryFence,
      upload: transport.upload,
      commit: transport.commit,
      restartSelf: restartThisServerSoon,
      ...(typeof body.drainTimeoutMs === "number" && Number.isFinite(body.drainTimeoutMs) && body.drainTimeoutMs >= 0 ? { drainTimeoutMs: body.drainTimeoutMs } : {}),
    });
    return answer(report, report.ok ? 200 : report.outcome === "refused" ? 409 : 502);
  } finally {
    running = false;
  }
}

/** `POST /__daemon/primary-reclaim`: `bun run primary reclaim`, the way out of an uncertain switch. */
export function handlePrimaryReclaim(deps: Pick<PrimarySwitchTriggerDeps, "ctx">): Response {
  if (running) return answer({ error: "a switch is running", code: "switch_in_progress" }, 409);
  const role = getPrimaryRole();
  if (!role) return answer({ error: "the primary role is not wired on this server", code: "unavailable" }, 503);
  const result = reclaimPrimary({
    appDataDir: deps.ctx.APP_DATA_DIR,
    role,
    localMachineId: deps.ctx.machineStore.upsertLocal().id,
    restart: restartThisServerSoon,
  });
  return answer(result, result.ok ? 200 : 409);
}
