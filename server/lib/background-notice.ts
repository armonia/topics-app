/**
 * WHAT A CHAT'S BACKGROUND WORK CHANGED, SAID IN THE CHAT.
 *
 * Two things happen to a chat because its closed turn left an agent, a Bash or
 * a Monitor running, and until the verification of 25/09 both were a log line
 * nobody reads:
 *
 *   - a change of autonomy, model or effort waits for the work to end, because
 *     applying it respawns the CLI and the respawn kills the work. Lowering the
 *     autonomy while it waits means the running CLI keeps the permissions the
 *     person just took away, and the person has to know;
 *   - a clock closes the CLI after two hours without news of work still listed
 *     (`BACKGROUND_WORK_CAP_MS`), and the work goes with it.
 *
 * One assistant row with a `background-notice` block, the shape of the goal
 * loop's stop line: the client draws one translated line from the block, the
 * English sentence in `content` is what a reader of the raw transcript sees.
 */

import type { ContentBlock } from "../../shared/types";
import type { AppContext } from "../types";

export type BackgroundNotice = Extract<ContentBlock, { kind: "background-notice" }>;

/**
 * The prefix every notice's text starts with, so a reader that loads rows
 * without their blocks (the dispatcher's mirror of the agent's last words) can
 * still tell the line from the agent's prose.
 */
export const BACKGROUND_NOTICE_PREFIX = "Background work:";

export function backgroundNoticeText(n: BackgroundNotice): string {
  if (n.event === "closed") {
    const why = n.why === "stuck-turn" ? "with a turn that was stuck" : "after two hours without news of it";
    return `${BACKGROUND_NOTICE_PREFIX} closed ${why}: ${n.tasks.join("; ")}.`;
  }
  return `${BACKGROUND_NOTICE_PREFIX} the ${n.change} change applies when the work running in the background ends; until then the running CLI keeps the previous one.`;
}

/**
 * The changes a config route could not apply because the chat's background
 * work runs (`refreshSessionConfig` said `deferred-background`), one line each.
 * Returns the field the route's answer carries, so its caller knows too.
 */
export function noticeOwedChanges(
  ctx: Pick<AppContext, "appendLocalMessage" | "broadcastToAll">,
  topic: { id: string; sessionKey: string },
  outcome: unknown,
  changes: { autonomy?: boolean; model?: boolean; effort?: boolean },
): { pending?: "background-work" } {
  if (outcome !== "deferred-background") return {};
  for (const change of ["autonomy", "model", "effort"] as const) {
    if (changes[change]) postBackgroundNotice(ctx, { sessionKey: topic.sessionKey, topicId: topic.id }, { kind: "background-notice", event: "deferred", change });
  }
  return { pending: "background-work" };
}

/** Write the row and push it to every client. Never throws: a notice is not worth a failed request. */
export function postBackgroundNotice(
  ctx: Pick<AppContext, "appendLocalMessage" | "broadcastToAll">,
  target: { sessionKey: string; topicId: string },
  notice: BackgroundNotice,
): void {
  const text = backgroundNoticeText(notice);
  try {
    const row = ctx.appendLocalMessage(target.sessionKey, "assistant", text, undefined, [notice]);
    ctx.broadcastToAll({
      type: "message:new",
      topicId: target.topicId,
      sessionKey: target.sessionKey,
      role: "assistant",
      messageId: row.id,
      content: text,
      preview: text.slice(0, 100),
      blocks: [notice],
    });
  } catch (err) {
    console.warn(`[background] cannot write the notice for ${target.sessionKey}:`, err);
  }
}
