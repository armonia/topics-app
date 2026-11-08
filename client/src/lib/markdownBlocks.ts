/**
 * Cutting a chat message into the blocks the markdown renderer memoizes.
 *
 * WHY. `react-markdown` parses its whole input on every render. A message that
 * is streaming gets a new `children` string at every frame, so the parser read
 * the entire message again for every token: the work of one token grew with the
 * length of the message (O(n^2) over a reply). Cut into blocks, each block is
 * parsed once, when it is complete, and only the tail (the block still being
 * written) is parsed again: the work of one token stops depending on how much
 * was already written.
 *
 * WHAT A BLOCK IS. A run of lines that ends where a new top-level construct
 * starts. The cut is a function of the TEXT ALONE, never of "is it streaming":
 * if it depended on that, the blocks would merge into one when the stream ends
 * and every mermaid diagram and code block would remount. It is also monotonic:
 * appending text never moves a cut already made, it only grows the last block
 * or adds one after it (but for the markup below that makes the whole message
 * one block, whenever it shows up).
 *
 * WHERE A CUT IS SAFE. Only in front of a COMPLETE line (a line still being
 * typed is ambiguous: `1` may become `1. b`) that
 *   - follows a blank line,
 *   - starts at column 0 (an indented line continues a list item or a code block),
 *   - is not a list item that follows another list item (`- a`, blank, `- b` is
 *     ONE loose list, and cutting it would restart its numbering and change its
 *     spacing),
 *   - and is not inside a code fence (a fence may hold blank lines).
 * A block shorter than `MIN_BLOCK_CHARS` is never cut off: a processor is built
 * for every `<ReactMarkdown>` instance, so tiny blocks would cost more than
 * they save, and a short message stays ONE block, byte for byte the markdown of
 * before.
 *
 * WHEN IT DOES NOT CUT. Some markdown has an effect on the whole document or
 * runs across blank lines, and cannot be parsed block by block: link reference
 * definitions (`[x]: url`), the footnotes they resemble, `$$` math (which may
 * hold blank lines and is loaded lazily) and the raw HTML blocks that end at a
 * closing marker instead of a blank line (`<!--`, `<pre`, `<script`, `<style`,
 * `<textarea`, `<?`, `<!`). A text with any of them stays one block, which is
 * the cost it had before this existed.
 */
import { fenceAfter } from '../../../shared/cut-fence';

/** A block is not cut off before it holds this many characters. */
export const MIN_BLOCK_CHARS = 1200;

/** A list item at column 0: `- `, `* `, `+ `, `1. `, `1) `. */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
/** `[label]: destination`, which gives meaning to links anywhere in the document. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]/m;
const FOOTNOTE_DEFINITION = /^\[\^[^\]\n]+\]:/m;
/** An HTML block that does not end at a blank line, outside any code fence. */
const OPEN_ENDED_HTML = /^ {0,3}<(?:!|\?|script\b|pre\b|style\b|textarea\b)/i;

/** End of a line's content: before its newline, and before a carriage return that precedes it. */
function contentEnd(text: string, pos: number, lineEnd: number): number {
  if (lineEnd === -1) return text.length;
  return lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
}

function hasDocumentWideMarkup(text: string): boolean {
  return text.includes('$$') || REFERENCE_DEFINITION.test(text) || FOOTNOTE_DEFINITION.test(text);
}

/**
 * The blocks of `text`, in order. `blocks.join('')` is always `text`, so the
 * offset of a block in the message is the sum of the lengths before it.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (text.length < 2 * MIN_BLOCK_CHARS || hasDocumentWideMarkup(text)) return [text];

  const blocks: string[] = [];
  let blockStart = 0;
  let fence: string | null = null;
  let afterBlank = false;
  // The last non-blank line outside a fence was a list item or was indented: the
  // next line at column 0 may be another item of the same list.
  let inList = false;
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos);
    // The last line has no newline yet: it belongs to the tail, whatever it is.
    if (lineEnd === -1) break;
    const line = text.slice(pos, contentEnd(text, pos, lineEnd));
    const next = fenceAfter(fence, line);
    if (fence !== null) {
      // Inside a fence nothing is a blank line and nothing can be cut; closing it
      // does not say anything about the list the fence may sit in.
      fence = next;
      afterBlank = false;
    } else if (line.trim() === '') {
      afterBlank = true;
    } else {
      if (OPEN_ENDED_HTML.test(line)) return [text];
      const indented = line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9;
      const item = !indented && LIST_ITEM.test(line);
      if (afterBlank && !indented && !(item && inList) && pos - blockStart >= MIN_BLOCK_CHARS) {
        blocks.push(text.slice(blockStart, pos));
        blockStart = pos;
      }
      inList = indented || item;
      afterBlank = false;
      fence = next;
    }
    pos = lineEnd + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

/** Where the fences of `text` stand at its end: the line that opened the one still open, and where the last closed one ended. */
function scanFences(text: string): { openAt: number | null; closedEnd: number } {
  let fence: string | null = null;
  let openAt = 0;
  let closedEnd = 0;
  let pos = 0;
  for (;;) {
    const lineEnd = text.indexOf('\n', pos);
    const next = fenceAfter(fence, text.slice(pos, contentEnd(text, pos, lineEnd)));
    if (fence === null && next !== null) openAt = pos;
    if (fence !== null && next === null) closedEnd = lineEnd === -1 ? text.length : lineEnd + 1;
    fence = next;
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return { openAt: fence === null ? null : openAt, closedEnd };
}

/**
 * Offset of the line that opened the code fence `text` leaves open at its end,
 * or null when every fence is closed. A code block that starts there is still
 * being written.
 */
export function openFenceStart(text: string): number | null {
  return scanFences(text).openAt;
}

/**
 * Closes the markdown a half-written block leaves open, so that `**bo` is not
 * drawn as a stray asterisk for a frame. Meant for the TAIL block only, while
 * it streams. An unterminated fence is left alone: markdown ends it at the end
 * of the text by itself.
 */
export function completePartialMarkdown(tail: string): string {
  // Marks inside a code fence are code, not markdown: only what follows the last
  // closed fence can hold an open inline mark.
  const { openAt, closedEnd } = scanFences(tail);
  if (openAt !== null) return tail;
  return tail.slice(0, closedEnd) + closeInlineMarks(tail.slice(closedEnd));
}

function closeInlineMarks(source: string): string {
  let text = source;

  // Open inline code span: count the unescaped backticks.
  let backticks = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`' && (i === 0 || text[i - 1] !== '\\')) backticks++;
  }
  if (backticks % 2 !== 0) text += '`';

  // Open bold marker.
  const boldMarks = text.match(/\*\*/g);
  if (boldMarks && boldMarks.length % 2 !== 0) text += '**';

  // Open italic marker: a single `*` that is not part of `**`.
  const italicMarks = text.replace(/\*\*/g, '').match(/\*/g);
  if (italicMarks && italicMarks.length % 2 !== 0) text += '*';

  // A link or image cut before its closing bracket or parenthesis shows as its text.
  text = text.replace(/!?\[([^\]]*)$/, '$1');
  text = text.replace(/(\[[^\]]*\])\([^)]*$/, '$1');

  return text;
}

/** A tail up to this long is parsed at every flush; a longer one is parsed less often. */
export const TAIL_PARSE_CAP = 3000;
/** The longest a long tail waits between two parses, in flushes (about 0.4 s at 60 fps). */
export const TAIL_MAX_SKIP = 24;

/**
 * Keeps the parse work of the tail block flat when the tail itself cannot be cut:
 * one long code fence, list or paragraph has no safe cut point, so its parse
 * would grow with its length at every flush. Past `TAIL_PARSE_CAP` the tail is
 * parsed once every ceil(length / cap) flushes and the flushes in between draw
 * the last parsed text, so the average work per flush stays about one cap while
 * the screen lags by a few frames at most. A tail that is not a continuation of
 * the last parsed one (a cut moved) or a stream that ended is parsed at once.
 */
export function createTailGate() {
  let parsed = '';
  let skipped = 0;
  return {
    /** The text to draw for this flush. */
    pick(tail: string, streaming: boolean): string {
      const every = Math.min(TAIL_MAX_SKIP, Math.ceil(tail.length / TAIL_PARSE_CAP));
      if (!streaming || every <= 1 || parsed === '' || !tail.startsWith(parsed) || skipped + 1 >= every) {
        parsed = tail;
        skipped = 0;
        return tail;
      }
      skipped++;
      return parsed;
    },
    /** The next pick parses, whatever the wait. */
    release(): void {
      skipped = TAIL_MAX_SKIP;
    },
    /** True while the drawn text is behind the real one: a timer must come back to catch up. */
    behind(tail: string): boolean {
      return parsed !== tail;
    },
  };
}
