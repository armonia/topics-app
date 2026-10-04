/**
 * ONE BANNER PER WAIT, FROM THE ANNOUNCE ONLY (tasks.md 1.10, D1, BG-2).
 *
 * The main window hidden in the tray, a chat waiting on three background
 * tasks: the first two come back, each with a woken turn that writes a
 * message, and the server keeps the subject `working` with no announce.
 * The banner logic of `useCompletionNotifier` (`announceBannerOf`, the claim
 * on `subject#epoch`) must stay silent through all of it, whatever the
 * `message:new`, `stream:end` and `session:state` frames say, and then speak
 * ONCE, in one window of two, when the last task returns.
 *
 * @covers ATTN-02, ATTN-07, ATTN-11
 */
import { describe, test, expect } from 'bun:test';
import { announceBannerOf, createAnnounceLedger, type AnnounceSettings } from '../lib/notify/announceBanner';
import { claimBannerIn, type ClaimStorage } from '../lib/notify/messageBannerClaim';
import type { AttentionSnapshot } from '../../../shared/attention';

const ON: AnnounceSettings = { notificationsEnabled: true, notifyEvenWhenFocused: false, pushSubscribed: false };

function row(over: Partial<AttentionSnapshot>): AttentionSnapshot {
  return {
    subject: 'topic:T', state: 'working', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 6, seenEpoch: 6, lit: false, unread: 0, turnUnseen: true, lastTurnAt: '2026-10-03T10:00:00.000Z', background: [], ...over,
  };
}

const task = (id: string) => ({ id, kind: 'agent', label: `verify ${id}`, startedAt: '2026-10-03T10:00:00.000Z' });

/** The frames a hidden main window receives for the whole wait, in order. */
function theWait(): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [
    { type: 'attention:init', rows: [row({ background: [task('a'), task('b'), task('c')] })] },
  ];
  for (const [n, left] of [[1, ['b', 'c']], [2, ['c']]] as const) {
    frames.push(
      { type: 'stream:start', topicId: 'T', sessionKey: 'topic:T' },
      { type: 'attention:updated', live: true, row: row({ state: 'working', background: left.map(task) }) },
      { type: 'message:new', topicId: 'T', sessionKey: 'topic:T', role: 'assistant', messageId: `woken-${n}`, preview: `${n} di 3 arrivato` },
      { type: 'stream:end', topicId: 'T', sessionKey: 'topic:T', messageId: `woken-${n}`, completed: true, background: { count: left.length, kinds: ['agent'] } },
      { type: 'attention:updated', live: true, row: row({ unread: n, background: left.map(task) }) },
      { type: 'session:state', state: { sessionKey: 'topic:T', phase: 'watching' } },
    );
  }
  frames.push(
    { type: 'message:new', topicId: 'T', sessionKey: 'topic:T', role: 'assistant', messageId: 'woken-3', preview: 'tutti e 3 arrivati' },
    { type: 'stream:end', topicId: 'T', sessionKey: 'topic:T', messageId: 'woken-3', completed: true, background: { count: 0, kinds: [] } },
    {
      type: 'attention:updated', live: true,
      row: row({ state: 'finished', outcome: 'done', epoch: 7, lit: true, unread: 3, background: [] }),
      announce: { title: 'Render', body: 'Ha finito', tag: 'topic:T', url: '/?topic=T' },
      bornSeen: false,
    },
    { type: 'session:state', state: { sessionKey: 'topic:T', phase: 'awaiting-user' } },
  );
  return frames;
}

function memoryStorage(): ClaimStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('the hidden main window during a background wait', () => {
  test('zero banners until the announce, then exactly one', () => {
    const ledger = createAnnounceLedger();
    const banners = theWait().map((f) => announceBannerOf(f, ON, ledger)).filter(Boolean);
    expect(banners.map((b) => b!.claimKey)).toEqual(['topic:T#7']);
    expect(banners[0]).toMatchObject({ title: 'Render', body: 'Ha finito', target: { kind: 'topic', id: 'T' } });
  });

  test('two windows, the same frames: one banner between them (the claim on subject#epoch)', () => {
    const storage = memoryStorage();
    const delivered: string[] = [];
    for (const win of ['main', 'group']) {
      const ledger = createAnnounceLedger();
      for (const f of theWait()) {
        const b = announceBannerOf(f, ON, ledger);
        if (b && claimBannerIn(storage, b.claimKey, win, Date.now())) delivered.push(`${win}:${b.claimKey}`);
      }
    }
    expect(delivered).toEqual(['main:topic:T#7']);
  });

  test('a reconnect replays nothing: the init seeds the epoch, the same epoch never speaks again', () => {
    const ledger = createAnnounceLedger();
    const announced = theWait().at(-2)!;
    expect(announceBannerOf(announced, ON, ledger)).not.toBeNull();
    announceBannerOf({ type: 'attention:init', rows: [row({ state: 'finished', outcome: 'done', epoch: 7, lit: true })] }, ON, ledger);
    expect(announceBannerOf(announced, ON, ledger)).toBeNull();
    const fresh = createAnnounceLedger();
    announceBannerOf({ type: 'attention:init', rows: [row({ state: 'finished', outcome: 'done', epoch: 7, lit: true })] }, ON, fresh);
    expect(announceBannerOf(announced, ON, fresh)).toBeNull();
  });

  test('the chat in front with «notify even when focused» off does not sound (defect D)', () => {
    const born = { ...theWait().at(-2)!, bornSeen: true };
    expect(announceBannerOf(born, ON, createAnnounceLedger())).toBeNull();
    expect(announceBannerOf(born, { ...ON, notifyEvenWhenFocused: true }, createAnnounceLedger())).not.toBeNull();
  });

  test('a recomposition at boot (live: false) never speaks', () => {
    const boot = { ...theWait().at(-2)!, live: false };
    expect(announceBannerOf(boot, ON, createAnnounceLedger())).toBeNull();
  });

  test('a device subscribed to push leaves the announce not born seen to the push', () => {
    const f = theWait().at(-2)!;
    expect(announceBannerOf(f, { ...ON, pushSubscribed: true }, createAnnounceLedger())).toBeNull();
  });
});
