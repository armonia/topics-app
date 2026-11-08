/**
 * Control-character stripper for text that came from outside (request bodies).
 * One copy: four routes had their own and one of them disagreed on the empty
 * string.
 */

/** Non-strings are `null`; otherwise the text without control characters, trimmed (maybe `""`). */
export function stripCtrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  // eslint-disable-next-line no-control-regex -- removes control characters from text that came from outside, on purpose
  return input.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/** Same, but an empty result is `null` too: "nothing usable was sent". */
export function stripCtrlOrNull(input: unknown): string | null {
  return stripCtrl(input) || null;
}
