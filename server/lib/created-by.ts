import { API_CALLER_CREATED_BY, CREATED_BY_HUMAN, parseCreatedBy } from "../../shared/created-by";
import { AGENT_AUTHOR } from "../../shared/comment-author";
import type { Database } from "bun:sqlite";
import { agentAuthOk } from "./agent-auth";

/**
 * Which `created_by` a card gets, from the request that creates it.
 *
 * - A caller that presents an agent credential (the daemon token or the gateway
 *   token, `agentAuthOk`) is automation, always: `X-Topics-Action-Origin` is a
 *   header the client picks, so on its own it proves nothing, and an agent that
 *   sends it must not be able to pass for a person (the card would read «opened
 *   by you» and escape the unowned-backlog sweep).
 * - Without a credential, the interface marks every call with
 *   `X-Topics-Action-Origin: interface` (`client/src/lib/board.ts`); a card born
 *   that way is a person's, and the body cannot say otherwise. The interface
 *   (browser, paired device) never carries the daemon token.
 * - Anyone else may name themselves with `createdBy` in the body (`agent:<name>`
 *   or `cron:<name>`, never `human`); a malformed value is ignored, not an error, because the
 *   card matters more than the label.
 * - A caller that names nobody is automation by definition (the UI never
 *   arrives unmarked), so it gets `agent:api` instead of an empty field.
 */
export function resolveCreatedBy(req: Request, body: { createdBy?: unknown } | null | undefined): string {
  if (isInterfaceRequest(req)) return CREATED_BY_HUMAN;
  // The body can name an agent or a schedule, never a person: «human» is
  // reserved to the interface branch above.
  const named = parseCreatedBy(body?.createdBy) ?? parseCreatedBy(headerName(req));
  return named && named !== CREATED_BY_HUMAN ? named : API_CALLER_CREATED_BY;
}

/**
 * Did this request come from the interface? It carries the interface mark and
 * no agent credential: an agent that sends the mark with its daemon token is
 * still an agent (see `resolveCreatedBy` above).
 */
export function isInterfaceRequest(req: Request): boolean {
  return !agentAuthOk(req) && req.headers.get("X-Topics-Action-Origin") === "interface";
}

/**
 * A caller may name itself in a header (`X-Topics-Agent: <name>`) instead of
 * the body: a script that cannot change its payload still gets a readable name.
 */
function headerName(req: Request): string | null {
  const raw = req.headers.get("X-Topics-Agent")?.trim();
  return raw ? `agent:${raw}` : null;
}

/**
 * Who actually spoke, for a comment/status row's `author`/`by` — the free-text
 * identity `shared/comment-author.ts` reads, not `created_by`'s coarse
 * human/agent/cron grammar.
 *
 * Only an interface request signs as the project owner. Everything else —
 * a script hitting `/api/boards/...` directly, with or without a daemon
 * token — is automation: named when it declares itself with `X-Topics-Agent`,
 * the generic `agent` label otherwise. Without this, a caller that never
 * identifies itself still fell through to the human board route's hardcoded
 * `author: "user"`, so a comment from a script or another installation's
 * orchestrator read as the owner's own words.
 */
export function resolveBoardActor(req: Request): string {
  // "user" is the reserved role `shared/comment-author.ts` renders as the
  // owner — a different vocabulary from `created_by`'s "human" above, kept
  // deliberately separate rather than unified into one constant.
  if (isInterfaceRequest(req)) return "user";
  const named = req.headers.get("X-Topics-Agent")?.trim();
  return named || AGENT_AUTHOR;
}

/**
 * Where a card was opened from, as the caller declares it: `source` in the
 * body (or `createdSource`), else the `X-Topics-Source` header. Free text,
 * trimmed and bounded; a person's card from the interface carries none.
 */
export function resolveCreatedSource(req: Request, body: Record<string, unknown> | null | undefined): string | null {
  const raw = body?.source ?? body?.createdSource ?? req.headers.get("X-Topics-Source");
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 160) : null;
}

/** The id when it names an existing chat, else `null` (a ghost id would open a ghost tab). */
export function knownTopicId(db: Database, value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return db.prepare("SELECT 1 FROM topics WHERE id = ?").get(value.trim()) ? value.trim() : null; }
  catch { return null; }
}
