/**
 * THE LOG FOLLOWS ITS LAST LINE EVEN WHEN THAT LINE IS NOT FINISHED.
 *
 * The `<pre>` shows `output + pending`, but the auto-scroll ran only when
 * `output` changed. A process that prints whole lines and then a prompt or a
 * progress bar without a newline ("Password: ", "45%") changes `pending`
 * alone, and that last line stayed under the edge with auto-scroll on.
 *
 * No DOM in this project: the `<pre>` is a stand-in object handed to the
 * component's own ref, and the network is `scriptsApi` answering in sequence.
 *
 * @covers CMDRUN-02
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { scriptsApi } from '../../lib/api';
import { ProcessLogPane } from './ProcessLogPane';
import type { WSMessage } from '../../types';

const real = { output: scriptsApi.output, list: scriptsApi.list };
afterAll(() => { scriptsApi.output = real.output; scriptsApi.list = real.list; });

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('ProcessLogPane auto-scroll', () => {
  test('a pending line alone still scrolls the log to the bottom', async () => {
    const answers = [
      { output: 'line 1', pending: '', offset: 1, done: false, status: 'running' },
      { output: '', pending: 'Password: ', offset: 1, done: false, status: 'running' },
    ];
    let call = 0;
    scriptsApi.output = (async () => answers[Math.min(call++, answers.length - 1)]) as typeof scriptsApi.output;
    scriptsApi.list = (async () => ({ scripts: [] })) as unknown as typeof scriptsApi.list;
    let wsHandler: ((msg: WSMessage) => void) | null = null;
    const onMessage = (h: (msg: WSMessage) => void) => { wsHandler = h; return () => { wsHandler = null; }; };

    const logElement = { scrollTop: 0, scrollHeight: 100, clientHeight: 50 };
    const h = mount(createElement(ProcessLogPane, { processId: 'p1', scriptName: 'dev', onMessage }));
    try {
      const host = h.last().hosts.find(n => n.props['data-testid'] === 'process-log-output');
      (host!.props.ref as { current: unknown }).current = logElement;
      await flush();
      expect(logElement.scrollTop).toBe(100);

      // The prompt arrives with no newline: only `pending` changes.
      logElement.scrollHeight = 120;
      await new Promise<void>(resolve => setTimeout(resolve, 1050));
      wsHandler!({ type: 'scripts:output', processId: 'p1' } as unknown as WSMessage);
      await flush();
      expect(call).toBe(2);
      expect(logElement.scrollTop).toBe(120);
    } finally {
      h.unmount();
    }
  });
});

/**
 * AN EMPTY LOG SAYS WHAT IT IS WAITING FOR, AND SINCE WHEN (chat-live-work).
 * On 07/10 Muse's row said «Waiting for output...» for 58 minutes while it
 * wrote to a file: the pane could not tell «nothing yet» from «not here».
 */
describe('ProcessLogPane empty state', () => {
  const startedAt = '2026-10-07T18:28:50.000Z';
  const time = new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text = (h: ReturnType<typeof mount>) =>
    String(h.last().hosts.find(n => n.props['data-testid'] === 'process-log-output')?.props.children ?? '');

  async function emptyLogSays(answer: Record<string, unknown>): Promise<{ before: string; after: string }> {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    scriptsApi.output = (async () => { await gate; return { output: '', pending: '', offset: 0, done: false, status: 'running', startedAt, ...answer }; }) as typeof scriptsApi.output;
    scriptsApi.list = (async () => ({ scripts: [] })) as unknown as typeof scriptsApi.list;
    const h = mount(createElement(ProcessLogPane, { processId: 'p-empty', scriptName: 'muse' }));
    try {
      const before = text(h);
      release();
      await flush();
      await flush();
      h.rerender();
      return { before, after: text(h) };
    } finally {
      h.unmount();
    }
  }

  test('before the first answer it claims nothing', async () => {
    const { before } = await emptyLogSays({});
    expect(before).toBe('');
  });

  test('a command that prints nothing yet: since when it runs', async () => {
    const { after } = await emptyLogSays({});
    expect(after).toContain(time);
    expect(after).not.toContain('Waiting for output...');
  });

  test('a command that writes to a file: that file, followed here', async () => {
    const { after } = await emptyLogSays({ follows: '/tmp/fa-wallrunv2.log' });
    expect(after).toContain('/tmp/fa-wallrunv2.log');
    expect(after).toContain(time);
  });

  test('a file nobody can follow: which, and why', async () => {
    const { after } = await emptyLogSays({ unfollowed: { target: '$LOG', reason: 'variable' } });
    expect(after).toContain('$LOG');
    expect(after).toMatch(/variabile|variable/);
    expect(after).toContain(time);
  });
});
