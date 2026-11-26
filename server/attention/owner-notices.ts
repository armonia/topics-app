/**
 * A NOTICE FOR THE OWNER THAT HAS A SUBJECT OF ITS OWN (change
 * lavori-programmati-in-topics, rule R24).
 *
 * A system row has no subject and enters no count: nobody sees it
 * (`system-notices.ts`). The failure of a scheduled job is something the person
 * has to act on, so its row sits under the job's subject (`job:<id>`): it is
 * unseen until read and it shows in the unseen count of the bell, like the row
 * of a chat. It points at no screen (`targetKind` null) and lights no chat.
 * `schedule/deliver/owner-alert.ts` is the door that decides when to write one.
 */
import { recordHistoryRow } from "./store";

export function recordSubjectNotice(n: { subject: string; title: string; body?: string; dedupeKey: string }): void {
  recordHistoryRow({
    kind: "other", title: n.title, body: n.body ?? "", targetKind: null, targetId: null,
    groupKey: n.subject, dedupeKey: n.dedupeKey, source: "push",
  });
}
