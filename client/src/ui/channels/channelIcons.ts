import { Globe, Mail, MailCheck, MessageCircle, MessagesSquare, Phone, ReceiptText, Send, type LucideIcon } from 'lucide-react';
import type { ChannelIconKey } from './model';

/** One glyph per channel, Lucide like the rest of the product. */
export const CHANNEL_ICON: Record<ChannelIconKey, LucideIcon> = {
  pec: MailCheck,
  mail: Mail,
  whatsapp: MessageCircle,
  teams: MessagesSquare,
  telefono: Phone,
  portale: Globe,
  sdi: ReceiptText,
  send: Send,
};
