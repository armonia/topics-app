/**
 * WHAT THE INBOX LISTS, as data (notifications-redesign, design section 9.2,
 * ATTN-09). Pure: the attention rows, the topics, the roster and the board's
 * cards in, the two sections and the quiet line out. The panel only draws it.
 *
 *   - «Waiting for you»: the `needs-you` subjects, the OLDEST first: whoever
 *     has waited longest comes first. They have no "mark seen": only the
 *     answer switches them off.
 *   - «Finished»: the `finished` subjects not seen, the most RECENT first.
 *     Each carries the epoch and the turn it shows, so «Mark seen» and «Mark
 *     all seen» send exactly what was listed (a newer epoch stays lit).
 *   - the quiet line: how many subjects are in background and at work. It is
 *     not a number of the button: it answers "what is it doing?" without
 *     turning it into an alert.
 *
 * The rows are the chrome's subjects (`chromeAttentionSubjects`): the inbox
 * lists what the Dock counts, and says «nothing to look at» only when that
 * number is zero (NOTIF-ONE-02).
 */
import type { Topic, TerminalSessionInfo } from '../types';
import type { AttentionReason, AttentionSeenItem, AttentionTask } from '../../../shared/attention';
import { notificationTargetUrl } from '../../../shared/notification-log';
import { attentionOf, type AttentionRows } from '../state/attention';
import { chromeAttentionSubjects } from '../state/attentionTotal';
import { getProjectLabel } from './buildSidebarItems';

export type InboxKind = 'chat' | 'terminal' | 'card';

export interface InboxItem {
  subject: string;
  kind: InboxKind;
  id: string;
  title: string;
  /** The project's name, when the subject has one. */
  project: string | null;
  /** When the subject entered its state (ms). */
  since: number;
  tier: 'needs-you' | 'error' | 'done';
  reason: AttentionReason | null;
  /** The second line: the question, the tool, the reason of the park, the error, the last message. */
  detail: string | null;
  /** Unread messages of a chat: «3 messages» when more than one. */
  unread: number;
  /** What a seen of this row sends: the epoch and the turn the row shows. */
  seen: AttentionSeenItem;
  /** Where Enter takes you: a deep link (chat, card), or null for a terminal (opened by session). */
  url: string | null;
}

export interface InboxQuietItem {
  subject: string;
  kind: InboxKind;
  id: string;
  title: string;
  /** The first task in flight, to say what it is waiting on («Agent: verify render»). */
  firstTask: AttentionTask | null;
  url: string | null;
}

export interface InboxModel {
  waiting: InboxItem[];
  finished: InboxItem[];
  background: InboxQuietItem[];
  working: InboxQuietItem[];
}

interface CardRef {
  id: string;
  text: string;
}

function nameOf(kind: InboxKind, id: string, topics: Record<string, Topic>, terminals: ReadonlyMap<string, TerminalSessionInfo>, cards: ReadonlyMap<string, CardRef>): { title: string; project: string | null } | null {
  if (kind === 'chat') {
    const t = topics[id];
    if (!t || t.archived) return null;
    return { title: t.name || id, project: t.projectPath && !t.standalone ? getProjectLabel(t.projectPath) : null };
  }
  if (kind === 'terminal') {
    const s = terminals.get(id);
    return { title: s?.name || id, project: s?.cwd ? getProjectLabel(s.cwd) : null };
  }
  const c = cards.get(id);
  // A card's board is named on the card itself, in its drawer: the row says the card.
  return { title: c?.text?.split('\n')[0]?.trim() || id, project: null };
}

/** Where Enter takes you: a deep link for a chat or a card; a terminal opens by session. */
function urlOf(kind: InboxKind, id: string): string | null {
  return kind === 'chat' ? notificationTargetUrl('topic', id) : kind === 'card' ? notificationTargetUrl('task', id) : null;
}

function kindOf(subject: string): { kind: InboxKind; id: string } | null {
  const at = subject.indexOf(':');
  if (at <= 0) return null;
  const prefix = subject.slice(0, at);
  const id = subject.slice(at + 1);
  if (!id) return null;
  if (prefix === 'topic') return { kind: 'chat', id };
  if (prefix === 'terminal') return { kind: 'terminal', id };
  if (prefix === 'task') return { kind: 'card', id };
  return null;
}

export function inboxModel(
  rows: AttentionRows,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
  cards: readonly CardRef[],
): InboxModel {
  const terminals = new Map(terminalSessions.map((t) => [t.id, t]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const waiting: InboxItem[] = [];
  const finished: InboxItem[] = [];
  for (const s of chromeAttentionSubjects(rows, topics, terminalSessions)) {
    const a = attentionOf(rows, s.key);
    const named = nameOf(s.kind, s.id, topics, terminals, cardById);
    if (!named || !a.lit) continue;
    const item: InboxItem = {
      subject: s.key,
      kind: s.kind,
      id: s.id,
      title: named.title,
      project: named.project,
      since: a.since,
      tier: a.tier as InboxItem['tier'],
      reason: a.reason,
      detail: a.detail,
      unread: a.unread,
      seen: { subject: s.key, epoch: a.epoch, turnAt: a.lastTurnAt },
      url: urlOf(s.kind, s.id),
    };
    (a.tier === 'needs-you' ? waiting : finished).push(item);
  }
  waiting.sort((x, y) => x.since - y.since);
  finished.sort((x, y) => y.since - x.since);

  const background: InboxQuietItem[] = [];
  const working: InboxQuietItem[] = [];
  for (const subject of rows.keys()) {
    const a = attentionOf(rows, subject);
    if (a.tier !== 'background' && a.tier !== 'working') continue;
    const k = kindOf(subject);
    if (!k) continue;
    const named = nameOf(k.kind, k.id, topics, terminals, cardById);
    if (!named) continue;
    const item: InboxQuietItem = {
      subject, kind: k.kind, id: k.id, title: named.title,
      firstTask: a.background.find((t) => !t.recurring) ?? a.background[0] ?? null,
      url: urlOf(k.kind, k.id),
    };
    (a.tier === 'background' ? background : working).push(item);
  }
  return { waiting, finished, background, working };
}

/** The seen items of «Mark all seen»: exactly the finished rows listed. */
export function markAllSeenItems(model: InboxModel): AttentionSeenItem[] {
  return model.finished.map((f) => f.seen);
}

/** A history row's day, for the «History» tab's groups: today, yesterday, or the date. */
export function historyDayKey(iso: string, now: number): 'today' | 'yesterday' | string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const day = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
