import { timingSafeEqualStr } from "../utils";
import { readState } from "../services/daemon-state";

/** Hard-gate the /agents/* routes and the raw terminal send/buffer routes.
 *  spawn_agent launches `claude --dangerously-skip-permissions` with a
 *  caller-supplied prompt — arbitrary code execution — and the server binds
 *  0.0.0.0, so an UNGUARDED route would be unauthenticated RCE for any LAN
 *  peer / local process.
 *
 *  One credential is accepted:
 *   - The DAEMON token (`Authorization: Bearer <64-hex>` or `X-Daemon-Token`),
 *      the same 32-byte secret `~/.topics/daemon-state.json` hands to
 *      `/__daemon/*` — the PRIMARY path. It is Topics' own credential: written
 *      by the running server, readable only by the user who owns the file, and
 *      re-read on every call so a rotation takes effect at once.
 *      It replaced the old per-agent `X-Agent-Token` (a pbkdf2 hash column on
 *      `agent_profiles`) when the named-agent roster was removed: nothing could
 *      mint one any more, so keeping it would have been a gate with no key.
 *  The old shared gateway token (`x-gateway-token`) no longer opens
 *  anything: the gateway is off and the MCP bridge sends the daemon token.
 *
 *  The ownership guard on send/read/stop is defence-in-depth ON TOP of this,
 *  never instead of it.
 *
 *  It lives in a lib and not inside the terminal route because the same
 *  question ("is this an agent of ours, or a paired device?") is now asked by
 *  every route that writes into the project allowlist
 *  (`server/lib/client-project-path.ts`). A second copy of a credential check
 *  is a second place to forget a rotation.
 */
export function agentAuthOk(req: Request): boolean {
  // Native daemon auth (Topics-owned). Read fresh so a rotated state file
  // applies immediately, exactly like the /__daemon/* gate in server.ts.
  try {
    const state = readState();
    if (state?.token) {
      const bearer = req.headers.get("authorization")?.match(/^Bearer\s+([0-9a-f]{64})$/i)?.[1] ?? "";
      const header = req.headers.get("x-daemon-token") || "";
      if (timingSafeEqualStr(bearer, state.token) || timingSafeEqualStr(header, state.token)) return true;
    }
  } catch {}
  return false;
}
