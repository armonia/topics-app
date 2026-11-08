import type { PaneFinder, FindStepResult } from '../state/findRegistry';
import { stepMatchIndex } from '../components/Browser/findInPageModel';
import { clearFindHighlights, setFindHighlights } from './findHighlights';

/**
 * A finder over the text of a DOM subtree: the Markdown preview (FILE-FIND-02)
 * and the shared browser's rrweb mirror (BROWSER-FIND-04). Not for virtual
 * lists: what is not in the DOM is not found, which is the reason the chat
 * and the diff use their own engines.
 *
 * The text is read the way a person reads it: the text nodes in document
 * order, joined inside one block (so "Instal<b>lation</b>" is found) and
 * separated between blocks (so the end of a heading and the start of the
 * next paragraph do not make a word that is not there).
 *
 * Highlights go through the CSS Custom Highlight API of the subtree's own
 * document (`find-hit`, `find-current`): no `<mark>` is inserted, so nothing
 * moves and nothing a renderer owns is touched.
 */

/** The node shape the walker reads. A real DOM node satisfies it; so does a
 *  plain object in a test. */
export interface TextNodeLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<TextNodeLike>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD', 'TITLE']);
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD',
  'TR', 'UL', 'BODY',
]);
/** Between two blocks: a character no query contains. */
const BOUNDARY = '\u0000';

export interface TextSegment<N> { node: N; start: number; length: number }
export interface CollectedText<N> { text: string; segments: TextSegment<N>[] }

/** The subtree's text in document order, with where each node starts. */
export function collectText<N extends TextNodeLike>(root: N): CollectedText<N> {
  let text = '';
  const segments: TextSegment<N>[] = [];
  const boundary = () => { if (text && !text.endsWith(BOUNDARY)) text += BOUNDARY; };
  const walk = (n: TextNodeLike) => {
    if (n.nodeType === TEXT_NODE) {
      const v = n.nodeValue ?? '';
      if (v) { segments.push({ node: n as N, start: text.length, length: v.length }); text += v; }
      return;
    }
    if (n.nodeType !== ELEMENT_NODE && n.nodeType !== 9 && n.nodeType !== 11) return;
    const name = n.nodeName.toUpperCase();
    if (SKIP.has(n.nodeName) || SKIP.has(name)) return;
    const block = BLOCK.has(name);
    if (block) boundary();
    for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]!);
    if (block) boundary();
  };
  walk(root);
  return { text, segments };
}

/** Start/end offsets of the non-overlapping matches. */
export function findMatches(text: string, query: string, matchCase: boolean): Array<[number, number]> {
  if (!query) return [];
  const h = matchCase ? text : text.toLowerCase();
  const q = matchCase ? query : query.toLowerCase();
  const out: Array<[number, number]> = [];
  let at = h.indexOf(q);
  while (at !== -1) {
    out.push([at, at + q.length]);
    at = h.indexOf(q, at + q.length);
  }
  return out;
}

/** The node and the offset inside it for a position in the collected text. */
export function locate<N>(segments: readonly TextSegment<N>[], offset: number, end: boolean): { node: N; offset: number } | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    // An end offset that falls exactly on a node's end belongs to that node.
    if (end ? offset <= s.start : offset < s.start) hi = mid - 1;
    else if (end ? offset > s.start + s.length : offset >= s.start + s.length) lo = mid + 1;
    else return { node: s.node, offset: offset - s.start };
  }
  return null;
}

/** The `::highlight()` rules, for a document that does not load the app's CSS (an iframe). */
export const FIND_HIGHLIGHT_CSS =
  '::highlight(find-hit){background-color:rgba(250,204,21,.45);color:inherit}' +
  '::highlight(find-current){background-color:rgba(249,115,22,.85);color:#000}';

export function injectFindHighlightStyle(doc: Document | null): void {
  if (!doc?.head || doc.getElementById('topics-find-highlight')) return;
  const style = doc.createElement('style');
  style.id = 'topics-find-highlight';
  style.textContent = FIND_HIGHLIGHT_CSS;
  doc.head.appendChild(style);
}

export interface DomFinderOptions {
  /** The subtree to search; read at every search, the node can change. */
  root: () => Element | null;
  /** A recount after the subtree changed on its own (rrweb mutations). */
  onRecount?: (r: { total: number; index: number }) => void;
  /** Watch the subtree and recount at most every 120 ms. */
  observeMutations?: boolean;
  /** Inject the `::highlight()` rules in the root's document (an iframe). */
  injectStyle?: boolean;
  placeholderKey?: string;
}

export interface DomFinder extends PaneFinder {
  /** Recount now (what the mutation observer calls). */
  recount(): void;
  dispose(): void;
}

let finderSeq = 0;

/** A {@link PaneFinder} over a DOM subtree. */
export function createDomFinder(opts: DomFinderOptions): DomFinder {
  let query = '';
  let matchCase = false;
  let index = 0;
  let ranges: Range[] = [];
  let total = 0;
  let observer: MutationObserver | null = null;
  let throttle: ReturnType<typeof setTimeout> | null = null;

  const docOf = () => opts.root()?.ownerDocument ?? null;
  const owner = `dom-find-${++finderSeq}`;

  const paint = () => {
    const doc = docOf();
    if (!doc || ranges.length === 0) { clearFindHighlights(owner); return; }
    setFindHighlights(owner, doc, ranges, index > 0 ? ranges[index - 1]! : null);
  };

  const compute = (): number => {
    const root = opts.root();
    const doc = root?.ownerDocument;
    ranges = [];
    if (!root || !doc || !query) { total = 0; return 0; }
    const { text, segments } = collectText(root as unknown as TextNodeLike);
    const matches = findMatches(text, query, matchCase);
    total = matches.length;
    for (const [s, e] of matches) {
      const a = locate(segments, s, false);
      const b = locate(segments, e, true);
      if (!a || !b) continue;
      try {
        const r = doc.createRange();
        r.setStart(a.node as unknown as Node, a.offset);
        r.setEnd(b.node as unknown as Node, b.offset);
        ranges.push(r);
      } catch { /* a node detached mid-walk: skipped */ }
    }
    return total;
  };

  const watch = () => {
    if (!opts.observeMutations || observer || typeof MutationObserver === 'undefined') return;
    const root = opts.root();
    if (!root) return;
    observer = new MutationObserver(() => {
      if (throttle) return;
      throttle = setTimeout(() => { throttle = null; finder.recount(); }, 120);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
  };

  const stopWatching = () => {
    observer?.disconnect();
    observer = null;
    if (throttle) clearTimeout(throttle);
    throttle = null;
  };

  const finder: DomFinder = {
    placeholderKey: opts.placeholderKey,
    debounceMs: 80,
    search(q, o) {
      query = q;
      matchCase = o.matchCase;
      index = 0;
      if (opts.injectStyle) injectFindHighlightStyle(docOf());
      const n = compute();
      paint();
      watch();
      return n;
    },
    step(forward): FindStepResult {
      if (total === 0) compute();
      index = stepMatchIndex(index, total, forward);
      paint();
      const r = index > 0 ? ranges[index - 1] : undefined;
      const el = r?.startContainer?.parentElement;
      el?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      return { index, total };
    },
    clear() {
      query = '';
      index = 0;
      ranges = [];
      total = 0;
      stopWatching();
      clearFindHighlights(owner);
    },
    recount() {
      if (!query) return;
      const before = total;
      compute();
      if (index > total) index = total;
      paint();
      if (total !== before) opts.onRecount?.({ total, index });
    },
    dispose() {
      finder.clear();
    },
  };
  return finder;
}
