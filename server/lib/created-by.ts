import { API_CALLER_CREATED_BY, CREATED_BY_HUMAN, parseCreatedBy } from "../../shared/created-by";
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
  if (!agentAuthOk(req) && req.headers.get("X-Topics-Action-Origin") === "interface") return CREATED_BY_HUMAN;
  // The body can name an agent or a schedule, never a person: «human» is
  // reserved to the interface branch above.
  const named = parseCreatedBy(body?.createdBy);
  return named && named !== CREATED_BY_HUMAN ? named : API_CALLER_CREATED_BY;
}
