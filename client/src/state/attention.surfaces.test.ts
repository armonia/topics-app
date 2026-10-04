/**
 * EVERY SURFACE READS THE SAME FRAME (tasks.md 1.6).
 *
 * The nine cases of `evidence/client-surfaces-disagree.test.ts.txt` and the
 * case of `evidence/bgwait-3-client-done-mark-banner-count.txt`, rewritten on
 * the new contract: the store is fed only `attention:*` frames, the way the
 * server sends them, and each surface is read through the exact pure function
 * it renders from:
 *   - tab/row fill and number : attentionOf (TopicItem, PaneTabBar, TopicTree)
 *   - background glyph        : attentionOf(...).tier === 'background' (TabSlot, TopicItem)
 *   - bell, Dock, tray        : chromeAttentionSubjects (useTabNotifications, Inbox)
 *   - agents menu             : activeAgentRowsFrom
 *   - project row/tab         : projectAttention
 *   - group card              : spaceAttention
 *   - state view              : sidebarItemState
 *   - OS banner               : announceBannerOf
 *
 * @covers ATTN-01, ATTN-02, ATTN-05, ATTN-12, CHROME-COUNT-01, NOTIF-ONE-02
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { attentionActions, attentionOf, useAttentionStore } from './attention';
import { projectAttention, spaceAttention } from './attentionRollups';
import { chromeAttentionSubjects, chromeAttentionTotal } from './attentionTotal';
import { activeAgentRowsFrom } from './signals';
import { sidebarItemState, type SidebarItem } from '../lib/buildSidebarItems';
import { announceBannerOf, createAnnounceLedger } from '../lib/notify/announceBanner';
import { DEFAULT_SPACE_ID, type Pane } from './pane/types';
import type { AttentionSnapshot } from '../../../shared/attention';
import type { Topic, TerminalSessionInfo } from '../types';

const rows = () => useAttentionStore.getState().rows;

function snap(subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state: 'idle', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 0, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}

const finished = (subject: string, over: Partial<AttentionSnapshot> = {}) =>
  snap(subject, { state: 'finished', outcome: 'done', epoch: 1, seenEpoch: 0, lit: true, turnUnseen: true, lastTurnAt: '2026-10-03T10:00:00.000Z', ...over });

const bash = { id: 'b1', kind: 'bash', label: 'bun test --watch', startedAt: '2026-10-03T10:00:00.000Z' };
const monitor = { id: 'm1', kind: 'monitor', label: 'tail -f build.log', startedAt: '2026-10-03T10:00:00.000Z' };

const updated = (row: AttentionSnapshot, extra: Record<string, unknown> = {}) =>
  attentionActions.applyFrame({ type: 'attention:updated', row, live: true, ...extra } as never);

const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: `chat ${id}`, sessionKey: `topic:${id}`, projectPath: '/p', ...over } as Topic);

const NO_LOADING = { active: new Set<string>(), resting: new Set<string>(), busy: new Set<string>(), liveStream: new Set<string>(), hydratedStream: new Set<string>() };

/** What each surface shows for chat `id`, read from the store as it is now. */
function surfaces(topics: Record<string, Topic>, id: string, roster: TerminalSessionInfo[] = []) {
  const r = rows();
  const a = attentionOf(r, `topic:${id}`);
  const menu = activeAgentRowsFrom(roster, topics, { ...NO_LOADING, attention: r });
  const project = projectAttention(r, '/p', topics, roster);
  return {
    backgroundGlyph: a.tier === 'background',
    tabRowFill: a.lit ? a.tier : null,
    tabRowNumber: a.count,
    bellAndDock: chromeAttentionTotal(r, topics, roster),
    agentsMenuBackground: menu.background.map((x) => x.id),
    agentsMenuFinished: menu.finished.map((x) => x.id),
    projectFill: project.tier,
    projectNumber: project.count,
  };
}

beforeEach(() => attentionActions.reset());

describe('CONTROL: a finished chat, nobody looking', () => {
  test('blue, numbered, on the bell, in "finished"', () => {
    const topics = { T: topic('T') };
    attentionActions.applyFrame({ type: 'attention:init', rows: [finished('topic:T', { unread: 1 })] });
    expect(surfaces(topics, 'T')).toEqual({
      backgroundGlyph: false, tabRowFill: 'done', tabRowNumber: 1, bellAndDock: 1,
      agentsMenuBackground: [], agentsMenuFinished: ['T'], projectFill: 'done', projectNumber: 1,
    });
  });
});

describe('A. a chat waiting on its own background work asks nothing (BG-1, BG-3, bgwait-3)', () => {
  test('A1 Stop with a background Bash: the glyph alone, no fill, no number, not on the bell', () => {
    const topics = { T: topic('T') };
    updated(snap('topic:T', { state: 'background', unread: 1, turnUnseen: true, lastTurnAt: '2026-10-03T10:00:00.000Z', background: [bash] }));
    expect(surfaces(topics, 'T')).toEqual({
      backgroundGlyph: true, tabRowFill: null, tabRowNumber: 0, bellAndDock: 0,
      agentsMenuBackground: ['T'], agentsMenuFinished: [], projectFill: null, projectNumber: 0,
    });
  });

  test('A2 the frame of a turn closed into background carries no announce: no banner', () => {
    const ledger = createAnnounceLedger();
    const frame = { type: 'attention:updated', row: snap('topic:T', { state: 'background', epoch: 0, background: [bash] }), live: true };
    expect(announceBannerOf(frame, { notificationsEnabled: true, notifyEvenWhenFocused: true, pushSubscribed: false }, ledger)).toBeNull();
  });

  test('A3 a Monitor armed: background, not blue, not counted', () => {
    const topics = { T: topic('T') };
    updated(snap('topic:T', { state: 'background', background: [monitor] }));
    const seen = surfaces(topics, 'T');
    expect({ fill: seen.tabRowFill, bell: seen.bellAndDock, finished: seen.agentsMenuFinished, project: seen.projectFill, glyph: seen.backgroundGlyph })
      .toEqual({ fill: null, bell: 0, finished: [], project: null, glyph: true });
  });

  test('bgwait-3: two tasks launched, clean end of the turn: no done mark, no banner, global count 0', () => {
    const topics = { t1: topic('t1') };
    const ledger = createAnnounceLedger();
    const frame = {
      type: 'attention:updated', live: true,
      row: snap('topic:t1', { state: 'background', unread: 1, background: [bash, { id: 'a1', kind: 'agent', label: 'Verify render v131', startedAt: '2026-10-03T10:00:00.000Z' }] }),
    };
    attentionActions.applyFrame(frame as never);
    const a = attentionOf(rows(), 'topic:t1');
    expect({
      waitingOnBackground: a.tier === 'background' && a.background.length === 2,
      doneMark: a.lit,
      banner: announceBannerOf(frame, { notificationsEnabled: true, notifyEvenWhenFocused: true, pushSubscribed: false }, ledger),
      globalCount: chromeAttentionTotal(rows(), topics, []),
    }).toEqual({ waitingOnBackground: true, doneMark: false, banner: null, globalCount: 0 });
  });
});

describe('A4. the sidebar state view', () => {
  test('a chat waiting on its background Bash sits under «In background», not «Ti aspetta»', () => {
    updated(snap('topic:T', { state: 'background', background: [bash] }));
    const row = { id: 'T', type: 'chat', name: 'chat T', topic: topic('T') } as unknown as SidebarItem;
    expect(sidebarItemState(row, rows())).toBe('background');
  });
});

describe('B. a chat that has been read counts nowhere (BELL-1, B2)', () => {
  test('B1 seen by this window: fill, number and bell go at once; the server confirms', () => {
    const topics = { T: topic('T') };
    updated(finished('topic:T', { unread: 1, epoch: 3 }));
    expect(surfaces(topics, 'T').tabRowFill).toBe('done');

    attentionActions.seeLocally('topic:T');
    const afterRead = surfaces(topics, 'T');
    // The server's answer to the seen door: the epoch seen, the unread zeroed.
    updated(finished('topic:T', { unread: 0, epoch: 3, seenEpoch: 3, lit: false, turnUnseen: false }));
    const confirmed = surfaces(topics, 'T');
    expect({
      afterRead: { fill: afterRead.tabRowFill, number: afterRead.tabRowNumber, bell: afterRead.bellAndDock },
      confirmed: { fill: confirmed.tabRowFill, number: confirmed.tabRowNumber, bell: confirmed.bellAndDock },
    }).toEqual({
      afterRead: { fill: null, number: 0, bell: 0 },
      confirmed: { fill: null, number: 0, bell: 0 },
    });
  });

  test('a seen for epoch 3 does not switch off epoch 4, arrived meanwhile', () => {
    updated(finished('topic:T', { epoch: 3 }));
    attentionActions.seeLocally('topic:T');
    updated(finished('topic:T', { epoch: 4, lastTurnAt: '2026-10-03T10:05:00.000Z' }));
    expect(attentionOf(rows(), 'topic:T').lit).toBe(true);
  });
});

describe('C. the same fact counts the same for a chat and a terminal (TERM-1)', () => {
  test('C1 chat and claude-code terminal both finished: both blue, the menu and the bell both say 2', () => {
    const topics = { T: topic('T') };
    const roster = [{ id: 'S', type: 'claude-code', claudeSessionId: 'c2', cwd: '/p', name: 'build' }] as TerminalSessionInfo[];
    attentionActions.applyFrame({ type: 'attention:init', rows: [finished('topic:T'), finished('terminal:S')] });
    const r = rows();
    const menu = activeAgentRowsFrom(roster, topics, { ...NO_LOADING, attention: r });
    expect({
      chat: { fill: attentionOf(r, 'topic:T').tier, number: attentionOf(r, 'topic:T').count },
      terminal: { fill: attentionOf(r, 'terminal:S').tier, number: attentionOf(r, 'terminal:S').count },
      agentsMenuFinished: menu.finished.map((x) => x.id).sort(),
      bell: chromeAttentionSubjects(r, topics, roster).map((x) => x.key).sort(),
    }).toEqual({
      chat: { fill: 'done', number: 1 },
      terminal: { fill: 'done', number: 1 },
      agentsMenuFinished: ['S', 'T'],
      bell: ['terminal:S', 'topic:T'],
    });
  });
});

describe('D. a hook-less terminal that finished lights every surface or none (TERM-2)', () => {
  test('D1 card, tab/row and project all "done", numbers 1', () => {
    const topics = {};
    const roster = [{ id: 'S', type: 'claude-code', claudeSessionId: null, cwd: '/p', name: 'build' }] as unknown as TerminalSessionInfo[];
    updated(finished('terminal:S'));
    const r = rows();
    const panes = { 'terminal:S': { id: 'terminal:S', type: 'terminal', terminalSessionId: 'S' } } as unknown as Record<string, Pane>;
    const card = spaceAttention(DEFAULT_SPACE_ID, panes, {}, r, topics, roster);
    const project = projectAttention(r, '/p', topics, roster);
    expect({
      card: card.tier, tabRow: attentionOf(r, 'terminal:S').tier, project: project.tier,
      tabRowNumber: attentionOf(r, 'terminal:S').count, projectNumber: project.count,
    }).toEqual({ card: 'done', tabRow: 'done', project: 'done', tabRowNumber: 1, projectNumber: 1 });
  });
});

describe('E. an archived chat counts nowhere (ARCH-1)', () => {
  test('E1 a lit row that raced the archive: sidebar 0, bell/Dock/tray 0', () => {
    const topics = { T: topic('T', { archived: true }) };
    updated(finished('topic:T'));
    expect(chromeAttentionTotal(rows(), topics, [])).toBe(0);
  });
});

describe('the init frame replaces the store (F1, B4)', () => {
  test('a subject switched off while the socket was down is off after the reconnect', () => {
    const topics = { T: topic('T'), U: topic('U') };
    attentionActions.applyFrame({ type: 'attention:init', rows: [finished('topic:T'), finished('topic:U')] });
    expect(chromeAttentionTotal(rows(), topics, [])).toBe(2);
    attentionActions.applyFrame({ type: 'attention:init', rows: [finished('topic:U')] });
    expect(chromeAttentionTotal(rows(), topics, [])).toBe(1);
    expect(attentionOf(rows(), 'topic:T').tier).toBeNull();
  });
});
