/**
 * A MAIL LEAVES ONCE, EVEN ACROSS A RESTART (agent mail change, rule P8).
 *
 * The send gate (`outbound-gate.ts`) keeps its holds in process memory: that is
 * right for "one question per card at a time" and wrong for "one send per
 * message", because a restart or a lost HTTP answer made the bridge ask again
 * for the same message, and a second yes sent it twice. What makes it once is
 * the delivery register of the schedule engine (`deliveries`, rule R23), used
 * here with its own states and its own boot rule, never a second register:
 *
 *   pending -> delivering -> delivered | delivery_failed | unknown
 *   pending -> not_delivered (the person said no)
 *
 * - The KEY is born in the bridge at every `send_mail` call and rides every leg
 *   and every retry of that call. It is not a digest of the content: the same
 *   message wanted twice is two calls, two questions, two mails.
 * - The question is a `pending` row holding the message. After a restart a
 *   press of the confirm label on that question reaches `answerPendingMailFromThread`,
 *   and the server sends from the row.
 * - `delivering` is written before the CLI starts. A row found `delivering`
 *   when the server starts again becomes `unknown`, is never sent again by
 *   itself, and the card is told.
 */
import type { Database } from "bun:sqlite";
import { createDeliveryRegistry, type DeliveryRegistry } from "../schedule/deliver/registry";
import type { FrozenAttachments } from "./outbound-staging";

export const MAIL_DELIVERY_KIND = "mail";

/** Letters, digits and dashes, bounded: the key is an identity, not a place to carry text. */
const CALL_KEY = /^[A-Za-z0-9-]{8,80}$/;

/** The register key of one `send_mail` call, or null when the caller sent none (an older bridge). */
export function mailDeliveryKey(value: unknown): string | null {
  return typeof value === "string" && CALL_KEY.test(value) ? `mail:${value}` : null;
}

/** What a `pending` row holds until its outcome: everything the server needs to send it alone. */
export interface MailPayload {
  sessionKey: string;
  account: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  frozen: FrozenAttachments;
  /** The thread row of the question, once the card road drew it. */
  askId?: string;
  /** The chat row of the question, once the chat road painted it. */
  toolCallId?: string;
  /** Set once the card was told that this send ended `unknown`. */
  announced?: boolean;
}

/** What `delivered` keeps in `detail`, so a retry of the same key gets the same answer. */
export interface MailSentRecord {
  account: string;
  to: string;
  subject: string;
  traced: boolean;
  messageId?: string;
}

/**
 * The message id the adapter printed, when it printed one. `gws +send` answers
 * the Gmail resource (`{"id": ...}`); other adapters may say `messageId`.
 */
export function messageIdOf(stdout: string): string | undefined {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>;
    const found = parsed.messageId ?? parsed.message_id ?? parsed.id;
    return typeof found === "string" && found.trim() ? found.trim().slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

export interface MailLedger {
  registry: DeliveryRegistry;
  /** The `pending` row whose question is the thread row `askId`, if any. */
  pendingByAsk(askId: string): string | null;
  /** The `pending` row whose question is painted on the chat row `toolCallId` of this session, if any. */
  pendingByToolCall(sessionKey: string, toolCallId: string): string | null;
  /** True when a row for that chat row exists in any state but `pending`: the message was already settled. */
  settledByToolCall(sessionKey: string, toolCallId: string): boolean;
  /**
   * Boot, for the mail rows: what was mid-send becomes `unknown` (the same rule
   * the register applies), and every `unknown` mail the card was not told about
   * yet is returned once, marked as told.
   */
  recoverAtBoot(): Array<{ key: string; payload: MailPayload }>;
}

export function createMailLedger(db: Database, now: () => Date = () => new Date()): MailLedger {
  const registry = createDeliveryRegistry(db, now);
  return {
    registry,
    pendingByAsk(askId) {
      const row = db.query("SELECT key FROM deliveries WHERE kind = ? AND state = 'pending' AND json_extract(payload_json, '$.askId') = ? LIMIT 1")
        .get(MAIL_DELIVERY_KIND, askId) as { key: string } | null;
      return row?.key ?? null;
    },
    pendingByToolCall(sessionKey, toolCallId) {
      const row = db.query("SELECT key FROM deliveries WHERE kind = ? AND state = 'pending' AND json_extract(payload_json, '$.toolCallId') = ? AND json_extract(payload_json, '$.sessionKey') = ? LIMIT 1")
        .get(MAIL_DELIVERY_KIND, toolCallId, sessionKey) as { key: string } | null;
      return row?.key ?? null;
    },
    settledByToolCall(sessionKey, toolCallId) {
      const row = db.query("SELECT key FROM deliveries WHERE kind = ? AND state != 'pending' AND json_extract(payload_json, '$.toolCallId') = ? AND json_extract(payload_json, '$.sessionKey') = ? LIMIT 1")
        .get(MAIL_DELIVERY_KIND, toolCallId, sessionKey) as { key: string } | null;
      return row !== null;
    },
    recoverAtBoot() {
      // Order free with the engine's own boot step: whichever runs first turns
      // `delivering` into `unknown`, and the "told" mark lives in the row.
      registry.recoverAtBoot();
      const rows = db.query("SELECT key, payload_json FROM deliveries WHERE kind = ? AND state = 'unknown' AND payload_json IS NOT NULL AND json_extract(payload_json, '$.announced') IS NULL")
        .all(MAIL_DELIVERY_KIND) as Array<{ key: string; payload_json: string }>;
      const told: Array<{ key: string; payload: MailPayload }> = [];
      for (const row of rows) {
        const changed = db.prepare("UPDATE deliveries SET payload_json = json_set(payload_json, '$.announced', json('true')), updated_at = ? WHERE key = ? AND json_extract(payload_json, '$.announced') IS NULL")
          .run(now().toISOString(), row.key).changes;
        if (changed === 1) told.push({ key: row.key, payload: JSON.parse(row.payload_json) as MailPayload });
      }
      return told;
    },
  };
}

/**
 * THE ANSWER THAT ARRIVES WITH NOBODY WAITING. The board thread calls this when
 * a quick reply names a question that has no live rendez-vous: after a restart,
 * or once the agent stopped polling. The outbound router registers the handler,
 * because it owns the CLI, the roster and the trace on the card.
 */
type PendingMailAnswer = (askId: string, text: string) => boolean;
let pendingMailAnswer: PendingMailAnswer | null = null;

export function registerPendingMailAnswer(handler: PendingMailAnswer | null): void {
  pendingMailAnswer = handler;
}

/** True when the answer was about a mail still waiting: the caller must not treat it as an ordinary comment. */
export function answerPendingMailFromThread(askId: string | undefined, text: string): boolean {
  if (!askId || !pendingMailAnswer) return false;
  try {
    return pendingMailAnswer(askId, text);
  } catch (error) {
    console.warn("[outbound] answer to a pending mail failed:", error);
    return false;
  }
}

/** Same as the thread answer, for the chat panel: the click names the row it was painted on. */
type PendingMailChatAnswer = (sessionKey: string, toolCallId: string, text: string) => boolean;
let pendingMailChatAnswer: PendingMailChatAnswer | null = null;
let settledMailChatLookup: ((sessionKey: string, toolCallId: string) => boolean) | null = null;

export function registerPendingMailChatAnswer(handler: PendingMailChatAnswer | null, settled: ((sessionKey: string, toolCallId: string) => boolean) | null = null): void {
  pendingMailChatAnswer = handler;
  settledMailChatLookup = settled;
}

/** True when the panel's message already left the `pending` state (sent, refused, failed): a late click must touch nothing. */
export function mailChatAlreadySettled(sessionKey: string, toolCallId: string): boolean {
  if (!settledMailChatLookup) return false;
  try {
    return settledMailChatLookup(sessionKey, toolCallId);
  } catch {
    return false;
  }
}

/** True when the click was about a mail still waiting: the route must not queue it as a message. */
export function answerPendingMailFromChat(sessionKey: string, toolCallId: string, text: string): boolean {
  if (!pendingMailChatAnswer) return false;
  try {
    return pendingMailChatAnswer(sessionKey, toolCallId, text);
  } catch (error) {
    console.warn("[outbound] chat answer to a pending mail failed:", error);
    return false;
  }
}
