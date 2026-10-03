/**
 * THE ONE NUMBER Topics paints on the operating system: the Dock badge, the
 * macOS menu-bar tray glyph, the PWA Badging API, and the inbox's button all
 * project the value this module computes, and nothing else computes it
 * (ATTN-08, CHROME-COUNT-01, NOTIF-ONE-02).
 *
 * One criterion: HOW MANY SUBJECTS ARE LIT. Subjects, not messages: a chat
 * with 39 unread messages is ONE (its row keeps showing 39). A subject is lit
 * when it waits for the person (`needs-you`) or finished and was not seen
 * (`finished`), and the server decides that (`state/attention.ts`). Work that
 * runs on its own (`working`, `background`) is not lit, an archived topic
 * never counts, and history rows never enter: the bell used to count unseen
 * rows of pushes never sent and of chats long archived (D3, ARCH-1).
 *
 * Pure, no React, no I/O: the parity test computes its expectation from the
 * sidebar rows and the board tab, so a criterion that changes on one surface
 * and not the other turns the test red instead of quietly drifting.
 */
import type { Topic, TerminalSessionInfo } from '../types';
import { attentionOf, type AttentionRows } from './attention';
import { TASK_SUBJECT_PREFIX, TERMINAL_SUBJECT_PREFIX, TOPIC_SUBJECT_PREFIX, taskSubject, topicSubject } from '../../../shared/attention';

export type ChromeSubjectKind = 'chat' | 'terminal' | 'card';

/** One lit subject the Dock, the tray, the PWA badge and the inbox count. */
export interface ChromeSubject {
  key: string;
  kind: ChromeSubjectKind;
  id: string;
}

function kindOf(subject: string): { kind: ChromeSubjectKind; id: string } | null {
  if (subject.startsWith(TOPIC_SUBJECT_PREFIX)) return { kind: 'chat', id: subject.slice(TOPIC_SUBJECT_PREFIX.length) };
  if (subject.startsWith(TERMINAL_SUBJECT_PREFIX)) return { kind: 'terminal', id: subject.slice(TERMINAL_SUBJECT_PREFIX.length) };
  if (subject.startsWith(TASK_SUBJECT_PREFIX)) return { kind: 'card', id: subject.slice(TASK_SUBJECT_PREFIX.length) };
  return null;
}

/**
 * THE ONE NUMBER (ATTN-08, CHROME-COUNT-01): every lit subject, once, but an
 * archived chat. The server already composes an archived chat `idle`; the
 * filter here keeps a row that raced the archive from lighting a Dock nobody
 * can switch off. Work that runs on its own is not lit, and no history row
 * enters.
 */
export function chromeAttentionSubjects(rows: AttentionRows, topics: Record<string, Topic>): ChromeSubject[] {
  const out: ChromeSubject[] = [];
  for (const [subject, row] of rows) {
    if (!row.lit) continue;
    const a = attentionOf(rows, subject);
    if (!a.lit) continue;
    const k = kindOf(subject);
    if (!k) continue;
    if (k.kind === 'chat' && topics[k.id]?.archived) continue;
    out.push({ key: subject, kind: k.kind, id: k.id });
  }
  return out;
}

export function chromeAttentionTotal(rows: AttentionRows, topics: Record<string, Topic>): number {
  return chromeAttentionSubjects(rows, topics).length;
}

/** How many chats and terminals the tray menu lists: the menu stays short. */
export const TRAY_CHAT_ROWS = 8;

/** A row of the tray menu (`set_app_status` items). A terminal's id carries its `terminal:` prefix. */
export interface TrayChatItem {
  id: string;
  title: string;
}

/**
 * The chat and terminal rows of the tray menu, from the subjects the glyph
 * counts: the menu lists what the number says. Waiting for you first, then
 * the most recent. The cards ride the board groups of the same call.
 */
export function trayChatItems(
  subjects: readonly ChromeSubject[],
  rows: AttentionRows,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): TrayChatItem[] {
  const names = new Map(terminalSessions.map((t) => [t.id, t.name || t.type || 'Terminal']));
  const listed: { item: TrayChatItem; rank: number; since: number }[] = [];
  for (const s of subjects) {
    const a = attentionOf(rows, s.key);
    const rank = a.tier === 'needs-you' ? 2 : 1;
    if (s.kind === 'chat') {
      const t = topics[s.id];
      if (!t || t.archived) continue;
      listed.push({ item: { id: s.id, title: t.name || s.id }, rank, since: a.since });
    } else if (s.kind === 'terminal') {
      listed.push({ item: { id: s.key, title: names.get(s.id) ?? s.id }, rank, since: a.since });
    }
  }
  return listed
    .sort((x, y) => y.rank - x.rank || y.since - x.since)
    .slice(0, TRAY_CHAT_ROWS)
    .map((x) => x.item);
}

/**
 * THE PHONE'S DELIVERED NOTIFICATIONS, after a seen elsewhere (ATTN-06): the
 * subject a push tag stands for. The server tags a push with the subject
 * itself, or with the older per-kind tags (`chat-end-<id>`, `task-review-<id>`,
 * ...) that already sit on the phone.
 */
export function subjectOfPushTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  if (tag.startsWith(TOPIC_SUBJECT_PREFIX) || tag.startsWith(TERMINAL_SUBJECT_PREFIX) || tag.startsWith(TASK_SUBJECT_PREFIX)) return tag;
  const chat = /^chat-(?:end|error|wait)-(.+)$/.exec(tag);
  if (chat) return topicSubject(chat[1]);
  const task = /^task-(?:review|park|wait)-(.+)$/.exec(tag);
  if (task && task[1] !== 'new') return taskSubject(task[1]);
  return null;
}

/**
 * Which delivered notifications to withdraw on `attention:init`: those whose
 * subject is no longer lit. A tag that names no subject (an old generic one)
 * is left alone: nothing says it is stale.
 */
export function notificationsToWithdraw<N extends { tag?: string }>(delivered: readonly N[], rows: AttentionRows): N[] {
  return delivered.filter((n) => {
    const subject = subjectOfPushTag(n.tag);
    return subject !== null && !attentionOf(rows, subject).lit;
  });
}
