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

/**
 * Does an autonomy change wait for the chat's background work? A lowering does
 * (the running CLI would keep the permissions just taken away), and so does a
 * raise out of `ask` (plan mode stays until the respawn). auto-apply to yolo
 * applies live through the permission bridge (`sessionIsFree`).
 */
export function autonomyChangeOwed(prev: string | null | undefined, next: string | null | undefined): boolean {
  const order = ["ask", "auto-apply", "yolo"];
  const from = prev ?? "ask";
  return order.indexOf(next ?? "ask") < order.indexOf(from) || from === "ask";
}

/**
 * The changes a PATCH made that the chat's background work may make wait,
 * from the topic as it was before the PATCH and as it is now.
 */
export function owedChangesOf(
  before: { autonomy?: string | null; model?: string | null },
  topic: { autonomyLevel?: string | null; model?: string | null },
  effortChanged: boolean,
): Partial<Record<OwedChange, boolean>> {
  return {
    autonomy: before.autonomy !== topic.autonomyLevel && autonomyChangeOwed(before.autonomy, topic.autonomyLevel),
    model: (before.model ?? null) !== (topic.model ?? null),
    effort: effortChanged,
  };
}

/**
 * Apply a spawn-time change to the chat's CLI, and say in the chat the ones its
 * background work makes wait. Never throws: the change is saved either way, and
 * the next natural respawn applies it.
 */
export function refreshAndSay(
  ctx: NoticeCtx,
  provider: () => { refreshSessionConfig?: (sessionKey: string, owed?: OwedChange[]) => unknown },
  topic: { id: string; sessionKey: string },
  owed: Partial<Record<OwedChange, boolean>>,
): { pending?: "background-work" } {
  let outcome: unknown;
  try { outcome = provider().refreshSessionConfig?.(topic.sessionKey, (Object.keys(owed) as OwedChange[]).filter((c) => owed[c])); }
  catch (err) { console.warn(`[topics] refreshSessionConfig failed for ${topic.sessionKey}:`, err); }
  return noticeOwedChanges(ctx, topic, outcome, owed);
}

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
 * The closed-work notices waiting for their turn to close, by session. When the
 * machine stopped that turn empty, its `machine-stop` line takes them into its
 * own row (`takeClosedNotices`): a stop and the work it closed are one event,
 * and two service rows under the envelope read as two.
 */
const pendingClosed = new Map<string, BackgroundNotice[]>();

/** Take this session's closed-work notices still waiting, so no other row repeats them. */
export function takeClosedNotices(sessionKey: string): BackgroundNotice[] {
  const taken = pendingClosed.get(sessionKey) ?? [];
  pendingClosed.delete(sessionKey);
  return taken;
}

/**
 * Write the row and push it to every client. Never throws: a notice is not
 * worth a failed request.
 *
 * Not under a turn still open: the row would hang from that turn's placeholder,
 * and a turn that ends empty (the stall judge recycling a silent one) is only
 * discarded when nothing hangs from it, so it stayed as an empty bubble. The
 * notice waits for the turn to close and follows it, unless that turn's stop
 * line took it first.
 */
export function postBackgroundNotice(ctx: NoticeCtx, target: { sessionKey: string; topicId: string }, facts: BackgroundNoticeFacts): void {
  const notice = { ...facts, text: backgroundNoticeText(facts) } as BackgroundNotice;
  if (notice.event === "closed") pendingClosed.set(target.sessionKey, [...(pendingClosed.get(target.sessionKey) ?? []), notice]);
  writeWhenTurnCloses(ctx, target, notice, 0);
}

function writeWhenTurnCloses(ctx: NoticeCtx, target: { sessionKey: string; topicId: string }, notice: BackgroundNotice, waitedMs: number): void {
  if (ctx.isStreaming(target.sessionKey) && waitedMs < NOTICE_WAIT_CAP_MS) {
    const t = setTimeout(() => writeWhenTurnCloses(ctx, target, notice, waitedMs + 500), 500);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  if (notice.event === "closed") {
    const waiting = pendingClosed.get(target.sessionKey) ?? [];
    if (!waiting.includes(notice)) return; // the stop's line took it
    const rest = waiting.filter((n) => n !== notice);
    if (rest.length) pendingClosed.set(target.sessionKey, rest);
    else pendingClosed.delete(target.sessionKey);
  }
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
