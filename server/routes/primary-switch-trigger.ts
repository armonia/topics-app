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
import { restartThisServerSoon, setPrimaryFence } from "../lib/primary-fence";
import type { RowCounts, SwitchManifest } from "../lib/primary-switch";
import { NODE_PRIMARY_COMMIT_PATH, NODE_PRIMARY_INCOMING_PATH } from "./nodes-primary";
import { NODE_SESSION_COOKIE, readNodeToken } from "../services/node-client";
import { runPrimarySwitch, type CommitAnswer, type SwitchTarget, type WorkInFlight } from "../services/primary-switch-run";
import type { StopCause } from "../lib/abort-cause";
import { SERVER_VERSION } from "../ws-capabilities";

export interface PrimarySwitchTriggerDeps {
  ctx: Pick<AppContext, "db" | "STATE_DIR" | "APP_DATA_DIR" | "machineStore" | "activeStreams">;
  dispatcher: {
    drain: (reason: string) => void;
    undrain: (reason: string) => void;
    busyTurns: () => Array<{ taskId: string; sessionKey: string }>;
  };
  release: (args: { taskId: string; requeue: boolean; reason?: string; by?: string }) => unknown;
  abortTurn: (sessionKey: string, cause: StopCause) => Promise<void>;
  fetch?: typeof fetch;
}

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const COMMIT_TIMEOUT_MS = 10 * 60_000;

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

type Resolved = { ok: true; target: SwitchTarget; baseUrl: string; token: string } | { ok: false; error: string };

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
  if (!resolved.ok) return answer({ error: resolved.error, code: "unknown_machine" }, 404);
  const { ctx } = deps;
  const transport = primaryTransport(resolved.baseUrl, resolved.token, deps.fetch);
  running = true;
  try {
    const report = await runPrimarySwitch({
      db: ctx.db,
      stateDir: ctx.STATE_DIR,
      appDataDir: ctx.APP_DATA_DIR,
      projectsDir: join(homedir(), ".claude", "projects"),
      role,
      localMachineId: ctx.machineStore.upsertLocal().id,
      target: resolved.target,
      drain: deps.dispatcher.drain,
      undrain: deps.dispatcher.undrain,
      stillWorking: (): WorkInFlight[] => {
        const cards = deps.dispatcher.busyTurns();
        const covered = new Set(cards.map((c) => c.sessionKey));
        const chats = [...ctx.activeStreams.keys()].filter((sk) => !covered.has(sk)).map((sessionKey) => ({ sessionKey }));
        return [...cards, ...chats];
      },
      park: async (work, note) => {
        await deps.abortTurn(work.sessionKey, "superseded").catch(() => {});
        if (work.taskId) deps.release({ taskId: work.taskId, requeue: true, reason: note, by: "primary-switch" });
      },
      setFence: setPrimaryFence,
      upload: transport.upload,
      commit: transport.commit,
      restartSelf: restartThisServerSoon,
      ...(typeof body.drainTimeoutMs === "number" && body.drainTimeoutMs >= 0 ? { drainTimeoutMs: body.drainTimeoutMs } : {}),
    });
    return answer(report, report.ok ? 200 : report.outcome === "refused" ? 409 : 502);
  } finally {
    running = false;
  }
}
