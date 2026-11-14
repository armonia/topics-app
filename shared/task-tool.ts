/**
 * WHICH TOOL CALLS ARE A CARD OF THE BOARD, and which card each one means.
 *
 * A chat that creates, moves, comments on, sends back or lands a card used to
 * show raw tool rows. The transcript draws a card instead (`TaskToolCard`),
 * and the waiting line and the sidebar follow the same card by its id. All of
 * them read the call through this one function, so the list of tools lives in
 * one place. Pure: no store, no network, safe on the server and in the client.
 */

export const TASK_TOOL_NAMES = [
  "create_task", "update_task", "comment_task", "get_task",
  "board_create", "board_status", "board_review", "board_comment", "board_land",
] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

/** What the call did to the card, in this turn. */
export type TaskToolAction =
  | "created" | "moved" | "delivered" | "resent" | "closed" | "landed" | "commented" | "read" | "reviewed";

export interface TaskToolCall {
  tool: TaskToolName;
  action: TaskToolAction;
  /** The card the call is about, when the arguments or the answer name it. */
  taskId?: string;
  /** Why it was sent back, when the call carries a reason. */
  reason?: string;
}

const TOOL_SET: ReadonlySet<string> = new Set(TASK_TOOL_NAMES);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The tool's own name out of whatever the runtime made of it: bare
 * (`create_task`), prefixed by the CLI (`mcp__topics__create_task`) or reached
 * through the gateway (`mcp__gateway__topics_board__board_create`). Only the
 * last segment decides, so a different server's `create_task` is not told
 * apart: the card it would draw simply finds no card with that id.
 */
export function taskToolName(name: string): TaskToolName | null {
  const last = (name || "").trim().split("__").pop()?.trim().toLowerCase() ?? "";
  return TOOL_SET.has(last) ? (last as TaskToolName) : null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The id of the card, from the arguments first and from the answer when the call is the one that made it. */
export function taskIdOf(args: Record<string, unknown> | undefined, result: string | undefined): string | undefined {
  const a = args ?? {};
  const fromArgs = str(a.task_id) ?? str(a.taskId) ?? str(a.id) ?? str(a.card_id) ?? str(a.cardId);
  if (fromArgs) return fromArgs;
  if (!result) return undefined;
  // `created task <id> [todo]: …` and `[status] title (id=<id> …)` are the two
  // sentences of the Topics tools; a JSON answer carries `"id":"<id>"`.
  const named = /(?:created task|\bid=|"(?:task_?id|id)"\s*:\s*")\s*([0-9a-z][0-9a-z-]{5,})/i.exec(result);
  if (named?.[1]) return named[1];
  return UUID.exec(result)?.[0];
}

function actionOf(tool: TaskToolName, a: Record<string, unknown>): TaskToolAction {
  switch (tool) {
    case "create_task": case "board_create": return "created";
    case "comment_task": case "board_comment": return "commented";
    case "get_task": case "board_status": return "read";
    case "board_land": return "landed";
    case "board_review": {
      const verdict = (str(a.decision) ?? str(a.action) ?? str(a.verdict) ?? "").toLowerCase();
      return /reject|resend|back|rework|retry/.test(verdict) ? "resent" : "reviewed";
    }
    case "update_task": {
      const status = (str(a.status) ?? "").toLowerCase();
      if (status === "todo" || status === "in_progress") return "resent";
      if (status === "review") return "delivered";
      if (status === "done") return "closed";
      return "moved";
    }
  }
}

/** `null` when the call is not a card tool. */
export function taskToolCall(name: string, args: Record<string, unknown> | undefined, result: string | undefined): TaskToolCall | null {
  const tool = taskToolName(name);
  if (!tool) return null;
  const a = args ?? {};
  const action = actionOf(tool, a);
  const taskId = taskIdOf(args, result);
  const reason = action === "resent" ? str(a.reason) ?? str(a.comment) ?? str(a.feedback) ?? str(a.note) ?? str(a.message) : undefined;
  return { tool, action, ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}) };
}

/** The calls whose card the chat is now waiting on: one it made or sent back to work. */
export function taskToolStartsWait(call: TaskToolCall): boolean {
  return call.action === "created" || call.action === "resent";
}
