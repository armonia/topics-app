import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { ChevronDown, ChevronRight, FileCode, ImageOff, MessageSquarePlus, Trash2 } from 'lucide-react';
import { boardApi, diffBlobUrl, type DiffBundle, type DiffFileStat, type DiffPanelSource } from '../../lib/board';
import type { DiffRevs } from '../../../../shared/diff-revs';
import { previewTypeOf } from '../../../../shared/preview-kind';
import { parseDiffRows, isCommentable, anchorOf, noteKey, hasNoteWithoutRow, type DiffRow, type DiffNote } from './reviewNotes';
import { buildFileRows, chunkFromFilePatch, type DiffFileChunk } from './diffFileRows';
import { fetchDiffText, previewSides, renderedSide, reportStaleBlob, resolveMarkdownImagePath, type PreviewSide } from './diffPreview';
import { ChangedFileEntry } from '../Git/ChangedFileList';
import { rowFromDiffStat } from '../Git/changedFiles';
import { shortcut } from '../../lib/shortcutLabel';
import { SpinnerFallback } from '../Shared/Spinner';

/**
 * GitHub-style unified diff for a raw `git diff` patch (a card's delivery, one
 * attempt of its fan-out, or a publish range). Reuses the chat DiffBlock visual
 * vocabulary (red/green line backgrounds, mono, muted meta) so a diff looks the
 * same everywhere. Files start collapsed and their bodies render only on
 * expand, so a big multi-file patch stays cheap until you open a file.
 *
 * A file is shown as what it is: a changed picture is a Before/After pair, a
 * `.md` or `.svg` can be seen rendered, a text file can be read whole. The
 * bytes come from the diff's own route at the two revisions it names
 * (`bundle.revs`), never from the disk of whoever is looking.
 *
 * With `review` the diff stops being read-only: every content line takes a
 * hook for a review note, which stays pending until the caller sends it (see
 * `reviewNotes.ts`). Notes live on the diff lines, in both the diff and the
 * "Full file" view.
 */

/** Per-file line budget when expanded — keeps a pathological file from flooding the DOM. */
const MAX_LINES_PER_FILE = 600;

// The rendered side of a `.md` is its own chunk (parse5, via rehype-raw): it is
// fetched only when someone asks for the preview, as in `FilePane`.
const MarkdownPreview = lazy(() => import('../Editor/MarkdownPreview'));

function rowClass(row: DiffRow): string {
  switch (row.kind) {
    case 'hunk': return 'bg-sky-500/10 text-sky-600 dark:text-sky-300';
    case 'add': return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'del': return 'bg-red-500/10 text-red-700 dark:text-red-300'; // allow-italian: 'del' is a patch row kind
    case 'nonewline': return 'text-app-text-muted italic';
    default: return 'text-app-text-faint dark:text-app-text-secondary';
  }
}

/** The handlers that turn review mode on; absent = a read-only diff. */
export interface DiffReview {
  notes: DiffNote[];
  onAddNote: (note: Omit<DiffNote, 'id'>) => void;
  onRemoveNote: (id: string) => void;
}

/** Sticky gutter: two numbers and the hook. It stays on the left while the line scrolls. */
const GUTTER = 'sticky shrink-0 select-none bg-app-inset px-1 text-right text-mini tabular-nums text-app-text-faint';

/**
 * Composer and pending notes live INSIDE the horizontally scrolling container,
 * hence `sticky left-0` plus an explicit width: with `w-full` they would take
 * the content's width (`min-w-max`), which on a file with long lines is a box
 * thousands of pixels wide.
 */
const OVERLAY = 'sticky left-0 w-[min(34rem,100%)] max-w-[calc(100vw-5rem)]';

function NoteComposer({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const tr = useT();
  const [text, setText] = useState('');
  return (
    <div className={`${OVERLAY} border-y border-app-border bg-app-inset p-1.5`}>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (text.trim()) onSave(text); }
        }}
        rows={2}
        placeholder={tr('diff.note.placeholder')}
        className="w-full resize-y rounded bg-white/5 px-2 py-1 font-sans text-compact text-app-text outline-none placeholder:text-app-placeholder"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={() => text.trim() && onSave(text)}
          disabled={!text.trim()}
          className="rounded bg-indigo-500/20 px-2 py-0.5 font-sans text-mini text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40"
        >
          {tr('common.add')}
        </button>
        <button onClick={onCancel} className="rounded px-2 py-0.5 font-sans text-mini text-app-text-secondary hover:text-app-text">
          {tr('common.cancel')}
        </button>
        <span className="ml-auto font-sans text-mini text-app-text-faint">{shortcut('↵')}</span>
      </div>
    </div>
  );
}

/**
 * The rows of one file's patch, with the review hooks.
 *
 * The diff and the "Full file" view both draw through here, and both carry the
 * file's own line numbers (full context is the same patch with more context
 * lines), so a note anchored on (path, line, side) sits under the same row in
 * either view. The notes are the caller's state, not this component's: switching
 * view cannot lose one.
 */
export function DiffLines({ path, body, review }: { path: string; body: string; review?: DiffReview }) {
  const tr = useT();
  const rows = useMemo(() => parseDiffRows(body), [body]);
  // The per-file cap defends the DOM, it does not judge what is worth reading:
  // while the last row only said "...N more lines", those N had no way to be seen.
  const [showAll, setShowAll] = useState(false);
  const [composingAt, setComposingAt] = useState<string | null>(null);
  const allNotes = review?.notes;
  const notesByKey = useMemo(() => {
    const m = new Map<string, DiffNote[]>();
    for (const n of allNotes ?? []) {
      if (n.path !== path) continue;
      const k = noteKey(n.path, n.line, n.side);
      const list = m.get(k);
      if (list) list.push(n); else m.set(k, [n]);
    }
    return m;
  }, [allNotes, path]);
  // Past the cap sits something the reader came for: a note (one on a row
  // not drawn is a note the human no longer finds), or, in "Full file", the
  // change itself below hundreds of rows of context. Then the file is drawn whole.
  const reachesPastCap = useMemo(() => {
    if (rows.length <= MAX_LINES_PER_FILE) return false;
    const firstChange = rows.findIndex((r) => r.kind === 'add' || r.kind === 'del'); // allow-italian: 'del' is a patch row kind
    if (firstChange >= MAX_LINES_PER_FILE) return true;
    if (notesByKey.size === 0) return false;
    for (let i = MAX_LINES_PER_FILE; i < rows.length; i++) {
      const a = anchorOf(rows[i]!);
      if (a && notesByKey.has(noteKey(path, a.line, a.side))) return true;
    }
    return false;
  }, [rows, notesByKey, path]);
  const shown = showAll || reachesPastCap ? rows : rows.slice(0, MAX_LINES_PER_FILE);
  const overflow = rows.length - shown.length;

  return (
    <>
      {shown.map((row, i) => {
        // The file headers carry no signal: the row above already names the path.
        if (row.kind === 'meta') return null;
        const anchor = anchorOf(row);
        const key = anchor ? noteKey(path, anchor.line, anchor.side) : '';
        const attached = key ? notesByKey.get(key) : undefined;
        const canComment = !!review && isCommentable(row) && !!anchor;
        return (
          <div key={i}>
            <div
              data-anchor={anchor && row.kind !== 'hunk' ? `${anchor.side}:${anchor.line}` : undefined}
              className={`group/row flex min-w-max ${rowClass(row)}`}
            >
              <span className={`${GUTTER} left-0 w-8`}>{row.oldLine ?? ''}</span>
              <span className={`${GUTTER} left-8 w-8 border-r border-app-border-subtle`}>{row.newLine ?? ''}</span>
              {review && (
                <span className="sticky left-16 z-[1] flex w-4 shrink-0 items-center justify-center bg-app-inset">
                  {canComment && (
                    <button
                      onClick={() => setComposingAt((c) => (c === key ? null : key))}
                      title={tr('diff.note.add')}
                      // The side is part of the name: a MODIFIED line shows up
                      // twice with the same number (removed from the old
                      // numbering, added in the new one), and without the
                      // suffix the two hooks are indistinguishable, for a screen
                      // reader as for a test.
                      aria-label={tr('diff.note.aria', { path, line: anchor!.line, side: anchor!.side === 'old' ? tr('diff.note.removedSide') : '' })}
                      className="flex h-3.5 w-3.5 items-center justify-center rounded text-indigo-400 opacity-0 transition-opacity hover:bg-indigo-500/20 focus:opacity-100 group-hover/row:opacity-100"
                    >
                      <MessageSquarePlus className="h-3 w-3" />
                    </button>
                  )}
                </span>
              )}
              <span className="whitespace-pre px-2">{row.raw || ' '}</span>
            </div>
            {attached?.map((n) => (
              <div key={n.id} data-testid="diff-note" className={`${OVERLAY} flex items-start gap-1.5 border-y border-indigo-500/20 bg-indigo-500/5 px-2 py-1`}>
                <span className="min-w-0 flex-1 whitespace-pre-wrap font-sans text-compact text-app-text">{n.body}</span>
                <button
                  onClick={() => review!.onRemoveNote(n.id)}
                  title="Togli la nota"
                  aria-label="Togli la nota"
                  className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded text-app-text-muted hover:bg-white/10 hover:text-app-text"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {composingAt === key && anchor && (
              <NoteComposer
                onCancel={() => setComposingAt(null)}
                onSave={(body) => {
                  review!.onAddNote({ path, line: anchor.line, side: anchor.side, code: row.raw, body });
                  setComposingAt(null);
                }}
              />
            )}
          </div>
        );
      })}
      {overflow > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-2 py-1 text-left font-sans text-mini text-indigo-300 hover:bg-indigo-500/10 hover:text-indigo-200"
        >
          {tr('diff.showAll', { total: rows.length, more: overflow })}
        </button>
      )}
    </>
  );
}

type FileView = 'diff' | 'full' | 'preview';

/** One file's patch as the per-file route answers it. */
type FilePatch = { chunk: DiffFileChunk | null; truncated: boolean };

const VIEW_LABEL: Record<FileView, string> = {
  diff: 'diff.viewDiff',
  full: 'diff.fullFile',
  preview: 'diff.preview',
};

/** "Diff | Full file | Preview" in the file's header. Opens on the diff, where the notes hang (see `FileDiff`). */
function ViewSwitch({ views, value, onChange }: { views: FileView[]; value: FileView; onChange: (v: FileView) => void }) {
  const tr = useT();
  return (
    <div role="group" className="mr-1 flex shrink-0 items-center gap-0.5 rounded bg-white/5 p-0.5">
      {views.map((v) => (
        <button
          key={v}
          type="button"
          data-testid={`diff-view-${v}`}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded px-1.5 py-0.5 text-mini ${value === v ? 'bg-indigo-500/20 text-indigo-200' : 'text-app-text-muted hover:text-app-text'}`}
        >
          {tr(VIEW_LABEL[v])}
        </button>
      ))}
    </div>
  );
}

/**
 * One side of a picture: its label, its size in pixels once it has loaded, and
 * "preview unavailable" in its place when it does not load, never an empty box.
 * Mounted with `key={sideKey(side)}`, so a re-read bundle that names new
 * revisions, or another content of a `worktree` file, starts from a fresh load.
 */
function ImageSide({ label, testId, side, source, onStale }: {
  label: string;
  testId: string;
  side: PreviewSide;
  source: DiffPanelSource;
  onStale: () => void;
}) {
  const tr = useT();
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const onError = useCallback(() => {
    setFailed(true);
    // An <img> never sees the status: ask once, and a moved-on bundle is re-read.
    void reportStaleBlob(source, side, onStale);
  }, [source, side, onStale]);
  return (
    <figure className="min-w-0 space-y-1">
      <figcaption className="flex items-baseline gap-1.5 text-mini text-app-text-muted">
        <span className="font-medium text-app-text-secondary">{label}</span>
        {size && <span className="tabular-nums">{size.w} × {size.h} px</span>}
      </figcaption>
      {failed ? (
        <div data-testid="diff-image-unavailable" className="flex items-center gap-1.5 rounded border border-dashed border-app-border px-2 py-3 text-mini text-app-text-muted">
          <ImageOff aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {tr('diff.previewUnavailable')}
        </div>
      ) : (
        <img
          data-testid={testId}
          src={diffBlobUrl(source, side.path, side.rev, side.version)}
          alt={side.path}
          loading="lazy"
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={onError}
          className="max-h-80 max-w-full rounded border border-app-border-subtle bg-white/5"
        />
      )}
    </figure>
  );
}

const sideKey = (side: PreviewSide) => `${side.rev}:${side.path}:${side.version ?? ''}`;

/** A changed picture: Before and After side by side, stacked when the panel is narrow. */
function ImagePair({ before, after, source, onStale }: {
  before: PreviewSide | null;
  after: PreviewSide | null;
  source: DiffPanelSource;
  onStale: () => void;
}) {
  const tr = useT();
  return (
    <div data-testid="diff-image-pair" className="@container p-2 font-sans">
      <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
        {before && (
          <ImageSide key={sideKey(before)} label={tr('diff.before')} testId="diff-image-before" side={before} source={source} onStale={onStale} />
        )}
        {after && (
          <ImageSide key={sideKey(after)} label={tr('diff.after')} testId="diff-image-after" side={after} source={source} onStale={onStale} />
        )}
      </div>
    </div>
  );
}

/**
 * A `.md` rendered at a revision, its relative pictures read at the SAME
 * revision through the byte route: the disk holds the main checkout's copy,
 * which for a delivery not yet landed is the wrong one.
 *
 * It is a file someone else wrote and nobody has reviewed yet, so it is
 * rendered `untrusted`: nothing in it runs, and no link of it leaves the app.
 */
function MarkdownAtRevision({ path, rev, version, source, onStale }: {
  path: string;
  rev: string;
  /**
   * This file's block in the bundle. Under `worktree` the revision keeps its
   * name while the agent keeps writing: a re-read bundle with another block is
   * another text, read again as "Full file" is. The text on screen stays until
   * the new one arrives.
   */
  version: string | undefined;
  source: DiffPanelSource;
  onStale: () => void;
}) {
  const tr = useT();
  const [state, setState] = useState<{ text: string } | 'loading' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    // A 409 re-reads the bundle (`onStale`), and this side is remounted at the new revision.
    fetchDiffText(source, { path, rev }, onStale)
      .then((t) => { if (alive) setState(t === null ? 'error' : { text: t }); })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [source, path, rev, version, onStale]);
  const resolveImage = useCallback((src: string) => {
    const target = resolveMarkdownImagePath(path, src);
    return target ? diffBlobUrl(source, target, rev) : null;
  }, [source, path, rev]);
  if (state === 'loading') return <SpinnerFallback fill />;
  if (state === 'error') {
    return <div className="px-2 py-1 font-sans text-mini text-app-text-muted">{tr('diff.previewUnavailable')}</div>;
  }
  return (
    <div data-testid="diff-markdown-preview" className="font-sans">
      <Suspense fallback={<SpinnerFallback fill />}>
        <MarkdownPreview content={state.text} baseDir="" resolveImage={resolveImage} untrusted />
      </Suspense>
    </div>
  );
}

const FileDiff = memo(function FileDiff({ path, chunk: bundled, stat, partial, defaultOpen, focused, review, source, revs, onStale }: {
  path: string;
  /** Absent = this file's patch did not arrive (payload cut). */
  chunk?: DiffFileChunk;
  stat?: DiffFileStat;
  partial?: boolean;
  defaultOpen: boolean;
  /** The file the panel was opened on: expanded and scrolled into view. */
  focused?: boolean;
  review?: DiffReview;
  source: DiffPanelSource;
  /** The two revisions the bundle compares; `null` = no byte can be asked for. */
  revs: DiffRevs | null;
  onStale: () => void;
}) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  // The same row the chat strip, the card chip and the project panel draw:
  // one letter, one palette, one place where the path is cut. A file that
  // arrived only in the patch has no status to read, and `modified` is what a
  // hunk without a name-status letter is.
  const row = useMemo(
    () => (stat ? rowFromDiffStat(stat) : { path, status: 'modified' as const }),
    [stat, path],
  );
  // Every per-file read of a renamed file names its old path too (`gitDiffFilePatch`).
  const origPath = row.origPath;
  // The patch fetched on demand, for a file left past the bundle's cap.
  const [lazyPatch, setLazyPatch] = useState<FilePatch | 'loading' | 'error' | null>(null);
  const lazyChunk = lazyPatch && typeof lazyPatch === 'object' ? lazyPatch.chunk ?? undefined : undefined;
  const chunk = bundled ?? lazyChunk;
  const load = useCallback(() => {
    setLazyPatch('loading');
    boardApi.diffFile(source, path, { origPath })
      .then((r) => setLazyPatch({ chunk: chunkFromFilePatch(path, r.patch), truncated: r.truncated }))
      .catch(() => setLazyPatch('error'));
  }, [source, path, origPath]);
  const binary = !!row.binary;
  const kind = useMemo(() => previewTypeOf(path)?.kind ?? null, [path]);
  // This file's block in the bundle: on a live worktree it is what says the
  // agent rewrote the file, for the pictures as for "Full file".
  const bundledBody = bundled?.body;
  const sides = useMemo(() => (revs && kind === 'image' ? previewSides(row, revs, bundledBody) : null), [revs, kind, row, bundledBody]);
  const rendered = useMemo(
    () => (revs && (kind === 'svg' || kind === 'markdown') ? renderedSide(row, revs, bundledBody) : null),
    [revs, kind, row, bundledBody],
  );
  const views: FileView[] = sides || binary ? [] : rendered ? ['diff', 'full', 'preview'] : ['diff', 'full'];
  const noteCount = useMemo(() => (review?.notes ?? []).filter((n) => n.path === path).length, [review?.notes, path]);
  // The diff is where the notes hang, so a file opens there, unless one of its
  // notes has no row in it: written in "Full file" on a line outside the
  // changed blocks, it would leave a reopened panel showing the badge and no
  // note. Then the file opens whole. A view picked by hand wins, as `userOpen` does.
  const noteOffDiff = useMemo(
    () => noteCount > 0 && hasNoteWithoutRow(review?.notes ?? [], path, bundledBody),
    [noteCount, review?.notes, path, bundledBody],
  );
  const [userView, setUserView] = useState<FileView | null>(null);
  const view: FileView = userView ?? (noteOffDiff && views.includes('full') ? 'full' : 'diff');
  // The whole file as context, read while "Full file" is shown. It belongs to
  // the bundle it was read under: when a re-read names other revisions, or
  // this file's hunks changed (the agent keeps writing on a live worktree), it
  // is read again, or the diff would move on while the full view stayed behind.
  // Until the new one arrives the previous one stays on screen, as the bundle
  // does in `TaskChangesSection`.
  const [full, setFull] = useState<{ base?: string; head?: string | null; body?: string; patch: FilePatch | 'error' } | null>(null);
  const revBase = revs?.base;
  const revHead = revs?.head;
  const fullCurrent = full && full.base === revBase && full.head === revHead && full.body === bundledBody ? full.patch : null;
  const pickView = useCallback((v: FileView) => {
    setUserView(v);
    // A failed read is retried by choosing the view again.
    if (v === 'full' && fullCurrent === 'error') setFull(null);
  }, [fullCurrent]);
  const fullShown = fullCurrent ?? (full && full.patch !== 'error' ? full.patch : null);

  // Opened by default when it holds notes (a note in a closed file is a note
  // the human no longer finds), but an explicit choice always wins over the
  // default, even when the notes arrive later (a draft from the server).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (defaultOpen || !!focused || noteCount > 0);
  // Read only while someone looks at it: a closed file left on "Full file" is not re-read on every bundle.
  useEffect(() => {
    if (!open || view !== 'full' || fullCurrent !== null) return;
    let alive = true;
    const under = { base: revBase, head: revHead, body: bundledBody };
    boardApi.diffFile(source, path, { full: true, origPath })
      .then((r) => { if (alive) setFull({ ...under, patch: { chunk: chunkFromFilePatch(path, r.patch), truncated: r.truncated } }); })
      .catch(() => { if (alive) setFull({ ...under, patch: 'error' }); });
    return () => { alive = false; };
  }, [open, view, fullCurrent, revBase, revHead, bundledBody, source, path, origPath]);
  // Opened from a row of the card chip: the file is scrolled into view, not
  // just expanded, or in a 70-file diff it stays below the fold.
  useEffect(() => {
    if (focused) rootRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focused]);
  // And when that file is one of those past the cap, its patch is fetched
  // right away: the click on the row already was the request. A picture needs
  // no patch, its pair reads the bytes.
  useEffect(() => {
    if (!focused || bundled || sides) return;
    let alive = true;
    boardApi.diffFile(source, path, { origPath })
      .then((r) => { if (alive) setLazyPatch({ chunk: chunkFromFilePatch(path, r.patch), truncated: r.truncated }); })
      .catch(() => { if (alive) setLazyPatch('error'); });
    return () => { alive = false; };
  }, [focused, bundled, sides, source, path, origPath]);

  const note = (text: string) => <div className="px-2 py-1 font-sans text-mini text-app-text-muted">{text}</div>;
  const cut = <div className="px-2 py-0.5 font-sans text-mini text-amber-400/80">{tr('diff.cutHere')}</div>;

  let body: ReactNode;
  if (sides) {
    body = <ImagePair before={sides.before} after={sides.after} source={source} onStale={onStale} />;
  } else if (view === 'preview' && rendered) {
    body = kind === 'svg' ? (
      <div className="p-2 font-sans">
        <ImageSide
          key={sideKey(rendered)}
          label={tr(row.status === 'deleted' ? 'diff.before' : 'diff.after')}
          testId="diff-svg-preview"
          side={rendered}
          source={source}
          onStale={onStale}
        />
      </div>
    ) : (
      <MarkdownAtRevision key={`${rendered.rev}:${rendered.path}`} path={rendered.path} rev={rendered.rev} version={bundledBody} source={source} onStale={onStale} />
    );
  } else if (view === 'full') {
    body = fullShown === null ? note(tr('diff.loadingFile'))
      : fullShown === 'error' ? note(tr('diff.loadFileFailed'))
      : fullShown.chunk ? <><DiffLines path={path} body={fullShown.chunk.body} review={review} />{fullShown.truncated && cut}</>
      : note(tr('diff.noChanges'));
  } else if (!chunk) {
    body = lazyPatch && typeof lazyPatch === 'object' ? note(tr('diff.noChanges')) : (
      // Git answered nothing yet: the notice says what is missing AND how to
      // get it, the file asked for by name on the same range.
      <div className="px-2 py-1 font-sans text-mini text-app-text-muted">
        {tr('diff.patchMissing')}
        <button
          type="button"
          data-testid="diff-load-file"
          onClick={load}
          disabled={lazyPatch === 'loading'}
          className="ml-1.5 rounded px-1.5 py-0.5 text-indigo-300 hover:bg-indigo-500/10 hover:text-indigo-200 disabled:opacity-50"
        >
          {lazyPatch === 'loading' ? tr('diff.loadingFile') : lazyPatch === 'error' ? tr('diff.loadFileFailed') : tr('diff.loadFile')}
        </button>
      </div>
    );
  } else if (binary) {
    body = <div className="px-2 py-1 text-app-text-muted">{tr('diff.binary')}</div>;
  } else {
    body = (
      <>
        <DiffLines path={path} body={chunk.body} review={review} />
        {(partial || (lazyPatch && typeof lazyPatch === 'object' && lazyPatch.truncated)) && cut}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="diff-file"
      data-path={path}
      data-focused={focused ? '1' : undefined}
      className={`overflow-hidden rounded-md border ${focused ? 'border-indigo-400/60' : 'border-app-border'}`}
    >
      <div className="flex items-center bg-elevated">
        <button
          onClick={() => setUserOpen(!open)}
          title={row.origPath ? `${row.origPath} -> ${path}` : path}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-mini hover:bg-app-hover"
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />}
          <FileCode className="h-3 w-3 shrink-0 text-app-text-muted" />
          <ChangedFileEntry
            row={row}
            trailing={noteCount > 0 ? (
              <span className="shrink-0 rounded bg-indigo-500/20 px-1 text-mini text-indigo-300" title={tr('diff.pendingNotes', { n: String(noteCount) })}>
                {noteCount}
              </span>
            ) : undefined}
          />
        </button>
        {open && views.length > 1 && <ViewSwitch views={views} value={view} onChange={pickView} />}
      </div>
      {open && <div className="overflow-x-auto font-mono text-compact leading-[1.55]">{body}</div>}
    </div>
  );
});

export function UnifiedDiff({ bundle, defaultOpenFirst = false, review, focusPath, source, onStale }: {
  bundle: DiffBundle;
  /** Expand the first file automatically (handy when there's just one). */
  defaultOpenFirst?: boolean;
  /** Present = a diff that can be commented line by line. */
  review?: DiffReview;
  /** The file to expand and scroll to (opened from a row of the card chip). */
  focusPath?: string | null;
  /** Where the diff is read: a card, one attempt of its fan-out, or a publish. Every file is read from ITS range. */
  source: DiffPanelSource;
  /** A byte read found the bundle's revisions gone (`409`): the owner re-reads the bundle. */
  onStale?: () => void;
}) {
  const tr = useT();
  const files = useMemo(() => buildFileRows(bundle), [bundle]);
  const missing = files.filter((f) => !f.chunk).length;
  // Held by value: a mount point that writes `source` inline must not re-fetch
  // every open file (and break every row's memo) on each of its renders.
  const projectId = source.projectId;
  const taskId = source.kind === 'task' ? source.taskId : null;
  const attemptId = source.kind === 'task' ? source.attemptId : undefined;
  const stableSource = useMemo<DiffPanelSource>(
    () => (taskId !== null ? { kind: 'task', projectId, taskId, attemptId } : { kind: 'publish', projectId }),
    [projectId, taskId, attemptId],
  );
  // Same for the callback: read from a ref, so its identity is not a dependency.
  const staleRef = useRef(onStale);
  useEffect(() => { staleRef.current = onStale; }, [onStale]);
  const reportStale = useCallback(() => staleRef.current?.(), []);
  const revs = bundle.revs ?? null;

  if (files.length === 0) {
    return <div className="px-1 py-1 text-mini text-app-text-muted">{tr('diff.noChanges')}</div>;
  }

  return (
    <div className="space-y-1">
      {files.map((f, i) => (
        <FileDiff
          key={f.path + i}
          path={f.path}
          chunk={f.chunk}
          stat={f.stat}
          partial={f.partial}
          defaultOpen={defaultOpenFirst && files.length === 1}
          focused={!!focusPath && f.path === focusPath}
          review={review}
          source={stableSource}
          revs={revs}
          onStale={reportStale}
        />
      ))}
      {bundle.truncated && (
        <div className="px-1 py-0.5 text-mini text-amber-400/80">
          {/* The way to the rest is on each file, not in another app: the note
              says so instead of sending you away. */}
          {tr('diff.truncated.loadable', { rest: missing > 0 ? tr('diff.truncated.countOnly', { n: missing }) : '' })}
        </div>
      )}
    </div>
  );
}
