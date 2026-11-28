/**
 * `POST /__daemon/primary-claim`: the local half of `bun run primary claim`
 * (track T9). Behind the same loopback and daemon-token gate as every
 * `/__daemon/*` endpoint; it builds the claim's dependencies from the live
 * server and runs it. One claim at a time.
 */
import { hostname as osHostname } from "node:os";
import type { AppContext } from "../types";
import { getPrimaryRole } from "../lib/primary-role";
import { receiveChecksFor, restartThisServerSoon } from "../lib/primary-fence";
import { claimPrimary, claimSettingsFromEnv } from "../lib/primary-claim";
import { createSecretStore } from "../lib/secret-store";

let running = false;

function answer(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** When the device of the primary that paired this server last called it, or null. */
function lastHeardFromChannel(ctx: Pick<AppContext, "db">, deviceId: string | undefined): number | null {
  if (!deviceId) return null;
  const row = ctx.db.query("SELECT last_seen_at FROM devices WHERE id = ?").get(deviceId) as { last_seen_at: number | null } | null;
  return typeof row?.last_seen_at === "number" ? row.last_seen_at : null;
}

export async function handlePrimaryClaim(req: Request, deps: { ctx: Pick<AppContext, "db" | "STATE_DIR" | "APP_DATA_DIR" | "machineStore"> }): Promise<Response> {
  if (running) return answer({ ok: false, outcome: "refused", code: "claim_in_progress", error: "a claim is running" }, 409);
  const role = getPrimaryRole();
  if (!role) return answer({ ok: false, outcome: "refused", code: "unavailable", error: "the primary role is not wired on this server" }, 503);
  const body = await req.json().catch(() => ({})) as { force?: unknown };
  running = true;
  try {
    const report = await claimPrimary({
      role,
      localMachineId: deps.ctx.machineStore.upsertLocal().id,
      hostname: osHostname(),
      stateDir: deps.ctx.STATE_DIR,
      receive: receiveChecksFor(deps.ctx.STATE_DIR, deps.ctx.APP_DATA_DIR),
      settings: claimSettingsFromEnv(),
      readSecret: (name) => createSecretStore({ stateDir: deps.ctx.STATE_DIR }).read(name),
      lastHeardFromPrimary: () => lastHeardFromChannel(deps.ctx, role.channel()?.deviceId),
      force: body.force === true,
      restart: restartThisServerSoon,
    });
    return answer(report, report.ok ? 200 : 409);
  } finally {
    running = false;
  }
}
