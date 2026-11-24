import type { NotificationRecordInput } from "../../shared/notification-log";

/**
 * The history row that tells the person an agent is waiting on a login. The
 * click lands on the topic that owns the tab; one row per tab, so a repeated
 * request for the same page does not stack notices.
 */
export function loginNoticeInput(req: { contextId: string; url: string; topicId?: string }): NotificationRecordInput {
  let host = req.url;
  try { host = new URL(req.url).host || req.url; } catch { /* keep the raw url */ }
  return {
    kind: "other",
    title: `Sign-in needed on ${host}`,
    body: "An agent is waiting for you to sign in. The login tab is open.",
    targetKind: req.topicId ? "topic" : null,
    targetId: req.topicId ?? null,
    dedupeKey: `login-request:${req.contextId}`,
    source: "push",
  };
}
