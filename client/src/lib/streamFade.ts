/**
 * Entrance of live text (card cd66c3bd): each piece that arrives while a turn is
 * being written fades from transparent to opaque in STREAM_FADE_MS, already in
 * its final place. The text is in the DOM from the render it arrives in: only
 * its opacity moves, never its layout, so the fade adds no delay and no shift.
 *
 * While a block is fading, EVERY piece logged since mount is its own span, in
 * order. The text only grows at the end, so the spans before the newest keep
 * their place and their React key: a piece's span is never reused for another
 * piece, and its one-shot animation simply runs once from the frame it appears.
 * Text already present when the component mounts (history, a remount mid-turn)
 * is not logged and never fades. prefers-reduced-motion and a window without
 * focus (`.anims-paused`) turn the animation off in index.css.
 */
import { useRef } from 'react';

// The few hast shapes the plugin touches, written here so the client does not
// depend on the hast types package directly.
interface Text { type: 'text'; value: string; position?: { start: { offset?: number }; end: { offset?: number } } }
interface Element { type: 'element'; tagName: string; properties: Record<string, unknown>; children: ElementContent[] }
type ElementContent = Text | Element | { type: 'comment' | 'raw'; value: string };
type RootContent = ElementContent | { type: 'doctype' };
interface Root { type: 'root'; children: RootContent[] }

export const STREAM_FADE_MS = 150;

/** A slice [from, to) of the text that arrived at `at` (ms, performance clock). */
export interface Arrival {
  from: number;
  to: number;
  at: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The log behind useStreamArrivals, with the clock passed in. Appends are logged
 * as they are rendered; a text that gets shorter was rewritten and starts a
 * fresh log, and a finished turn logs nothing.
 */
export function createArrivalLog(initialLength: number) {
  let seen = initialLength;
  let arrivals: Arrival[] = [];
  return {
    update(length: number, live: boolean, t: number): Arrival[] {
      if (!live || length < seen) {
        seen = length;
        arrivals = [];
        return arrivals;
      }
      if (length > seen) {
        arrivals = [...arrivals, { from: seen, to: length, at: t }];
        seen = length;
      }
      return arrivals;
    },
  };
}

export function useStreamArrivals(text: string, live: boolean): { arrivals: Arrival[]; now: number } {
  const log = useRef<ReturnType<typeof createArrivalLog> | null>(null);
  log.current ??= createArrivalLog(text.length);
  const t = now();
  return { arrivals: log.current.update(text.length, live, t), now: t };
}

export interface FadeSegment {
  text: string;
  /** True for a logged piece (its own span); false for text present at mount. */
  piece: boolean;
  /** A piece that arrived less than STREAM_FADE_MS before `t`: its span animates. */
  fresh?: boolean;
}

/**
 * `value` cut at the edges of the logged pieces. `start` is where `value` sits
 * in the text the arrivals refer to. The segments always join back into `value`:
 * the fade decides how a piece looks, never whether it is there.
 */
export function fadeSegments(value: string, start: number, arrivals: Arrival[], t = Infinity): FadeSegment[] {
  const end = start + value.length;
  const cuts = arrivals.filter((a) => a.to > start && a.from < end);
  if (cuts.length === 0) return [{ text: value, piece: false }];
  const out: FadeSegment[] = [];
  let at = start;
  for (const a of cuts) {
    const from = Math.max(a.from, at);
    const to = Math.min(a.to, end);
    if (to <= from) continue;
    if (from > at) out.push({ text: value.slice(at - start, from - start), piece: false });
    out.push({ text: value.slice(from - start, to - start), piece: true, fresh: t - a.at < STREAM_FADE_MS });
    at = to;
  }
  if (at < end) out.push({ text: value.slice(at - start), piece: false });
  return out;
}

/**
 * Rehype plugin for one markdown block: every logged piece becomes its own span,
 * with `class="stream-fade"` while it is younger than STREAM_FADE_MS at `t`. A
 * piece that has aged keeps its (now plain) span, so the spans after it keep
 * their keys, and a remounted span of an old piece does not fade again. `base` is where the block starts in the whole
 * message. A text node is placed by its END offset: new text arrives at the end,
 * and the end stays exact when entities or escapes make the source longer than
 * the text. Code is left alone (its renderers expect plain strings), and so is a
 * text with an `@` (the mention highlighter reads plain strings too).
 */
export function rehypeStreamFade(options: { base: number; arrivals: Arrival[]; t: number }) {
  const { base, arrivals, t } = options;
  const wrap = (children: Array<RootContent | ElementContent>) => {
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type === 'element') {
        if (node.tagName !== 'pre' && node.tagName !== 'code') wrap(node.children);
        continue;
      }
      if (node.type !== 'text' || node.position?.end.offset == null || node.value.includes('@')) continue;
      const start = base + node.position.end.offset - node.value.length;
      const segments = fadeSegments(node.value, start, arrivals, t);
      if (segments.length === 1 && !segments[0].piece) continue;
      const nodes: ElementContent[] = segments.map((s): ElementContent =>
        s.piece
          ? { type: 'element', tagName: 'span', properties: s.fresh ? { className: ['stream-fade'] } : {}, children: [{ type: 'text', value: s.text }] }
          : ({ type: 'text', value: s.text } satisfies Text),
      );
      children.splice(i, 1, ...nodes);
      i += nodes.length - 1;
    }
  };
  return (tree: Root) => wrap(tree.children);
}
