import { createHmac } from "node:crypto";
import { timingSafeEqualStr } from "../utils";
import { readState } from "../services/daemon-state";

/**
 * A per-session credential: it proves the caller IS the agent of one session.
 *
 * The daemon token proves "one of ours" and nothing more, and on loopback a
 * caller with no credential at all is the owner, so a URL's `:sessionKey` alone
 * said nothing about who was calling. A token derived from the daemon secret AND
 * the session key is useless against any other session: an agent holding its own
 * cannot sign as a sibling topic. The bridge gets it in argv at launch; it is
 * re-derivable on the server, so a restart invalidates nothing.
 */
export const SESSION_TOKEN_HEADER = "x-session-token";

/** Null when the server has no daemon secret yet (unit tests, first boot). */
export function sessionTokenFor(sessionKey: string): string | null {
  try {
    const secret = readState()?.token;
    if (!secret) return null;
    return createHmac("sha256", secret).update(`session:${sessionKey}`).digest("hex");
  } catch {
    return null;
  }
}

export function sessionTokenOk(sessionKey: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = sessionTokenFor(sessionKey);
  return expected !== null && timingSafeEqualStr(presented, expected);
}
