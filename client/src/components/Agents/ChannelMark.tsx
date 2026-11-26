/** The brand mark of a channel (Discord, WhatsApp, Telegram), or nothing for a channel without one. */
import { CHANNEL_MARKS } from '../../lib/brandIcons';
import { channelBrand } from './channelBrand';

export function ChannelMark({ channel, className = 'h-3.5 w-3.5 flex-shrink-0' }: { channel: string; className?: string }) {
  const Mark = CHANNEL_MARKS[channelBrand(channel)];
  return Mark ? <Mark className={className} aria-hidden /> : null;
}
