/**
 * What a conversation with the AI is made of, as props: messages, and in a
 * reply the text with the things it names (a card, a contract, a flow) as
 * tokens that open them. Plain data, so a conversation is kept in the saved
 * state of the preview as it is and drawn again by `ChatPanel`.
 */
import type { Tone } from '../types';

export type ChatRefKind = 'card' | 'contract' | 'flow' | 'document' | 'list';

/** A thing the reply names: a token that opens its page. */
export interface ChatRef {
  kind: ChatRefKind;
  id: string;
  /** What the token says: the id of a card, the name of a flow. */
  label: string;
  /** What follows the label, dimmer: the title of a card. */
  detail?: string;
  /** Where it opens. */
  path: string;
  /** The flow a card or a flow token belongs to: its icon is the one the flow has everywhere. */
  flow?: string;
  /** Red for a card that is stopped. */
  tone?: Extract<Tone, 'red' | 'amber'>;
}

export interface ChatStrong {
  strong: string;
}

/** A piece of a line: words, words in bold, or a token. */
export type ChatSeg = string | ChatStrong | ChatRef;

export type ChatBlock =
  | { kind: 'text'; segs: ChatSeg[] }
  | { kind: 'list'; items: ChatSeg[][] }
  /** Words taken from an original, with where they are written. */
  | { kind: 'quote'; text: string; from: ChatSeg[] };

export interface ChatReply {
  blocks: ChatBlock[];
  /** Questions to ask next, pressed in place of typing. */
  examples?: string[];
}

export interface ChatMessageModel {
  id: string;
  role: 'user' | 'assistant';
  /** What the person wrote. */
  text?: string;
  /** What came back. */
  reply?: ChatReply;
  at: string;
}

export const isChatRef = (seg: ChatSeg): seg is ChatRef => typeof seg === 'object' && 'path' in seg;

/** A reply as plain words: the line a list of chats shows under the title. */
export function replyText(reply: ChatReply): string {
  const seg = (s: ChatSeg): string => (typeof s === 'string' ? s : isChatRef(s) ? s.label : s.strong);
  const first = reply.blocks[0];
  if (!first) return '';
  if (first.kind === 'text') return first.segs.map(seg).join('');
  if (first.kind === 'list') return first.items[0]?.map(seg).join('') ?? '';
  return first.text;
}
