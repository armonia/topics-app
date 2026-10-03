/**
 * Find inside ONE conversation: the pure search shared by the server route
 * (`POST /api/history-find`, which sees the tool outputs the client never
 * receives) and the client (the message still streaming, and the guest who
 * has no access to that route). CHAT-FIND-01.
 *
 * Una funzione sola per i due lati, perché il contatore somma i risultati del
 * server e quelli del messaggio in streaming: due regole diverse per «dove sta
 * una parola» darebbero un totale che salta quando il turno finisce.
 *
 * What is searched, per message, in the order the conversation shows it:
 * - with `blocks` (the timeline the bubble draws): each block in order, text
 *   and error as `text`, reasoning as `thinking`, every tool call as `tool`;
 * - without `blocks` (legacy rows): `content`, then `thinking`, then the
 *   legacy `toolCalls`.
 * A tool call is searched in its typed `detail` (command, output, file path,
 * sub-agent actions: every string leaf) or, when `detail` is absent, in its
 * `args` and `result`; its `error` in both cases.
 *
 * Matches do not overlap, like the find of a browser: «aaa» holds one «aa».
 */

/** The three places a hit can be in. */
export type ChatFindPart = 'text' | 'thinking' | 'tool';

export interface ChatFindHit {
  messageId: string;
  part: ChatFindPart;
  /** Only for `part: 'tool'`. */
  toolCallId?: string;
  /** Position of the match inside the searched text of that part. */
  offset: number;
}

export interface ChatFindResult {
  /** Exact, even past the cap on `hits`. */
  total: number;
  hits: ChatFindHit[];
  /** True when `total` is larger than the hits returned. */
  truncated: boolean;
}

/** At most this many positions travel; the total stays exact. */
export const CHAT_FIND_MAX_HITS = 5000;

/** The tool call fields this module reads. Loose on purpose: the server's
 *  stored row and the client's lean row are both accepted. */
export interface FindableToolCall {
  id: string;
  args?: Record<string, unknown> | null;
  result?: string;
  error?: string;
  detail?: unknown;
}

export type FindableBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'tool'; toolCall: FindableToolCall }
  | { kind: string; [key: string]: unknown };

export interface FindableMessage {
  id: string;
  content?: string;
  thinking?: string;
  blocks?: readonly FindableBlock[] | null;
  toolCalls?: readonly FindableToolCall[] | null;
}

export interface ChatFindOptions {
  matchCase: boolean;
  /** Defaults to {@link CHAT_FIND_MAX_HITS}. */
  maxHits?: number;
}

/** Every string leaf of a JSON-ish value, depth-first. `type` keys are the
 *  discriminant of a typed detail, not something a person reads. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'type') continue;
      collectStrings(v, out, depth + 1);
    }
  }
}

/** The text a tool call is searched in: its typed detail, or args + result. */
export function toolSearchText(tc: FindableToolCall): string {
  const parts: string[] = [];
  if (tc.detail && typeof tc.detail === 'object') {
    collectStrings(tc.detail, parts);
  } else {
    collectStrings(tc.args ?? null, parts);
    if (typeof tc.result === 'string' && tc.result) parts.push(tc.result);
  }
  if (typeof tc.error === 'string' && tc.error) parts.push(tc.error);
  return parts.join('\n');
}

/** Offsets of the non-overlapping occurrences of `needle` in `hay`. `needle`
 *  is already lowercased when `matchCase` is false. */
function eachOccurrence(hay: string, needle: string, matchCase: boolean, onHit: (offset: number) => void): void {
  if (!hay || !needle) return;
  const h = matchCase ? hay : hay.toLowerCase();
  let at = h.indexOf(needle);
  while (at !== -1) {
    onHit(at);
    at = h.indexOf(needle, at + needle.length);
  }
}

/** Number of non-overlapping occurrences: the same rule `chatFind` counts by. */
export function countOccurrences(hay: string, query: string, matchCase: boolean): number {
  if (!query) return 0;
  let n = 0;
  eachOccurrence(hay, matchCase ? query : query.toLowerCase(), matchCase, () => { n++; });
  return n;
}

/** The searchable parts of one message, in the order the bubble shows them. */
export function messageParts(m: FindableMessage): Array<{ part: ChatFindPart; text: string; toolCallId?: string }> {
  const out: Array<{ part: ChatFindPart; text: string; toolCallId?: string }> = [];
  const blocks = Array.isArray(m.blocks) ? m.blocks : null;
  if (blocks && blocks.length > 0) {
    for (const b of blocks) {
      if ((b.kind === 'text' || b.kind === 'error') && typeof b.text === 'string') out.push({ part: 'text', text: b.text });
      else if (b.kind === 'thinking' && typeof b.text === 'string') out.push({ part: 'thinking', text: b.text });
      else if (b.kind === 'tool' && b.toolCall && typeof b.toolCall === 'object') {
        const tc = b.toolCall as FindableToolCall;
        out.push({ part: 'tool', text: toolSearchText(tc), toolCallId: tc.id });
      }
    }
    return out;
  }
  if (typeof m.content === 'string' && m.content) out.push({ part: 'text', text: m.content });
  if (typeof m.thinking === 'string' && m.thinking) out.push({ part: 'thinking', text: m.thinking });
  for (const tc of m.toolCalls ?? []) out.push({ part: 'tool', text: toolSearchText(tc), toolCallId: tc.id });
  return out;
}

/**
 * Search `messages` (in conversation order) for `query`. An empty query finds
 * nothing. Without `matchCase` the comparison ignores case.
 */
export function chatFind(messages: readonly FindableMessage[], query: string, opts: ChatFindOptions): ChatFindResult {
  const result: ChatFindResult = { total: 0, hits: [], truncated: false };
  if (!query) return result;
  appendChatFind(result, messages, query, opts);
  return result;
}

/**
 * The same search, appended to a result being built. The server route feeds
 * it one batch of messages at a time so a long chat never holds the event
 * loop for the whole read.
 */
export function appendChatFind(into: ChatFindResult, messages: readonly FindableMessage[], query: string, opts: ChatFindOptions): void {
  if (!query) return;
  const cap = opts.maxHits ?? CHAT_FIND_MAX_HITS;
  const needle = opts.matchCase ? query : query.toLowerCase();
  for (const m of messages) {
    for (const p of messageParts(m)) {
      eachOccurrence(p.text, needle, opts.matchCase, (offset) => {
        into.total++;
        if (into.hits.length < cap) {
          into.hits.push(p.part === 'tool'
            ? { messageId: m.id, part: 'tool', toolCallId: p.toolCallId, offset }
            : { messageId: m.id, part: p.part, offset });
        } else {
          into.truncated = true;
        }
      });
    }
  }
}

/**
 * The hits of the conversation with one message's hits REPLACED by a fresh
 * client-side search (the message streaming right now). The replaced hits
 * keep their place in the order: a message's hits are contiguous, so the new
 * ones go where the old ones were, or at the end when the message is new.
 * CHAT-FIND-01, CHAT-FIND-03.
 */
export function mergeLiveHits(base: readonly ChatFindHit[], messageId: string, live: readonly ChatFindHit[]): ChatFindHit[] {
  const first = base.findIndex((h) => h.messageId === messageId);
  const rest = base.filter((h) => h.messageId !== messageId);
  if (first < 0) return [...rest, ...live];
  return [...rest.slice(0, first), ...live, ...rest.slice(first)];
}
