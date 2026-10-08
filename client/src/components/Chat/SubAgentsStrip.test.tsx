/**
 * THE STRIP UNDER THE CHAT SHOWS WHAT WORKS NOW (chat-live-work), through the
 * real strip: the rows the server answers, a command's line moving on its
 * `scripts:output` frame with no request, an ended sub-agent leaving when the
 * server said it would, each row opening what it is, and a command's Stop and
 * the sign that its end wakes the chat.
 *
 * Mounted with `test/reactHarness` (no DOM in this repo): the network is
 * `liveWorkApi` and `scriptsApi` answering, the window a stand-in that records
 * the events the rows dispatch.
 *
 * A command opens its live log in its own row, the tail its card shows, one
 * row at a time (chat-strips-in-transcript): the process registry answers it.
 *
 * @covers SUBSTRIP-01
 * @covers SUBSTRIP-02
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness, type HostNode } from '../../test/reactHarness';
import { liveWorkApi, scriptsApi } from '../../lib/api';
import { dispatchFrame } from '../../lib/wsFrameBus';
import { resetOpenLinkDedupeForTest } from '../../lib/openLink';
import { SubAgentsStrip } from './SubAgentsStrip';
import type { LiveWorkRow } from '../../../../shared/live-work';

const g = globalThis as unknown as Record<string, unknown>;
const saved = { window: g.window };
const real = { get: liveWorkApi.get, output: scriptsApi.output, list: scriptsApi.list, stop: scriptsApi.stop };
let events: Array<{ type: string; detail: unknown }> = [];
let harness: Harness | null = null;
let answers: LiveWorkRow[][] = [];
let asked = 0;

const t0 = '2026-10-07T20:00:00.000Z';
const ROWS: LiveWorkRow[] = [
  { kind: 'agent', id: 'cli-1', name: 'reviewer', runtime: 'cli', state: 'working', preview: 'Bash: npm test', startedAt: t0 },
  { kind: 'agent', id: 'nat-1', name: 'Muse', runtime: 'topics', sessionKey: 'topic:nat1', state: 'waiting', preview: '', startedAt: t0 },
  { kind: 'agent', id: 'old-1', name: 'anim-fix', runtime: 'topics', state: 'ended', preview: '', startedAt: t0, endedAt: t0, goneInMs: 80 },
  { kind: 'command', id: 'p1', name: 'tick', command: 'while true; do echo tick; sleep 1; done', preview: 'tick 1', startedAt: t0, listen: [], wakes: true },
  { kind: 'command', id: 'p2', name: 'clips', command: 'python3 -m http.server 8781 --bind 127.0.0.1', preview: '', startedAt: '2026-10-07T20:00:05.000Z', listen: [{ host: '127.0.0.1', port: 8781 }], wakes: false },
];

beforeEach(() => {
  events = [];
  answers = [ROWS];
  asked = 0;
  resetOpenLinkDedupeForTest();
  g.window = {
    location: { origin: 'http://localhost', href: 'http://localhost/' },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: Event) => {
      events.push({ type: e.type, detail: (e as CustomEvent).detail });
      // The layout claims a browser tab, as App does: no system browser.
      return e.type !== 'browser:open-tab';
    },
  };
  liveWorkApi.get = (async () => ({ rows: answers[Math.min(asked++, answers.length - 1)]! })) as typeof liveWorkApi.get;
  scriptsApi.output = (async () => ({ output: 'tick 1\ntick 2', offset: 2, done: false, status: 'running' })) as typeof scriptsApi.output;
  // The registry knows the two commands, as it does every row the strip lists.
  scriptsApi.list = (async () => ({
    scripts: ['p1', 'p2'].map((processId) => ({ processId, scriptName: processId, command: '', projectPath: '/p', status: 'running', pid: 1, startedAt: t0, ports: [], source: 'command' })),
  })) as unknown as typeof scriptsApi.list;
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  liveWorkApi.get = real.get;
  scriptsApi.output = real.output;
  scriptsApi.list = real.list;
  scriptsApi.stop = real.stop;
  if (saved.window === undefined) delete g.window; else g.window = saved.window;
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const hosts = (h: Harness, testId: string) => h.last().hosts.filter((n) => n.props['data-testid'] === testId);
/** The first button drawn after the row's wrapper: the row's own click. */
function rowButton(h: Harness, testId: string, idProp: string, id: string): HostNode {
  const all = h.last().hosts;
  const at = all.findIndex((n) => n.props['data-testid'] === testId && n.props[idProp] === id);
  const button = all.slice(at + 1).find((n) => n.type === 'button');
  if (at < 0 || !button) throw new Error(`no row ${id}`);
  return button;
}
/** The node with `testId` inside one command's row, before the next row starts. */
function inRow(h: Harness, processId: string, testId: string): HostNode | undefined {
  const all = h.last().hosts;
  const at = all.findIndex((n) => n.props['data-testid'] === 'live-command-row' && n.props['data-process-id'] === processId);
  const end = all.findIndex((n, i) => i > at && (n.props['data-testid'] === 'live-command-row' || n.props['data-testid'] === 'subagent-row'));
  return all.slice(at + 1, end < 0 ? undefined : end).find((n) => n.props['data-testid'] === testId);
}
const click = (node: HostNode, currentTarget: unknown = null) => (node.props.onClick as (e: unknown) => void)({ stopPropagation() {}, currentTarget });

async function mounted(): Promise<Harness> {
  harness = mount(createElement(SubAgentsStrip, { topicId: 'topic-1' }));
  await flush();
  harness.rerender();
  return harness;
}

/** A row's open state, as the strip draws it. */
const openOf = (h: Harness, processId: string) => hosts(h, 'live-command-row').find((n) => n.props['data-process-id'] === processId)?.props['data-open'];

/** Clicks a command's row, then lets the registry and the log answer. */
async function toggle(h: Harness, processId: string): Promise<void> {
  click(rowButton(h, 'live-command-row', 'data-process-id', processId));
  for (let i = 0; i < 3; i++) {
    h.rerender();
    await flush();
  }
  h.rerender();
}

describe('the rows of what works now', () => {
  test('one row per sub-agent and per command, with the line each is on', async () => {
    const h = await mounted();
    expect(hosts(h, 'subagent-row').map((n) => [n.props['data-subagent-id'], n.props['data-state']]))
      .toEqual([['cli-1', 'working'], ['nat-1', 'waiting'], ['old-1', 'ended']]);
    expect(hosts(h, 'live-command-row').map((n) => n.props['data-process-id'])).toEqual(['p1', 'p2']);
    expect(h.last().text).toContain('Bash: npm test');
    expect(h.last().text).toContain('tick 1');
  });

  test("a command's line moves on its scripts:output frame, with no request", async () => {
    const h = await mounted();
    const before = asked;
    dispatchFrame({ type: 'scripts:output', processId: 'p1', line: 'tick 7' });
    h.rerender();
    expect(h.last().text).toContain('tick 7');
    expect(h.last().text).not.toContain('tick 1');
    expect(asked).toBe(before);
  });

  test('an ended sub-agent leaves when the server said it would', async () => {
    const h = await mounted();
    expect(hosts(h, 'subagent-row')).toHaveLength(3);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    h.rerender();
    expect(hosts(h, 'subagent-row').map((n) => n.props['data-subagent-id'])).toEqual(['cli-1', 'nat-1']);
  });

  test('no rows, no strip', async () => {
    answers = [[]];
    const h = await mounted();
    expect(hosts(h, 'subagents-strip')).toHaveLength(0);
  });

  test('a change of the processes reads the rows again', async () => {
    answers = [ROWS, ROWS.slice(0, 2)];
    const h = await mounted();
    dispatchFrame({ type: 'scripts:updated' });
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    h.rerender();
    expect(asked).toBe(2);
    expect(hosts(h, 'live-command-row')).toHaveLength(0);
  });
});

describe('a row opens what it is', () => {
  test("a CLI child its terminal, a native child its chat", async () => {
    const h = await mounted();
    click(rowButton(h, 'subagent-row', 'data-subagent-id', 'cli-1'));
    click(rowButton(h, 'subagent-row', 'data-subagent-id', 'nat-1'));
    expect(events).toEqual([
      { type: 'topics:open-terminal-pane', detail: { sessionId: 'cli-1', name: 'reviewer' } },
      { type: 'topics:open-topic', detail: { topicId: 'nat-1', mode: 'permanent', reveal: true } },
    ]);
  });

  test("a command its live log, in its own row: the card's tail, and the same click closes it", async () => {
    const h = await mounted();
    expect(openOf(h, 'p1')).toBe('false');
    await toggle(h, 'p1');
    expect(openOf(h, 'p1')).toBe('true');
    expect(rowButton(h, 'live-command-row', 'data-process-id', 'p1').props['aria-expanded']).toBe(true);
    expect(inRow(h, 'p1', 'shell-live-output')?.props.children).toBe('tick 1\ntick 2');
    expect(inRow(h, 'p2', 'shell-live-output')).toBeUndefined();
    await toggle(h, 'p1');
    expect(openOf(h, 'p1')).toBe('false');
    expect(rowButton(h, 'live-command-row', 'data-process-id', 'p1').props['aria-expanded']).toBe(false);
  });

  test("the log is drawn under its row's header, as an accordion", async () => {
    const h = await mounted();
    await toggle(h, 'p1');
    const all = h.last().hosts;
    const header = all.indexOf(rowButton(h, 'live-command-row', 'data-process-id', 'p1'));
    const log = all.findIndex((n) => n.props['data-testid'] === 'live-command-log');
    expect(header).toBeGreaterThan(-1);
    expect(log).toBeGreaterThan(header);
    expect(rowButton(h, 'live-command-row', 'data-process-id', 'p1').props['aria-controls']).toBe(all[log]!.props.id);
  });

  test('one log open at a time: opening a row closes the other', async () => {
    const h = await mounted();
    await toggle(h, 'p1');
    await toggle(h, 'p2');
    expect(openOf(h, 'p1')).toBe('false');
    expect(openOf(h, 'p2')).toBe('true');
    expect(hosts(h, 'live-command-row').filter((n) => n.props['data-open'] === 'true')).toHaveLength(1);
  });

  test('a command that ends with its log open keeps its row, in its place and without Open and Stop, until the log closes', async () => {
    answers = [ROWS, ROWS.filter((r) => r.id !== 'p1')];
    const h = await mounted();
    await toggle(h, 'p1');
    dispatchFrame({ type: 'scripts:updated' });
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    h.rerender();
    expect(asked).toBe(2);
    expect(hosts(h, 'live-command-row').map((n) => [n.props['data-process-id'], n.props['data-open']])).toEqual([['p1', 'true'], ['p2', 'false']]);
    expect(inRow(h, 'p1', 'live-work-stop')).toBeUndefined();
    expect(inRow(h, 'p1', 'live-work-wakes')).toBeUndefined();
    expect(inRow(h, 'p2', 'live-work-stop')).toBeDefined();
    await toggle(h, 'p1');
    expect(hosts(h, 'live-command-row').map((n) => n.props['data-process-id'])).toEqual(['p2']);
  });

  test('a command that ends with its log shut leaves', async () => {
    answers = [ROWS, ROWS.filter((r) => r.id !== 'p1')];
    const h = await mounted();
    dispatchFrame({ type: 'scripts:updated' });
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    h.rerender();
    expect(hosts(h, 'live-command-row').map((n) => n.props['data-process-id'])).toEqual(['p2']);
  });

  test("a server shows its address, and «Open» opens it in a tab", async () => {
    const h = await mounted();
    expect(hosts(h, 'live-work-address').map((n) => n.props.children)).toEqual(['127.0.0.1:8781']);
    click(hosts(h, 'live-work-open')[0]!);
    expect(events).toEqual([expect.objectContaining({ type: 'browser:open-tab', detail: expect.objectContaining({ url: 'http://127.0.0.1:8781/' }) })]);
  });

  test('the X on an ended row dismisses it', async () => {
    const h = await mounted();
    click(hosts(h, 'subagent-dismiss')[0]!);
    h.rerender();
    expect(hosts(h, 'subagent-row').map((n) => n.props['data-subagent-id'])).toEqual(['cli-1', 'nat-1']);
  });
});

describe('a command stops from its row, and says when its end wakes the chat', () => {
  test('Stop asks the stop route for that command, and stays pressed until its row leaves', async () => {
    const asked: string[] = [];
    scriptsApi.stop = (async (id: string) => { asked.push(id); return { ok: true }; }) as typeof scriptsApi.stop;
    const h = await mounted();
    click(inRow(h, 'p2', 'live-work-stop')!);
    await flush();
    h.rerender();
    expect(asked).toEqual(['p2']);
    expect(inRow(h, 'p2', 'live-work-stop')!.props.disabled).toBe(true);
    expect(inRow(h, 'p1', 'live-work-stop')!.props.disabled).toBe(false);
  });

  test('Stop on a row with its log open closes the log, so the row leaves as it would shut', async () => {
    scriptsApi.stop = (async () => ({ ok: true })) as unknown as typeof scriptsApi.stop;
    const h = await mounted();
    await toggle(h, 'p1');
    click(inRow(h, 'p1', 'live-work-stop')!);
    await flush();
    h.rerender();
    expect(openOf(h, 'p1')).toBe('false');
  });

  test('a stop that fails leaves its button usable again', async () => {
    let fail: (e: Error) => void = () => {};
    scriptsApi.stop = (() => new Promise((_, reject) => { fail = reject; })) as typeof scriptsApi.stop;
    const h = await mounted();
    click(inRow(h, 'p1', 'live-work-stop')!);
    h.rerender();
    expect(inRow(h, 'p1', 'live-work-stop')!.props.disabled).toBe(true);
    fail(new Error('500'));
    await flush();
    h.rerender();
    expect(inRow(h, 'p1', 'live-work-stop')!.props.disabled).toBe(false);
  });

  test('a command whose end wakes the chat says so, one that wakes nobody does not', async () => {
    const h = await mounted();
    expect(inRow(h, 'p1', 'live-work-wakes')).toBeDefined();
    expect(inRow(h, 'p2', 'live-work-wakes')).toBeUndefined();
  });

  test('the alarm clock is a sign in the row\'s label, not a control of its own', async () => {
    const h = await mounted();
    const sign = inRow(h, 'p1', 'live-work-wakes')!;
    expect(sign.type).toBe('span');
    expect(sign.props.role).toBe('img');
    expect(sign.props.tabIndex).toBeUndefined();
    expect(sign.props.onClick).toBeUndefined();
    expect(sign.props.title).toBe(sign.props['aria-label']);
    const button = rowButton(h, 'live-command-row', 'data-process-id', 'p1');
    const label = button.props.children as Array<{ props?: Record<string, unknown> } | false | null>;
    expect(label.some((child) => !!child && child.props?.['data-testid'] === 'live-work-wakes')).toBe(true);
    // The button's own label hides the sign's: the sign describes the button.
    expect(button.props['aria-describedby']).toBe(sign.props.id);
  });
});
