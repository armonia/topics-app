/**
 * `POST /__daemon/primary-claim`: the local half of `bun run primary claim`
 * (track T9). Behind the same loopback and daemon-token gate as every
 * `/__daemon/*` endpoint; it builds the claim's dependencies from the live
 * server and runs it. One claim at a time.
 *
 * `POST /__daemon/primary-release`: the local half of `bun run primary
 * release`, the way out of the boot wait of a primary whose nodes are gone
 * for good (`holdInternalWritesUntilNodesAnswer`).
 */
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { getPrimaryRole, isBootHoldActive, lastCallFromPrimary, releaseBootHold } from "../lib/primary-role";
import { receiveChecksFor, restartThisServerSoon } from "../lib/primary-fence";
import { claimPrimary, claimSettingsFromEnv } from "../lib/primary-claim";
import { createSecretStore } from "../lib/secret-store";

/** The checkout this server runs from: the machine row records the version read there. */
const ROOT_DIR = join(import.meta.dir, "..", "..");

let running = false;

function answer(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handlePrimaryClaim(req: Request, deps: { ctx: Pick<AppContext, "STATE_DIR" | "APP_DATA_DIR"> }): Promise<Response> {
  if (running) return answer({ ok: false, outcome: "refused", code: "claim_in_progress", error: "a claim is running" }, 409);
  const role = getPrimaryRole();
  if (!role) return answer({ ok: false, outcome: "refused", code: "unavailable", error: "the primary role is not wired on this server" }, 503);
  // Taken before the first await: two requests in the same tick must not both get past the check.
  running = true;
  try {
    const body = await req.json().catch(() => ({})) as { force?: unknown };
    const report = await claimPrimary({
      role,
      rootDir: ROOT_DIR,
      hostname: osHostname(),
      stateDir: deps.ctx.STATE_DIR,
      receive: receiveChecksFor(deps.ctx.STATE_DIR, deps.ctx.APP_DATA_DIR),
      settings: claimSettingsFromEnv(),
      readSecret: (name) => createSecretStore({ stateDir: deps.ctx.STATE_DIR }).read(name),
      lastHeardFromPrimary: lastCallFromPrimary,
      force: body.force === true,
      restart: restartThisServerSoon,
    });
    return answer(report, report.ok ? 200 : 409);
  } finally {
    running = false;
  }
}

export function handlePrimaryRelease(): Response {
  if (!isBootHoldActive()) return answer({ ok: false, code: "not_waiting", error: "this server is not waiting for its nodes" }, 409);
  releaseBootHold();
  console.warn("[primary] the wait for the nodes was ended by hand: this server writes as the primary");
  return answer({ ok: true }, 200);
}
