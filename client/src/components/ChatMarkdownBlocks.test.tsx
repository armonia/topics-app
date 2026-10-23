/**
 * A message drawn in markdown blocks looks exactly like the same message drawn
 * whole, and a code block knows where it is in the WHOLE message.
 *
 * The reference is one `<ReactMarkdown>` over the entire text, which is how the
 * chat drew every message before blocks. Every prefix of a long message that
 * covers each construct stands in for the moments of a stream.
 * @covers STREAMB-04, CHAT-RUN-03
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatMarkdown, DeepLinkAnchor } from './ChatMarkdown';
import { MessageContent, markdownComponents } from './MessageContent';
import { MarkdownBlockContext } from './Chat/markdownBlockContext';
import { __resetSessionForTests, publishSession } from '../lib/auth/sessionState';
import { completePartialMarkdown, splitMarkdownBlocks } from '../lib/markdownBlocks';
import { LONG_MESSAGE } from '../test/longMarkdownMessage';

/**
 * react-markdown writes a newline text node between two block elements, and a
 * block boundary has none. Nothing is painted between block-level siblings
 * either way (every top-level node of a message is a block), so the comparison
 * ignores that one character and nothing else.
 */
const tidy = (html: string) => html.replace(/>\n</g, '><');

const whole = (text: string) =>
  tidy(renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: { ...markdownComponents, a: ({ href, children }) => createElement(DeepLinkAnchor, { href }, children) },
    children: text,
  })));

const inBlocks = (text: string, streaming = false) =>
  tidy(renderToStaticMarkup(createElement(ChatMarkdown, { components: markdownComponents, streaming, children: text })));

describe('the same markup, in blocks or whole', () => {
  test('a long message with every construct', () => {
    expect(splitMarkdownBlocks(LONG_MESSAGE).length).toBeGreaterThan(3);
    expect(inBlocks(LONG_MESSAGE)).toBe(whole(LONG_MESSAGE));
  });

  test('at every point of the stream', () => {
    let checked = 0;
    for (let end = 337; end < LONG_MESSAGE.length; end += 337) {
      const prefix = LONG_MESSAGE.slice(0, end);
      // Once the stream is over the message is drawn as it is; while it runs the
      // tail has its open marks closed.
      expect(inBlocks(prefix)).toBe(whole(prefix));
      expect(inBlocks(prefix, true)).toBe(whole(completePartialMarkdown(prefix)));
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('a message with markup that works on the whole document is drawn whole, as before', () => {
    const text = `${LONG_MESSAGE}\nSee [the note][n].\n\n[n]: https://example.com/note\n`;
    expect(splitMarkdownBlocks(text)).toHaveLength(1);
    expect(inBlocks(text)).toBe(whole(text));
    expect(inBlocks(text)).toContain('href="https://example.com/note"');
  });
});

/** Stands in for `pre` and says where the fence is, the way the real code block reads it. */
function seenFences() {
  const seen: Array<{ at: number; live: boolean }> = [];
  function Fence({ node }: ExtraProps) {
    const place = useContext(MarkdownBlockContext);
    const start = node!.position!.start.offset!;
    seen.push({ at: place.offset + start, live: place.openFenceFrom !== null && start >= place.openFenceFrom });
    return null;
  }
  return { seen, Fence };
}

describe('where a code block is', () => {
  test('its place in the WHOLE message, which is the key of its Run button', () => {
    const { seen, Fence } = seenFences();
    renderToStaticMarkup(createElement(ChatMarkdown, { components: { pre: Fence }, children: LONG_MESSAGE }));
    for (const marker of ['```bash\necho one', '~~~python', '```mermaid', '```bash\necho two']) {
      expect(seen.map((s) => s.at)).toContain(LONG_MESSAGE.indexOf(marker));
    }
    // Four of them are further than the first block reaches: a key that was
    // relative to its block would collide with the first block's.
    expect(LONG_MESSAGE.indexOf('```bash\necho two')).toBeGreaterThan(splitMarkdownBlocks(LONG_MESSAGE)[0]!.length);
  });

  test('only the code block still being written is live, and only while the stream runs', () => {
    const text = `${LONG_MESSAGE}\n\`\`\`ts\nconst a = 1\n`;
    const open = text.lastIndexOf('```ts');
    const streaming = seenFences();
    renderToStaticMarkup(createElement(ChatMarkdown, { components: { pre: streaming.Fence }, streaming: true, children: text }));
    expect(streaming.seen.filter((s) => s.live).map((s) => s.at)).toEqual([open]);
    expect(streaming.seen.length).toBeGreaterThan(4);

    const settled = seenFences();
    renderToStaticMarkup(createElement(ChatMarkdown, { components: { pre: settled.Fence }, children: text }));
    expect(settled.seen.some((s) => s.live)).toBe(false);
  });
});

describe('Run on a reply in blocks', () => {
  afterEach(() => __resetSessionForTests());

  test('is offered on every command block, whichever block of the reply it is in', () => {
    publishSession({ status: 'paired', as: 'loopback', name: 'Mac', role: 'owner', commandShell: true });
    const html = renderToStaticMarkup(createElement(MessageContent, {
      content: LONG_MESSAGE, role: 'assistant', sessionKey: 'topic:x', messageId: 'm-1', runnable: true,
    }));
    expect(html.match(/data-testid="code-run"/g)).toHaveLength(2);
  });
});
