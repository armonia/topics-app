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
  if (named && named !== CREATED_BY_HUMAN) return named;
  return callerFallbackName(req) ?? API_CALLER_CREATED_BY;
}

/**
 * A caller that names nobody still leaves a readable trace: the
 * `X-Topics-Agent` header, else the product token of its User-Agent
 * (`board-card/1.2` -> `agent:board-card`). Browsers and bare runtimes say
 * nothing useful and stay anonymous.
 */
function callerFallbackName(req: Request): string | null {
  const slug = (v: string | null): string | null => {
    const t = (v ?? "").trim().split(/[\s/]/)[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    return t && !/^(mozilla|node|bun|undici|axios|python-requests|python-urllib|curl|go-http-client|okhttp)$/.test(t)
      ? parseCreatedBy(`agent:${t}`) : null;
  };
  return slug(req.headers.get("X-Topics-Agent")) ?? slug(req.headers.get("User-Agent"));
}
