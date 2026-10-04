/**
 * INFRASTRUCTURE NOTICES ARE THE SYSTEM'S, NOT A CHAT'S
 * (notifications-redesign, design section 10.4, ATTN-10; defect D5).
 *
 * A swap freeze of a background command, a restart held by a turn at work and
 * a worktree folder the GC cannot remove used to file their history rows on
 * the chat that owned the command, as `session` rows of `topic:<id>`: the
 * chat counted on the bell and the Dock for a fact about the Mac. Here they
 * are rows of kind `system`, under a subject of their own (`system:<key>`),
 * with no target: they light no subject and enter no count.
 *
 * One row per CYCLE: the thaw rewrites the row of its freeze instead of adding
 * a second one. No frame carries these rows: having no subject, they reach the
 * inbox's «History» tab at its next open, which reads the log again.
 */
import { recordNotificationRow } from "../notification-registry";
import { updateNotificationByDedupeKey } from "../db/notification-log";
import { systemSubject } from "../../shared/attention";

/** The cycle each key has open: its first row's dedupe key, which the close rewrites. */
const openCycles = new Map<string, string>();

/** A one-off system notice (a held restart, a folder the GC cannot remove). One row per `cycle`. */
export function recordSystemNotice(n: { key: string; cycle: string; title: string; body?: string }): void {
  const dedupeKey = `system:${n.key}:${n.cycle}`;
  if (updateNotificationByDedupeKey(dedupeKey, { title: n.title, body: n.body })) return;
  recordNotificationRow({ kind: "system", title: n.title, body: n.body ?? "", targetKind: null, targetId: null, groupKey: systemSubject(n.key), dedupeKey, source: "push" });
}

/** A cycle starts (a freeze): its row is written. */
export function openSystemCycle(key: string, notice: { title: string; body?: string }, at = Date.now()): void {
  const cycle = String(at);
  openCycles.set(key, cycle);
  recordSystemNotice({ key, cycle, ...notice });
}

/** The cycle ends (the thaw): the same row says so. With no open cycle known (a restart in between), a row of its own. */
export function closeSystemCycle(key: string, notice: { title: string; body?: string }, at = Date.now()): void {
  const cycle = openCycles.get(key) ?? String(at);
  openCycles.delete(key);
  recordSystemNotice({ key, cycle, ...notice });
}
