import { API_CALLER_CREATED_BY, parseCreatedBy, CREATED_BY_HUMAN } from "../../shared/created-by";
import { AUTO_PROJECT_ID, UNASSIGNED_PROJECT_ID } from "../services/tasks";

/** Shortest description that can carry a context: a title restated is not one. */
export const MIN_CONTEXT_CHARS = 40;

/** `BARRA:` / `BAR:` / `ACCEPTANCE:` at the start of a line of the description. */
const BAR_LINE_RE = /^\s*(?:barra|bar|acceptance)\s*:\s*\S/im;

export interface AgentCardInput {
  createdBy: unknown;
  description: unknown;
  /** The executable bar, when sent as its own field. */
  bar: unknown;
  /** Where the request came from: a session or a channel, free text. */
  source: unknown;
  /** The chat the card was asked in, when the caller knows it. */
  originTopicId: unknown;
  projectId: string;
  /** A checklist step: its parent carries the bar and the folder. */
  isStep?: boolean;
}

/**
 * What a card opened by an AGENT must carry to be finished without anyone
 * asking: who it is, where the request came from, the context, the folder
 * (a real board, because an agent needs a cwd) and a bar it can run.
 * Returns the missing pieces, empty when the card is complete. Nothing is
 * refused: external callers (scripts, the gateway) still send bare cards, so
 * an incomplete one is born with the list written on it (`createdMissing`)
 * until they are updated and the refusal can turn on.
 */
export function missingForAgentCard(i: AgentCardInput): string[] {
  const missing: string[] = [];
  const who = parseCreatedBy(i.createdBy);
  if (!who || who === CREATED_BY_HUMAN || who === API_CALLER_CREATED_BY) {
    missing.push("createdBy: name yourself as agent:<name> (or cron:<name>), not the anonymous agent:api");
  }
  const hasSource = (typeof i.source === "string" && i.source.trim()) || (typeof i.originTopicId === "string" && i.originTopicId.trim());
  if (!hasSource) missing.push("source: the session or channel the request came from (or originTopicId, the chat to link back to)");
  const descriptionText = typeof i.description === "string" ? i.description.trim() : "";
  if (descriptionText.length < MIN_CONTEXT_CHARS) missing.push(`description: the context, at least ${MIN_CONTEXT_CHARS} characters`);
  if (!i.isStep && (i.projectId === AUTO_PROJECT_ID || i.projectId === UNASSIGNED_PROJECT_ID)) {
    missing.push("board: a real board (its folder), not auto or unassigned");
  }
  const hasBar = (typeof i.bar === "string" && i.bar.trim()) || BAR_LINE_RE.test(descriptionText);
  if (!hasBar && !i.isStep) missing.push("bar: an executable bar (field `bar`, or a `BARRA:` line in the description)");
  return missing;
}

/**
 * The e2e server is seeded by ~90 specs that open bare cards through the API
 * as fixtures; they are not agents. There the contract is off unless the
 * request asks for it with `X-Topics-Enforce-Card-Contract: 1` (the spec that
 * proves the contract does). Everywhere else it always applies.
 */
export function isContractEnforced(req: Request): boolean {
  return process.env.TOPICS_E2E !== "1" || req.headers.get("X-Topics-Enforce-Card-Contract") === "1";
}

/** `BARRA:` and `ORIGINE:` lines appended to the description when the caller sent them as fields. */
export function withContractLines(description: string | null, bar: unknown, source: unknown): string | null {
  const extra: string[] = [];
  if (typeof bar === "string" && bar.trim() && !BAR_LINE_RE.test(description ?? "")) extra.push(`BARRA: ${bar.trim()}`);
  if (typeof source === "string" && source.trim()) extra.push(`ORIGINE: ${source.trim()}`);
  return extra.length ? `${description ?? ""}\n\n${extra.join("\n")}`.trim() : description;
}
