/**
 * THE ONE BANNER DECISION OF A WINDOW (notifications-redesign, design section
 * 10.2, ATTN-11).
 *
 * The server decides once, at a new epoch, whether a subject is announced, and
 * puts the words in `attention:updated.announce`. A window shows that banner,
 * and nothing else: no `message:new`, no `stream:end`, no `session:state`
 * raises a banner any more. Those three branches are why a chat waiting on its
 * background work rang "your turn" and then rang again for each woken turn
 * (BG-2, D1), and why the chat in front rang with «notify even when focused»
 * off (defect D).
 *
 * Pure: the frame, the settings and a ledger in, a banner or null out. The
 * claim between windows (`subject#epoch`) and the Do Not Disturb gate stay in
 * the hook, where the storage and the shell are.
 */
import type { AttentionAnnounce } from '../../../../shared/attention';
import { taskIdOfSubject, topicIdOfSubject } from '../../../../shared/attention';
import type { NotifyAction } from '../../../../shared/notify-actions';
import type { NotifyTarget } from './notifyTarget';

export interface AnnounceSettings {
  /** Settings, Notifications: the master switch. */
  notificationsEnabled: boolean;
  /** Banner a subject born in front of the person too. */
  notifyEvenWhenFocused: boolean;
  /** This device has a live push subscription: the push speaks for what it covers. */
  pushSubscribed: boolean;
}

export interface AnnounceBanner {
  /** The claim between windows: one banner per subject and epoch. */
  claimKey: string;
  title: string;
  body: string;
  /** The subject: a second banner of the same subject replaces the first (web). */
  tag: string;
  target: NotifyTarget | null;
  actions?: NotifyAction[];
}

/** The highest epoch already announced (or seen at init) per subject, in this window. */
export interface AnnounceLedger {
  seed(rows: readonly { subject?: unknown; epoch?: unknown }[]): void;
  /** Records `epoch` and says whether it is newer than every one before. */
  take(subject: string, epoch: number): boolean;
}

export function createAnnounceLedger(): AnnounceLedger {
  const last = new Map<string, number>();
  const note = (subject: string, epoch: number): boolean => {
    const prev = last.get(subject);
    if (prev !== undefined && epoch <= prev) return false;
    last.set(subject, epoch);
    return true;
  };
  return {
    seed(rows) {
      for (const r of rows) {
        if (typeof r.subject === 'string' && typeof r.epoch === 'number') note(r.subject, r.epoch);
      }
    },
    take: note,
  };
}

/** Where a click on the banner goes: the card's drawer, the chat. A terminal has no deep link. */
export function announceTarget(subject: string): NotifyTarget | null {
  const task = taskIdOfSubject(subject);
  if (task) return { kind: 'task', id: task };
  const topic = topicIdOfSubject(subject);
  return topic ? { kind: 'topic', id: topic } : null;
}

type Frame = {
  type?: unknown;
  rows?: unknown;
  row?: unknown;
  live?: unknown;
  announce?: unknown;
  bornSeen?: unknown;
};

/**
 * The banner a frame asks for, or null. `attention:init` seeds the ledger and
 * never speaks: a reload, a reconnect or a new window does not ring (ATTN-07).
 * An `attention:updated` speaks only live, with an announce, for an epoch this
 * window has not announced yet, and not when it was born in front of the
 * person unless the setting asks for it. A device subscribed to push leaves
 * every announce the push carries (not born seen) to the push.
 */
export function announceBannerOf(raw: unknown, settings: AnnounceSettings, ledger: AnnounceLedger): AnnounceBanner | null {
  const frame = (raw && typeof raw === 'object' ? raw : {}) as Frame;
  if (frame.type === 'attention:init') {
    if (Array.isArray(frame.rows)) ledger.seed(frame.rows as { subject?: unknown; epoch?: unknown }[]);
    return null;
  }
  if (frame.type !== 'attention:updated') return null;
  const row = (frame.row && typeof frame.row === 'object' ? frame.row : {}) as { subject?: unknown; epoch?: unknown };
  if (typeof row.subject !== 'string' || typeof row.epoch !== 'number') return null;
  const subject = row.subject;
  const fresh = ledger.take(subject, row.epoch);
  if (frame.live !== true || !frame.announce || !fresh) return null;
  const announce = frame.announce as AttentionAnnounce;
  if (!settings.notificationsEnabled) return null;
  const bornSeen = frame.bornSeen === true;
  if (bornSeen && !settings.notifyEvenWhenFocused) return null;
  if (settings.pushSubscribed && !bornSeen) return null;
  return {
    claimKey: `${subject}#${row.epoch}`,
    title: announce.title,
    body: announce.body,
    tag: announce.tag || subject,
    target: announceTarget(subject),
    ...(announce.actions?.length ? { actions: announce.actions } : {}),
  };
}
