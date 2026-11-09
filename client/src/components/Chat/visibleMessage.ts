/**
 * Which settled messages the chat draws, and in what shape.
 *
 * An assistant turn can end with a silent-reply marker (`NO_REPLY`,
 * `ANNOUNCE_SKIP`). The marker is protocol, not prose: it must never be drawn,
 * but the tools and text the turn produced before it are real work and must
 * stay. So the marker is stripped from `content` AND from every text block
 * (`MessageContent` draws `blocks` when present, and `turnFold` takes the last
 * text block as the turn's answer), and a text block left empty is not work.
 */
import type { ChatMessage, ContentBlock } from '../../types';

const TRAILING_MARKER = /(?:^|\s)(?:NO_REPLY|ANNOUNCE_SKIP)\s*$/;

export function stripSilentMarker(text: string): string {
  return text.replace(TRAILING_MARKER, '').trim();
}

function cleanBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.kind !== 'text') { out.push(b); continue; }
    const text = stripSilentMarker(b.text);
    if (text) out.push(text === b.text ? b : { ...b, text });
  }
  return out;
}

/** The message as the chat should draw it, or null when it must not appear. */
export function visibleMessage(msg: ChatMessage): ChatMessage | null {
  // Keep partial assistant messages (streaming placeholder)
  if (msg.role === 'assistant' && msg.partial) return msg;
  const raw = msg.content?.trim() ?? '';
  if (raw.startsWith('Agent-to-agent announce step')) return null;

  const content = stripSilentMarker(raw);
  const hasBlocks = Array.isArray(msg.blocks);
  const blocks = hasBlocks ? cleanBlocks(msg.blocks!) : undefined;
  if (content) {
    if (content === raw && blocks === undefined) return msg;
    return { ...msg, content, ...(blocks ? { blocks } : {}) };
  }

  // An assistant turn can legitimately end with no prose: it only ran tools,
  // or it was interrupted before the final text. Keep it when it carries work
  // so the timeline renders instead of the message silently vanishing.
  const hasWork = msg.role === 'assistant' && (
    (blocks?.length ?? 0) > 0 ||
    (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
  );
  if (!hasWork) return null;
  return { ...msg, content: '', ...(blocks ? { blocks } : {}) };
}
