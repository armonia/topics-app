import { CREATED_BY_HUMAN, parseCreatedBy } from "../../shared/created-by";

/** Default for a board-API caller that is not the interface and names nobody. */
export const API_CALLER_CREATED_BY = "agent:api";

/**
 * Which `created_by` a card gets, from the request that creates it.
 *
 * - The interface marks every call with `X-Topics-Action-Origin: interface`
 *   (`client/src/lib/board.ts`); a card born that way is a person's, and the
 *   body cannot say otherwise.
 * - A direct API caller (an agent token, a script, Jarvis) may name itself with
 *   `createdBy` in the body (`agent:<name>` or `cron:<name>`); a malformed
 *   value is ignored, not an error, because the card matters more than the label.
 * - A direct caller that names nobody is automation by definition (the UI never
 *   arrives unmarked), so it gets `agent:api` instead of an empty field.
 */
export function resolveCreatedBy(req: Request, body: { createdBy?: unknown } | null | undefined): string {
  if (req.headers.get("X-Topics-Action-Origin") === "interface") return CREATED_BY_HUMAN;
  return parseCreatedBy(body?.createdBy) ?? API_CALLER_CREATED_BY;
}
