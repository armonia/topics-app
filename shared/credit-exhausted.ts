/**
 * The API's words when the account has no plan quota and no credits left.
 *
 * It answers 400 `invalid_request_error`, yet nothing in the request is wrong:
 * the same request goes through once a window resets or credits are bought.
 * On 2026-11-21 evening it killed 183 turns in an hour as "API 400", each one
 * waiting for a person to type "resume". Kept narrow on purpose: any other
 * `invalid_request_error` is a real request error and must not be retried.
 *
 * Shared because two readers need the same verdict: the server's retry loop
 * (retry instead of giving up) and the chat banner (say "credit exhausted",
 * not "rate-limited", over a turn that ended this way).
 */
export const CREDIT_EXHAUSTED_RE = /credit balance is too low|purchase (?:more )?credits|plans (?:&|and) billing/i;

/** A 400 that is a spent quota (see `CREDIT_EXHAUSTED_RE`), not a bad request. */
export function isCreditExhausted(status: number, body: string): boolean {
  return status === 400 && CREDIT_EXHAUSTED_RE.test(body);
}
