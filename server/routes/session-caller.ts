/**
 * The session a request to the board's session routes speaks AS, which is not
 * the session its URL names (`lib/session-token.ts`, card cedadfc6). Kept out
 * of `tasks.ts` so the router only asks the question.
 */
import { AGENT_AUTHOR } from "../../shared/comment-author";
import { mintSessionToken, SESSION_TOKEN_HEADER, sessionProof } from "../lib/session-token";
import { topicsHome } from "../services/daemon-state";

type Json = (data: unknown, status?: number) => Response;
type Session = { projectId: string; actor: string; topicId: string | null };

function tokenRefusal(json: Json): Response {
  return json({
    error: "the session token does not belong to this session: an agent can only act as its own session",
    code: "session_token_mismatch",
  }, 403);
}

/**
 * Every write on a session route signs with the returned actor and topic:
 *  - the session's token: the session itself;
 *  - someone else's token: 403, a forged signature is refused, not rewritten;
 *  - no token: an anonymous agent with no topic, so no comment, status row,
 *    step provenance or own-steps carve-out is credited to the topic in the
 *    path. The board scope stays the URL's: that is where, not who.
 */
export function sessionCaller(
  req: Request,
  sessionKey: string,
  resolve: (sessionKey: string) => Session | null,
  json: Json,
): Session | Response {
  const sess = resolve(sessionKey);
  if (!sess) return json({ error: "session is not bound to a project", code: "no_project" }, 400);
  const proof = sessionProof(req, topicsHome(), sessionKey);
  if (proof === "invalid") return tokenRefusal(json);
  if (proof === "absent") return { projectId: sess.projectId, actor: AGENT_AUTHOR, topicId: null };
  return sess;
}

/**
 * The coordinator's cross-board surface is a capability, not a signature: a
 * caller that cannot prove it IS the registered coordinator gets nothing, so
 * here a missing token is a refusal too.
 */
export function coordinatorCaller(
  req: Request,
  sessionKey: string,
  resolve: (sessionKey: string) => { actor: string; topicId: string } | null,
  json: Json,
): { actor: string; topicId: string } | Response {
  const registered = resolve(sessionKey);
  if (!registered) {
    return json({ error: "global orchestrator session required", code: "global_orchestrator_required" }, 403);
  }
  if (sessionProof(req, topicsHome(), sessionKey) !== "valid") return tokenRefusal(json);
  return registered;
}

/**
 * Headers that carry the token of the session named in `pathname`, for a
 * request the server sends on that session's behalf: the delivery it re-issues
 * after the client went away or after a restart. That PATCH was accepted from
 * the session once, so re-sending it is not a new claim. A header already set
 * is kept; a path outside the session routes gets none.
 */
export function withOwnSessionToken(pathname: string, headers?: HeadersInit): HeadersInit | undefined {
  const session = pathname.match(/^\/api\/(?:sessions|orchestrator-sessions)\/([^/?]+)/)?.[1];
  if (!session) return headers;
  const merged = new Headers(headers);
  if (!merged.has(SESSION_TOKEN_HEADER)) {
    merged.set(SESSION_TOKEN_HEADER, mintSessionToken(topicsHome(), decodeURIComponent(session)));
  }
  return merged;
}
