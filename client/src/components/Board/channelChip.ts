import type { ChannelKind } from '../../../../shared/channel-origin';
import type { BoardTask } from '../../lib/board';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface ChannelChip {
  kind: ChannelKind;
  /** The channel's name as Jarvis' chat is called in Topics. */
  name: string;
  /** The whole sentence, for the tooltip and the accessible name. */
  title: string;
  /** The channel chat to open on click. */
  topicId: string;
}

const CHANNEL_WORD: Record<ChannelKind, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };

/**
 * The channel a card's work came from: Jarvis follows it in a Discord channel
 * or a WhatsApp group, and the card says which. Nothing for a card with no
 * channel chat behind it (the server only sends `channel` while that chat
 * still exists), so there is never a link to a ghost.
 */
export function channelChip(task: Pick<BoardTask, 'channel'>, tr: Translate): ChannelChip | null {
  const channel = task.channel;
  if (!channel?.topicId) return null;
  const name = channel.name.trim() || CHANNEL_WORD[channel.kind];
  return {
    kind: channel.kind,
    name,
    topicId: channel.topicId,
    title: tr('board.card.channelTitle', { channel: CHANNEL_WORD[channel.kind], name }),
  };
}
