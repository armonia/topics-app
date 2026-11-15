/**
 * The channel chip: which Jarvis channel a card's work came from, one click from its chat.
 * @covers KANBAN-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { channelChip } from './channelChip';
import { ChannelChipView } from './ChannelChipView';

const tr = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`;

type Props = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function find(node: ReactNode, test: (el: ReactElement<Props>) => boolean): ReactElement<Props> | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Props>;
  if (test(el)) return el;
  const kids = el.props.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = find(kid, test);
    if (hit) return hit;
  }
  return null;
}

describe('channelChip', () => {
  test('a card whose chat is a Discord channel names the channel and its chat', () => {
    const chip = channelChip({ channel: { kind: 'discord', topicId: 'chan-1', name: '#Video Zeno: musica e voce da rifare' } }, tr);
    expect(chip).toMatchObject({ kind: 'discord', topicId: 'chan-1', name: '#Video Zeno: musica e voce da rifare' });
    expect(chip!.title).toContain('Discord');
    expect(chip!.title).toContain('#Video Zeno');
  });
  test('no channel, or no chat to open, is no chip', () => {
    expect(channelChip({}, tr)).toBeNull();
    expect(channelChip({ channel: { kind: 'whatsapp', topicId: '', name: 'x' } }, tr)).toBeNull();
  });
  test('a chat with no name still says the channel word', () => {
    expect(channelChip({ channel: { kind: 'whatsapp', topicId: 'w', name: '  ' } }, tr)!.name).toBe('WhatsApp');
  });
});

describe('ChannelChipView', () => {
  const chip = channelChip({ channel: { kind: 'whatsapp', topicId: 'chan-w', name: 'Gruppo Studio' } }, tr)!;
  test('draws the brand mark, the word Jarvis and the channel name', () => {
    const html = renderToStaticMarkup(<ChannelChipView chip={chip} jarvis="Jarvis" />);
    expect(html).toContain('data-testid="card-channel"');
    expect(html).toContain('data-channel-kind="whatsapp"');
    expect(html).toContain('aria-label="WhatsApp"');
    expect(html).toContain('>Jarvis<');
    expect(html).toContain('>Gruppo Studio<');
  });
  test('the click opens the channel chat through the in-app door and stops the card from opening', () => {
    const routed: unknown[] = [];
    const notified: string[] = [];
    const door = ((target: unknown, opts?: { notify?: (m: string) => void }) => { routed.push(target); opts?.notify?.('gone'); }) as never;
    const view = ChannelChipView({ chip, jarvis: 'Jarvis', notify: (m) => notified.push(m), open: door });
    const button = find(view, (el) => el.type === 'button')!;
    let stopped = false;
    button.props.onClick({ stopPropagation: () => { stopped = true; } });
    expect(routed).toEqual([{ kind: 'chat', key: 'chan-w' }]);
    expect(notified).toEqual(['gone']);
    expect(stopped).toBe(true);
  });
});
