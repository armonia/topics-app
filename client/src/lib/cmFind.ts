import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
  SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll as cmReplaceAll, searchKeymap,
} from '@codemirror/search';
import { getChunks, uncollapseUnchanged } from '@codemirror/merge';
import type { PaneFinder, FindStepResult } from '../state/findRegistry';
import { stepMatchIndex } from '../components/Browser/findInPageModel';

/**
 * The find bar driving CodeMirror's own search engine (FILE-FIND-01, -02).
 *
 * The query goes in with `setSearchQuery`, the editor moves with `findNext` /
 * `findPrevious`, replaces with `replaceNext` / `replaceAll` (one history
 * entry, so ⌘Z undoes it), and the total and the position are counted with
 * `SearchQuery.getCursor` over the whole document, never over the DOM:
 * CodeMirror draws only the lines near the screen, so a DOM count would
 * change while you scroll.
 *
 * CodeMirror's panel no longer opens, and its highlighter of all matches lives
 * INSIDE the panel (`searchHighlighter` draws nothing while it is closed), so
 * the highlighting here is a decoration field of our own, the current match
 * in a colour of its own.
 */

const setFindMarks = StateEffect.define<{ hits: Array<{ from: number; to: number }>; current: { from: number; to: number } | null }>();

const hitMark = Decoration.mark({ class: 'cm-find-hit' });
const currentMark = Decoration.mark({ class: 'cm-find-current' });

const findMarksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFindMarks)) continue;
      const ranges = e.value.hits.map((h) => (
        e.value.current && h.from === e.value.current.from && h.to === e.value.current.to ? currentMark : hitMark
      ).range(h.from, h.to));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The highlighting of the find bar's matches, to add to an editor's extensions. */
export const findMarks: Extension = findMarksField;

/**
 * CodeMirror's search keymap without the keys that would open its panel:
 * ⌘F goes to the app's bar (FIND-02), ⌘G / ⇧⌘G and F3 to the bar's step.
 */
export const searchKeysWithoutPanel = searchKeymap.filter(
  (b) => !['Mod-f', 'Mod-g', 'Shift-Mod-g', 'F3', 'Shift-F3'].includes(b.key ?? ''),
);

/** At most this many matches are painted; the count stays exact. */
const MAX_MARKS = 10_000;

function matchesOf(state: EditorState, query: SearchQuery): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  if (!query.valid) return out;
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) out.push({ from: r.value.from, to: r.value.to });
  return out;
}

/**
 * The collapsed ranges of a merge view's side, recomputed the way
 * `@codemirror/merge` builds them (`buildCollapsedRanges`, margin and minimum
 * size as the viewer passes them). Not exported by the library, and needed to
 * know which fold holds a match: `uncollapseUnchanged` takes the fold's start.
 */
export function collapsedRanges(state: EditorState, margin: number, minLines: number): Array<{ from: number; to: number }> {
  const info = getChunks(state);
  if (!info) return [];
  const isA = info.side === 'a';
  const out: Array<{ from: number; to: number }> = [];
  let prevLine = 1;
  for (let i = 0; ; i++) {
    const chunk = i < info.chunks.length ? info.chunks[i]! : null;
    const collapseFrom = i ? prevLine + margin : 1;
    const collapseTo = chunk ? state.doc.lineAt(isA ? chunk.fromA : chunk.fromB).number - 1 - margin : state.doc.lines;
    if (collapseTo - collapseFrom + 1 >= minLines) {
      out.push({ from: state.doc.line(collapseFrom).from, to: state.doc.line(collapseTo).to });
    }
    if (!chunk) break;
    prevLine = state.doc.lineAt(Math.min(state.doc.length, isA ? chunk.toA : chunk.toB)).number;
  }
  return out;
}

export interface CodeMirrorFinderOptions {
  /** The views searched, in order (the diff: left, then right). */
  views: () => EditorView[];
  /** Replace only on an editable document (FILE-FIND-01). */
  canReplace?: () => boolean;
  /** The merge view's collapse config, to open a fold a match is in. */
  collapse?: { margin: number; minSize: number };
  restoreFocus?: () => void;
}

export function createCodeMirrorFinder(opts: CodeMirrorFinderOptions): PaneFinder {
  let spec = { search: '', caseSensitive: false, replace: '' };
  let index = 0;
  let lastQuery: SearchQuery = new SearchQuery({ search: '' });

  const apply = (q: SearchQuery) => {
    lastQuery = q;
    for (const v of opts.views()) v.dispatch({ effects: setSearchQuery.of(q) });
  };

  /** Every match across the views, in order, with its view. */
  const all = () => {
    const out: Array<{ view: EditorView; from: number; to: number }> = [];
    for (const v of opts.views()) for (const m of matchesOf(v.state, lastQuery)) out.push({ view: v, ...m });
    return out;
  };

  const paint = () => {
    const list = all();
    const cur = index > 0 ? list[index - 1] : undefined;
    for (const v of opts.views()) {
      const hits = list.filter((m) => m.view === v).slice(0, MAX_MARKS).map(({ from, to }) => ({ from, to }));
      v.dispatch({ effects: setFindMarks.of({ hits, current: cur && cur.view === v ? { from: cur.from, to: cur.to } : null }) });
    }
    return list;
  };

  /** Where the main selection of `view` sits among `list`, 1-based. */
  const indexOfSelection = (list: ReturnType<typeof all>, view: EditorView) => {
    const selection = view.state.selection.main;
    const i = list.findIndex((m) => m.view === view && m.from === selection.from && m.to === selection.to);
    return i + 1;
  };

  const openFoldAt = (view: EditorView, pos: number) => {
    if (!opts.collapse) return;
    const views = opts.views();
    const ranges = views.map((v) => collapsedRanges(v.state, opts.collapse!.margin, opts.collapse!.minSize));
    const vi = views.indexOf(view);
    const gap = ranges[vi]?.findIndex((r) => pos >= r.from && pos <= r.to) ?? -1;
    if (gap < 0) return;
    // The two sides fold the same unchanged stretch: open it on both.
    views.forEach((v, k) => {
      const r = ranges[k]?.[gap];
      if (r) v.dispatch({ effects: uncollapseUnchanged.of(r.from) });
    });
  };

  return {
    placeholderKey: 'find.file.placeholder',
    debounceMs: 60,
    search(q, o) {
      spec = { ...spec, search: q, caseSensitive: o.matchCase };
      index = 0;
      apply(new SearchQuery({ ...spec, literal: true }));
      return paint().length;
    },
    step(forward): FindStepResult {
      const views = opts.views();
      if (views.length === 1) {
        // The editor: CodeMirror's own commands move the selection and scroll.
        const v = views[0]!;
        (forward ? findNext : findPrevious)(v);
        const list = all();
        index = indexOfSelection(list, v);
        paint();
        return { index, total: list.length };
      }
      // Two sides: the order is left then right, which no single editor's
      // command knows, so the step is ours and the selection is set directly.
      const list = all();
      index = stepMatchIndex(index, list.length, forward);
      const m = index > 0 ? list[index - 1] : undefined;
      if (m) {
        openFoldAt(m.view, m.from);
        m.view.dispatch({ selection: { anchor: m.from, head: m.to }, effects: EditorView.scrollIntoView(m.from, { y: 'center' }) });
      }
      paint();
      return { index, total: list.length };
    },
    clear() {
      index = 0;
      spec = { ...spec, search: '' };
      apply(new SearchQuery({ search: '' }));
      for (const v of opts.views()) v.dispatch({ effects: setFindMarks.of({ hits: [], current: null }) });
    },
    restoreFocus() { opts.restoreFocus?.(); },
    get replace() {
      if (!opts.canReplace?.()) return undefined;
      return {
        one(text: string): FindStepResult {
          const v = opts.views()[0]!;
          spec = { ...spec, replace: text };
          apply(new SearchQuery({ ...spec, literal: true }));
          // `replaceNext` replaces the selected match (or selects the next).
          replaceNext(v);
          const list = all();
          index = indexOfSelection(list, v);
          paint();
          return { index, total: list.length };
        },
        all(text: string): number {
          const v = opts.views()[0]!;
          const before = all().length;
          spec = { ...spec, replace: text };
          apply(new SearchQuery({ ...spec, literal: true }));
          cmReplaceAll(v);
          index = 0;
          paint();
          return before;
        },
      };
    },
  };
}
