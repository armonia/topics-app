import type { ToolCall, ToolUserResponse } from '@/types';

/**
 * WHAT A `stream:tool_update` ACTUALLY CHANGES ON THE ROW.
 *
 * For a long time this event meant one thing only: "here is more output".
 * The handler entered exclusively when `typeof partialResult === 'string'`,
 * which was true for the streaming case it was written for.
 *
 * It was also used, by three different server sites, to announce that an
 * answered question had gone back to running - and those three sent no
 * `partialResult`, because there is no output to show. So the announcement was
 * dropped on the floor. The form that had just been submitted stayed grey with
 * a spinner and the word "Invio…", the options stayed disabled, and the row
 * kept its amber "waiting for you" dot, while the new turn scrolled underneath.
 * Reported, in the user's own words:
 * "graficamente le domande restano in invio anche se vanno avanti" // allow-italian: quoted report
 *
 * On the plan branch it was permanent: that panel hangs off a tool the server
 * back-marks at the end of the turn, so no provider will ever emit a
 * `stream:tool_result` for that id. There was no second chance.
 *
 * The two meanings are now separated here, where they can be measured. The
 * partial is a DELTA on the output; the status is a FACT about the row. An
 * event may carry either, both, or neither.
 */

/** The fields a tool-update event is allowed to change. */
export interface ToolUpdatePatch {
  /** Present only when the event announced one. */
  status?: ToolCall['status'];
  /** The answer the person gave, so the row can show it without a reload. */
  userResponse?: ToolUserResponse;
}

/** The shape read off the wire. Loose on purpose: the schema is loose too. */
export interface ToolUpdateEvent {
  toolCallId?: string;
  partialResult?: unknown;
  status?: unknown;
  userResponse?: unknown;
}

const KNOWN_STATUSES = ['pending', 'running', 'success', 'error', 'waiting_for_input', 'awaiting_permission'] as const;

function isKnownStatus(v: unknown): v is ToolCall['status'] {
  return typeof v === 'string' && (KNOWN_STATUSES as readonly string[]).includes(v);
}

/**
 * The patch to apply, or `null` when the event says nothing about the row.
 *
 * An unknown status is REFUSED rather than written through: a typo on the wire
 * would otherwise park the row in a state no renderer knows, which is the same
 * stuck panel by another door.
 */
export function toolUpdatePatch(event: ToolUpdateEvent): ToolUpdatePatch | null {
  if (!event.toolCallId) return null;
  const patch: ToolUpdatePatch = {};
  if (isKnownStatus(event.status)) patch.status = event.status;
  if (event.userResponse !== undefined) patch.userResponse = event.userResponse as ToolUserResponse;
  return Object.keys(patch).length > 0 ? patch : null;
}
