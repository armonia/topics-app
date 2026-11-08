import type { ChatMessage } from '../../types';

const SILENT_TOKENS = ['NO_REPLY', 'ANNOUNCE_SKIP'];

function hasWork(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && (
    (Array.isArray(msg.blocks) && msg.blocks.length > 0) ||
    (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0)
  );
}

/** Drops a trailing silent token, returning the prose before it (may be empty). */
function stripSilentToken(text: string): string | null {
  for (const token of SILENT_TOKENS) {
    if (text === token) return '';
    if (text.endsWith(token)) return text.slice(0, -token.length).trim();
  }
  return null;
}

/**
 * Decides what the chat shows for one settled message. Returns the message to
 * render (possibly with the silent marker stripped) or null to hide it.
 * A silent marker hides only the marker: the tools and prose that came with it
 * are real work and must stay visible.
 */
export function toVisibleMessage(msg: ChatMessage): ChatMessage | null {
  if (msg.role === 'assistant' && msg.partial) return msg;
  const c = msg.content?.trim();
  if (!c) return hasWork(msg) ? msg : null;
  if (c.startsWith('Agent-to-agent announce step')) return null;
  const stripped = stripSilentToken(c);
  if (stripped === null) return msg;
  if (stripped) return { ...msg, content: stripped };
  return hasWork(msg) ? { ...msg, content: '' } : null;
}
