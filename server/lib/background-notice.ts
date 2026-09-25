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
 *   - a clock closes the CLI with work still listed, and the work goes with it.
 *
 * -- A service row, the shape of `machine-stop` (lib/machine-stop-notice.ts) --
 * One assistant row whose `content` is EMPTY and whose only block is a
 * `background-notice`, drawn by the client as a service line. Empty on
 * purpose, because every reader that must not see it reads `content` alone:
 * the model's history (the claude-code recap, the native rehydrate, the API
 * providers) and the dispatcher's "last words of the agent". The second review
 * of 25/09 found the sentence in all three, and the row taken for the chat's
 * last word: the resume sweep and the client read the LAST row, so a notice
 * written under a cut turn hid it (`ripresa-boot.ts`, `lastConversationMessage`
 * on the client look past it now). The block carries `text` for clients older
 * than it, which print an unknown block as prose.
 */

import type { ContentBlock } from "../../shared/types";
import type { AppContext } from "../types";

export type BackgroundNotice = Extract<ContentBlock, { kind: "background-notice" }>;
/** A notice before its sentence is written in (`text`, for older clients). */
export type BackgroundNoticeFacts = BackgroundNotice extends infer N ? (N extends BackgroundNotice ? Omit<N, "text"> : never) : never;
type NoticeCtx = Pick<AppContext, "appendLocalMessage" | "broadcastToAll" | "isStreaming">;
export type OwedChange = "autonomy" | "model" | "effort";

/** Is this row a background notice and nothing else, blocks as parsed JSON? */
export function isBackgroundNoticeRow(blocks: readonly { kind?: unknown }[] | null | undefined): boolean {
  return Array.isArray(blocks) && blocks.length > 0 && blocks.every((b) => b?.kind === "background-notice");
}

const CLOSED_WHY: Record<NonNullable<Extract<BackgroundNoticeFacts, { event: "closed" }>["why"]>, string> = {
  "silent": "after two hours without news of it",
  "stuck-turn": "with a turn that was stuck",
  "deadline": "when the delegation reached its maximum duration",
  "superseded": "with the card's turn, superseded",
};

export function backgroundNoticeText(n: BackgroundNoticeFacts): string {
  if (n.event === "closed") return `Background work closed ${CLOSED_WHY[n.why ?? "silent"]}: ${n.tasks.join("; ")}.`;
  return `The ${n.change} change applies from the first message after the background work ends; until then the running CLI keeps the previous one. Stop ends that work now.`;
}

/**
 * The changes a config route could not apply because the chat's background
 * work runs (`refreshSessionConfig` said `deferred-background`), one line each.
 * Returns the field the route's answer carries, so its caller knows too.
 */
export function noticeOwedChanges(
  ctx: NoticeCtx,
  topic: { id: string; sessionKey: string },
  outcome: unknown,
  changes: Partial<Record<OwedChange, boolean>>,
): { pending?: "background-work" } {
  if (outcome !== "deferred-background") return {};
  for (const change of ["autonomy", "model", "effort"] as const) {
    if (changes[change]) postBackgroundNotice(ctx, { sessionKey: topic.sessionKey, topicId: topic.id }, { kind: "background-notice", event: "deferred", change });
  }
  return { pending: "background-work" };
}

/** How long a notice waits for the session's open turn to close before it is written anyway. */
const NOTICE_WAIT_CAP_MS = 30 * 60_000;

/**
 * Write the row and push it to every client. Never throws: a notice is not
 * worth a failed request.
 *
 * Not under a turn still open: the row would hang from that turn's placeholder,
 * and a turn that ends empty (the stall judge recycling a silent one) is only
 * discarded when nothing hangs from it, so it stayed as an empty bubble. The
 * notice waits for the turn to close and follows it.
 */
export function postBackgroundNotice(
  ctx: NoticeCtx,
  target: { sessionKey: string; topicId: string },
  facts: BackgroundNoticeFacts,
  waitedMs = 0,
): void {
  if (ctx.isStreaming(target.sessionKey) && waitedMs < NOTICE_WAIT_CAP_MS) {
    const t = setTimeout(() => postBackgroundNotice(ctx, target, facts, waitedMs + 500), 500);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  const notice = { ...facts, text: backgroundNoticeText(facts) } as BackgroundNotice;
  try {
    const row = ctx.appendLocalMessage(target.sessionKey, "assistant", "", undefined, [notice]);
    // The live handler drops a `message:new` without text: the frame carries
    // the sentence a client falls back to, and the block is what it draws.
    ctx.broadcastToAll({
      type: "message:new", topicId: target.topicId, sessionKey: target.sessionKey, role: "assistant",
      messageId: row.id, content: notice.text, preview: "", blocks: [notice],
    });
  } catch (err) {
    console.warn(`[background] cannot write the notice for ${target.sessionKey}:`, err);
  }
}
