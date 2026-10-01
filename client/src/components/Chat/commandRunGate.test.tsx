/**
 * WHERE RUN APPEARS, AND WHERE IT NEVER DOES.
 *
 * The real `MessageContent` rendered to markup: Run and Open in terminal sit
 * beside Copy on a shell block of a finished reply of the agent, in the chat,
 * for an owner of a server with a shell. Not while the reply is still being
 * written (the open fence is drawn closed), not on a person's own message, not
 * on an unlabelled block, not in the file preview's markdown, not on the
 * board's task drawer, not for a guest, not on a server without a shell.
 * Rendering never starts anything: there is no click here.
 * @covers CHAT-RUN-01, CHAT-RUN-02
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent, markdownComponents } from '../MessageContent';
import { ChatMarkdown } from '../ChatMarkdown';
import { __resetSessionForTests, publishSession } from '../../lib/auth/sessionState';

const BASH = '```bash\necho ciao\n```';

function owner(commandShell = true) {
  publishSession({ status: 'paired', as: 'loopback', name: 'Mac', role: 'owner', commandShell });
}
afterEach(() => __resetSessionForTests());

const render = (props: Partial<Parameters<typeof MessageContent>[0]>) =>
  renderToStaticMarkup(createElement(MessageContent, {
    content: BASH, role: 'assistant', sessionKey: 'topic:x', messageId: 'm-1', runnable: true, ...props,
  }));
const hasRun = (html: string) => html.includes('data-testid="code-run"');
const hasTerminal = (html: string) => html.includes('data-testid="code-open-terminal"');

describe('Run on a code block', () => {
  test('a finished reply of the agent: Run and Open in terminal beside Copy', () => {
    owner();
    const html = render({});
    expect(hasRun(html)).toBe(true);
    expect(hasTerminal(html)).toBe(true);
  });

  test('also when the reply is a timeline of blocks', () => {
    owner();
    expect(hasRun(render({ blocks: [{ kind: 'text', text: 'Run this:' }, { kind: 'text', text: BASH }] as never }))).toBe(true);
  });

  test('a console transcript offers Run; an unlabelled block and another language do not', () => {
    owner();
    expect(hasRun(render({ content: '```console\n$ git status\nOn branch main\n```' }))).toBe(true);
    expect(hasRun(render({ content: '```\nsudo wg-quick up edm\n```' }))).toBe(false);
    expect(hasRun(render({ content: '```python\nprint(1)\n```' }))).toBe(false);
  });

  test('while the reply is being written, no Run, even on a block that looks finished', () => {
    owner();
    expect(hasRun(render({ partial: true }))).toBe(false);
    expect(hasRun(render({ partial: true, content: '```bash\nrm -rf ./' }))).toBe(false);
  });

  test('a finished reply cut inside its fence (Stop, a restart, an error): no Run on the cut block, the header says why', () => {
    owner();
    const cut = render({ content: 'Pulisco la cache:\n```bash\nrm -rf ./' });
    expect(hasRun(cut)).toBe(false);
    expect(cut).toContain('data-testid="code-run-cut"');
    expect(hasTerminal(cut)).toBe(true);
    const timeline = render({
      content: '',
      blocks: [{ kind: 'text', text: 'Avvio:\n```bash\ngit push origin fea' }, { kind: 'error', message: 'provider error' }] as never,
    });
    expect(hasRun(timeline)).toBe(false);
    // A block the reply closed before the cut still runs.
    expect(hasRun(render({ content: `${BASH}\n\nPoi:\n\`\`\`bash\nrm -rf ./` }))).toBe(true);
  });

  test("a person's own message: no Run", () => {
    owner();
    expect(hasRun(render({ role: 'user' }))).toBe(false);
  });

  test('outside the chat (the task drawer leaves `runnable` off) and without ids: no Run', () => {
    owner();
    expect(hasRun(render({ runnable: false }))).toBe(false);
    expect(hasRun(render({ messageId: undefined }))).toBe(false);
    expect(hasRun(render({ sessionKey: undefined }))).toBe(false);
  });

  test('the markdown of a file preview, which shares the same components: no Run', () => {
    owner();
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { components: markdownComponents, children: BASH }));
    // Text, not markup: once another file has registered highlight.js's bash, `echo` sits in its own span.
    expect(html.replace(/<[^>]+>/g, '')).toContain('echo ciao');
    expect(hasRun(html)).toBe(false);
    expect(hasTerminal(html)).toBe(false);
  });

  test('a guest, a server without a shell, a session not known yet: no Run', () => {
    publishSession({ status: 'paired', as: 'device', name: 'Phone', role: 'guest', commandShell: true });
    expect(hasRun(render({}))).toBe(false);
    owner(false);
    expect(hasRun(render({}))).toBe(false);
    __resetSessionForTests();
    expect(hasRun(render({}))).toBe(false);
  });

  test('invisible characters: no Run, the header says why, Open in terminal stays', () => {
    owner();
    const html = render({ content: '```bash\necho ok‮\n```' });
    expect(hasRun(html)).toBe(false);
    expect(html).toContain('data-testid="code-run-blocked"');
    expect(hasTerminal(html)).toBe(true);
  });
});
