/**
 * Cleans a string that came from outside (a request body, a handshake): drops
 * every control character and trims. Not a string: `null`. An empty result is
 * `""`; callers that treat "nothing left" as absent use `stripCtrlOrNull`.
 */
export function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // eslint-disable-next-line no-control-regex -- removes control characters from text that came from outside, on purpose
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** `stripCtrl`, with the empty string folded into `null`. */
export function stripCtrlOrNull(input: unknown): string | null {
  return stripCtrl(input) || null;
}
