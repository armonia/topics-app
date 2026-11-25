/** A channel's brand name ("Discord", never "discord"); an account suffix (`discord:visione`) is dropped. */
const BRAND: Record<string, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };

export function channelBrand(channel: string): string {
  const base = channel.split(':')[0];
  return BRAND[base] ?? base;
}
