/**
 * Canonical internal-marker grammar — the single source of truth (server side).
 *
 * Internal markers are invisible control tokens the assistant emits to drive
 * app behaviour: browser navigation (`{{BROWSER:url}}`), topic switching/
 * creation (`{{TOPIC_SWITCH:id}}`, `{{TOPIC_NEW:title}}`) and project open/
 * create (`{{PROJECT_OPEN:name}}`, `{{PROJECT_CREATE:name}}`). They MUST never
 * reach the model (replayed provider history) nor the visible UI.
 *
 * This mirrors the client stripper `cleanInvisibleMarkers` in
 * `client/src/hooks/useChat.ts`. Keep the two in sync: adding a marker family
 * in one place but not the other reintroduces a leak.
 *
 * Why this module exists: the grammar was previously reimplemented in
 * `routes/topics.ts`, `utils/build-provider-history.ts` and `context/
 * assemble.ts` with DIVERGENT coverage — the two history pipelines stripped
 * only BROWSER/TOPIC_SWITCH/TOPIC_NEW and silently leaked
 * `{{PROJECT_CREATE:…}}` / `{{PROJECT_OPEN:…}}` back into the provider context,
 * contradicting the system prompt (AUDIT-2026-06-19.md, priority #4).
 */

/** The internal-marker family names, as a regex alternation group. */
export const MARKER_NAMES_GROUP =
  "(?:TOPIC_SWITCH|TOPIC_NEW|BROWSER|PROJECT_CREATE|PROJECT_OPEN)";

/** Matches a fully-formed marker `{{NAME:body}}` anywhere in a string. */
export const CLOSED_MARKER_REGEX = new RegExp(
  `\\{\\{${MARKER_NAMES_GROUP}:[^}]*\\}\\}`,
  "g",
);

/**
 * Matches an UNCLOSED marker tail `…{{NAME:partial` at end-of-string. Defends
 * the chunk-split case where a closing `}}` lands in a later streamed delta,
 * so a partial marker is never broadcast or replayed.
 */
export const OPEN_MARKER_TAIL_REGEX = new RegExp(
  `\\{\\{${MARKER_NAMES_GROUP}:[^}]*$`,
);

/**
 * Strip every internal marker from `content`: closed markers anywhere, plus a
 * single unclosed tail at end-of-string. Does NOT trim — callers decide whether
 * to collapse the surrounding whitespace.
 */
export function stripMarkers(content: string): string {
  return content
    .replace(CLOSED_MARKER_REGEX, "")
    .replace(OPEN_MARKER_TAIL_REGEX, "");
}

/**
 * Return the closed markers present in `content`, trimmed, in document order.
 * Used for diagnostics (which markers were stripped from a turn). Unclosed
 * tails are intentionally not reported — they are not yet real markers.
 */
export function detectMarkers(content: string): string[] {
  const matches = content.match(CLOSED_MARKER_REGEX);
  return matches ? matches.map((m) => m.trim()) : [];
}
