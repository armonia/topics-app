/**
 * The channel (Discord, WhatsApp, Telegram) a card came from. jarvis-channels
 * gives every channel chat it opens in Topics a brand name in `icon`; that is
 * the whole contract, so the board never needs a list of channel ids.
 */
export type ChannelKind = "discord" | "whatsapp" | "telegram";

const KIND_BY_ICON: Record<string, ChannelKind> = {
  Discord: "discord",
  WhatsApp: "whatsapp",
  Telegram: "telegram",
};

/** The channel a chat belongs to from its `icon`, or null for an ordinary chat. */
export function channelKindOfIcon(icon: string | null | undefined): ChannelKind | null {
  return (icon && Object.prototype.hasOwnProperty.call(KIND_BY_ICON, icon) ? KIND_BY_ICON[icon] : null) ?? null;
}

/**
 * Where a channel chat lives, resolved by the server from the channel bridge's
 * data: `server › channel › thread` on Discord, a group on WhatsApp. Every
 * level is optional; a thread has `thread` set.
 */
export interface ChannelPlace {
  server?: string;
  channel?: string;
  thread?: string;
}
