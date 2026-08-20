import { memo, useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ChevronDown, ChevronRight, FileCode, MessageSquarePlus, Trash2 } from 'lucide-react';
import type { DiffBundle, DiffFileStat } from '../../lib/board';
import { parseDiffRows, isCommentable, anchorOf, noteKey, type DiffRow, type DiffNote } from './reviewNotes';
import { buildFileRows, type DiffFileChunk } from './diffFileRows';

/**
 * GitHub-style unified diff for a raw `git diff` patch (publish range or a task's
 * worktree). Reuses the chat DiffBlock visual vocabulary (red/green line
 * backgrounds, mono, muted meta) so a diff looks the same everywhere. Files start
 * collapsed and their hunks render only on expand, so a big multi-file patch stays
 * cheap until you open a file.
 *
 * Con `onAddNote` il diff smette di essere di sola lettura: ogni riga di
 * contenuto prende un aggancio per una nota di revisione, che resta in sospeso
 * finché il chiamante non la spedisce (vedi `reviewNotes.ts`).
 */

/** Per-file line budget when expanded — keeps a pathological file from flooding the DOM. */
const MAX_LINES_PER_FILE = 600;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  A: { label: 'nuovo', cls: 'bg-emerald-500/15 text-emerald-400' },
  M: { label: 'mod', cls: 'bg-sky-500/15 text-sky-400' },
  D: { label: 'del', cls: 'bg-red-500/15 text-red-400' },
  R: { label: 'rinom', cls: 'bg-violet-500/15 text-violet-400' },
  C: { label: 'copia', cls: 'bg-violet-500/15 text-violet-400' },
};

function rowClass(row: DiffRow): string {
  switch (row.kind) {
    case 'hunk': return 'bg-sky-500/10 text-sky-600 dark:text-sky-300';
    case 'add': return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'del': return 'bg-red-500/10 text-red-700 dark:text-red-300';
    case 'nonewline': return 'text-app-text-muted italic';
    default: return 'text-app-text-faint dark:text-app-text-secondary';
  }
}

/** Handlers che accendono la modalità revisione; assenti = diff di sola lettura. */
export interface DiffReview {
  notes: DiffNote[];
  onAddNote: (note: Omit<DiffNote, 'id'>) => void;
  onRemoveNote: (id: string) => void;
}

/** Gutter sticky: due numeri + l'aggancio. Resta a sinistra mentre la riga scorre. */
const GUTTER = 'sticky shrink-0 select-none bg-app-inset px-1 text-right text-[10px] tabular-nums text-app-text-faint';

/**
 * Composer/note in sospeso: vivono DENTRO il contenitore che scorre in
 * orizzontale, quindi `sticky left-0` + una larghezza esplicita — con `w-full`
 * erediterebbero la larghezza del contenuto (`min-w-max`), che su un file con
 * righe lunghe è una casella larga migliaia di pixel.
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
        className="w-full resize-y rounded bg-white/5 px-2 py-1 font-sans text-[11.5px] text-app-text outline-none placeholder:text-app-placeholder"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <button
          onClick={() => text.trim() && onSave(text)}
          disabled={!text.trim()}
          className="rounded bg-indigo-500/20 px-2 py-0.5 font-sans text-[11px] text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40"
        >
          {tr('common.add')}
        </button>
        <button onClick={onCancel} className="rounded px-2 py-0.5 font-sans text-[11px] text-app-text-secondary hover:text-app-text">
          {tr('common.cancel')}
        </button>
        <span className="ml-auto font-sans text-[10px] text-app-text-faint">⌘↵</span>
      </div>
    </div>
  );
}

const FileDiff = memo(function FileDiff({ path, chunk, stat, partial, defaultOpen, review }: {
  path: string;
  /** Assente = il patch di questo file non è arrivato (payload troncato). */
  chunk?: DiffFileChunk;
  stat?: DiffFileStat;
  partial?: boolean;
  defaultOpen: boolean;
  review?: DiffReview;
}) {
  const tr = useT();
  const allNotes = review?.notes;
  const fileNotes = useMemo(
    () => (allNotes ? allNotes.filter((n) => n.path === path) : []),
    [allNotes, path],
  );
  // Aperto d'ufficio se ci sono note qui dentro — una nota in un file chiuso è
  // una nota che l'umano non ritrova più — ma la scelta esplicita vince sempre
  // su quella d'ufficio, anche quando le note arrivano dopo (bozza dal server).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (defaultOpen || fileNotes.length > 0);
  // Il tetto per file è una difesa del DOM, non un giudizio su cosa vale la pena
  // leggere: finché la riga in fondo diceva solo «…altre N righe», quelle N
  // righe non c'era modo di vederle senza uscire dalla app.
  const [showAll, setShowAll] = useState(false);
  const [composingAt, setComposingAt] = useState<string | null>(null);
  const rows = useMemo(() => (chunk ? parseDiffRows(chunk.body) : []), [chunk]);
  const shown = open ? (showAll ? rows : rows.slice(0, MAX_LINES_PER_FILE)) : [];
  const overflow = open && !showAll ? rows.length - shown.length : 0;
  const st = stat ? STATUS_META[stat.status] : undefined;
  const binary = stat && (stat.additions < 0 || stat.deletions < 0);
  const notesByKey = useMemo(() => {
    const m = new Map<string, DiffNote[]>();
    for (const n of fileNotes) {
      const k = noteKey(n.path, n.line, n.side);
      const list = m.get(k);
      if (list) list.push(n); else m.set(k, [n]);
    }
    return m;
  }, [fileNotes]);

  return (
    <div className="overflow-hidden rounded-md border border-app-border">
      <button
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-1.5 bg-elevated px-2 py-1 text-left hover:bg-app-hover"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />}
        <FileCode className="h-3 w-3 shrink-0 text-app-text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-app-text" title={path}>{path}</span>
        {fileNotes.length > 0 && (
          <span className="shrink-0 rounded bg-indigo-500/20 px-1 text-[9px] text-indigo-300" title={`${fileNotes.length} note in sospeso`}>
            {fileNotes.length}
          </span>
        )}
        {st && <span className={`shrink-0 rounded px-1 text-[9px] uppercase ${st.cls}`}>{st.label}</span>}
        {stat && !binary && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <span className="text-emerald-400">+{stat.additions}</span> <span className="text-red-400">-{stat.deletions}</span>
          </span>
        )}
        {binary && <span className="shrink-0 text-[10px] text-app-text-muted">binario</span>}
      </button>
      {open && (
        <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
          {!chunk ? (
            <div className="px-2 py-1 font-sans text-[11px] text-app-text-muted">
              {tr('diff.patchMissing')}
            </div>
          ) : binary ? (
            <div className="px-2 py-1 text-app-text-muted">{tr('diff.binary')}</div>
          ) : shown.map((row, i) => {
            // Le intestazioni del file non portano segnale: la card nomina già il path.
            if (row.kind === 'meta') return null;
            const anchor = anchorOf(row);
            const key = anchor ? noteKey(path, anchor.line, anchor.side) : '';
            const attached = key ? notesByKey.get(key) : undefined;
            const canComment = !!review && isCommentable(row) && !!anchor;
            return (
              <div key={i}>
                <div className={`group/row flex min-w-max ${rowClass(row)}`}>
                  <span className={`${GUTTER} left-0 w-8`}>{row.oldLine ?? ''}</span>
                  <span className={`${GUTTER} left-8 w-8 border-r border-app-border-subtle`}>{row.newLine ?? ''}</span>
                  {review && (
                    <span className="sticky left-16 z-[1] flex w-4 shrink-0 items-center justify-center bg-app-inset">
                      {canComment && (
                        <button
                          onClick={() => setComposingAt((c) => (c === key ? null : key))}
                          title={tr('diff.note.add')}
                          // Il lato fa parte del nome: una riga MODIFICATA
                          // compare due volte con lo stesso numero (rimossa
                          // dalla numerazione vecchia, aggiunta da quella
                          // nuova), e senza il suffisso i due agganci sono
                          // indistinguibili — per uno screen reader come per un
                          // test.
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
                  <div key={n.id} className={`${OVERLAY} flex items-start gap-1.5 border-y border-indigo-500/20 bg-indigo-500/5 px-2 py-1`}>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap font-sans text-[11.5px] text-app-text">{n.body}</span>
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
              className="w-full px-2 py-1 text-left font-sans text-[10px] text-indigo-300 hover:bg-indigo-500/10 hover:text-indigo-200"
            >
              {tr('diff.showAll', { total: rows.length, more: overflow })}
            </button>
          )}
          {partial && (
            <div className="px-2 py-0.5 font-sans text-[10px] text-amber-400/80">
              {tr('diff.cutHere')}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export function UnifiedDiff({ bundle, defaultOpenFirst = false, review }: {
  bundle: DiffBundle;
  /** Expand the first file automatically (handy when there's just one). */
  defaultOpenFirst?: boolean;
  /** Presente = diff commentabile riga per riga. */
  review?: DiffReview;
}) {
  const tr = useT();
  const files = useMemo(() => buildFileRows(bundle), [bundle]);
  const missing = files.filter((f) => !f.chunk).length;

  if (files.length === 0) {
    return <div className="px-1 py-1 text-[11px] text-app-text-muted">{tr('diff.noChanges')}</div>;
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
          review={review}
        />
      ))}
      {bundle.truncated && (
        <div className="px-1 py-0.5 text-[10px] text-amber-400/80">
          {tr('diff.truncated', { rest: missing > 0 ? tr('diff.truncated.countOnly', { n: missing }) : '' })}
        </div>
      )}
    </div>
  );
}
