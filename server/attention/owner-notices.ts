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
 *
 * The row alone only reaches the log. What the bell, the Dock and the tray
 * count are lit SUBJECTS, so the failure also ends a turn of the job's subject
 * with an error: the subject is lit until the person sees it (the same
 * `markAttentionSeen` as a chat), and the client groups it with the failures.
 */
import { recordHistoryRow, turnEnded } from "./store";

export function recordSubjectNotice(n: { subject: string; title: string; body?: string; dedupeKey: string; /** False: a row for the log only, nothing lights (a notice that is not a failure). */ lights?: boolean }): void {
  recordHistoryRow({
    kind: "other", title: n.title, body: n.body ?? "", targetKind: null, targetId: null,
    groupKey: n.subject, dedupeKey: n.dedupeKey, source: "push",
  });
  if (n.lights !== false) turnEnded(n.subject, { turnId: n.dedupeKey, outcome: "error", detail: n.title });
}
