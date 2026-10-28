/**
 * WHO OPENED A CARD (`tasks.created_by`, migration 20261028163640).
 *
 * Three shapes, as text: `human` (a person from the interface),
 * `agent:<name>` (an agent or a script calling the API), `cron:<name>` (a
 * schedule). The point is the question the board could not answer on
 * 2026-10-28: whose card is this, and so who has to close it.
 *
 * Only the grammar and the reading live here. WHICH value a request gets is
 * decided by the server (`server/lib/created-by.ts`); the client only parses
 * what arrives, to write "opened by ..." on the card.
 */

export const CREATED_BY_HUMAN = "human";

/**
 * How long a card opened by an agent or a schedule may sit in backlog with
 * nobody on it before the coordinator is told (`task:unowned`). Ten minutes:
 * long enough for whoever opened it to hand it on, short enough that a request
 * that became a card cannot be forgotten for the afternoon (28/10).
 */
export const UNOWNED_BACKLOG_MS = 10 * 60 * 1000;

/** `agent:jarvis`, `cron:scheduled-card`: a kind, a colon, a short slug. */
const CREATED_BY_RE = /^(?:human|(?:agent|cron):[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

/** The value when it is well formed, `null` otherwise (never throws). */
export function parseCreatedBy(value: unknown): string | null {
  return typeof value === "string" && CREATED_BY_RE.test(value.trim()) ? value.trim() : null;
}

export type CreatedByKind = "human" | "agent" | "cron";

export interface CreatedByParts {
  kind: CreatedByKind;
  /** The name after the colon; `null` for `human`. */
  name: string | null;
}

/** `agent:jarvis` -> `{ kind: "agent", name: "jarvis" }`; unknown or empty -> `null`. */
export function splitCreatedBy(value: string | null | undefined): CreatedByParts | null {
  const v = parseCreatedBy(value);
  if (!v) return null;
  if (v === CREATED_BY_HUMAN) return { kind: "human", name: null };
  const i = v.indexOf(":");
  return { kind: v.slice(0, i) as CreatedByKind, name: v.slice(i + 1) };
}
