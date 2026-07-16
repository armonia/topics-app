import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode } from 'lucide-react';
import type { DiffBundle, DiffFileStat } from '../../lib/board';

/**
 * GitHub-style unified diff for a raw `git diff` patch (publish range or a task's
 * worktree). Reuses the chat DiffBlock visual vocabulary (red/green line
 * backgrounds, mono, muted meta) so a diff looks the same everywhere. Files start
 * collapsed and their hunks render only on expand, so a big multi-file patch stays
 * cheap until you open a file.
 */

interface FileChunk {
  /** b/ path from the `diff --git` header. */
  path: string;
  body: string;
}

/** Split one patch into per-file chunks keyed by the destination path. */
function splitPatch(patch: string): FileChunk[] {
  if (!patch.trim()) return [];
  const out: FileChunk[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      if (cur) out.push({ path: cur.path, body: cur.lines.join('\n') });
      cur = { path: m[2], lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) out.push({ path: cur.path, body: cur.lines.join('\n') });
  return out;
}

/** Per-file line budget when expanded — keeps a pathological file from flooding the DOM. */
const MAX_LINES_PER_FILE = 600;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  A: { label: 'nuovo', cls: 'bg-emerald-500/15 text-emerald-400' },
  M: { label: 'mod', cls: 'bg-sky-500/15 text-sky-400' },
  D: { label: 'del', cls: 'bg-red-500/15 text-red-400' },
  R: { label: 'rinom', cls: 'bg-violet-500/15 text-violet-400' },
  C: { label: 'copia', cls: 'bg-violet-500/15 text-violet-400' },
};

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'bg-sky-500/10 text-sky-600 dark:text-sky-300';
  // File-meta lines (headers) carry no diff signal — hide them, the file card already names the path.
  if (/^(\+\+\+|---|diff --git|index |new file|deleted file|old mode|new mode|rename |similarity |copy )/.test(line))
    return 'hidden';
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-700 dark:text-red-300';
  if (line.startsWith('\\')) return 'text-neutral-500 italic'; // "\ No newline at end of file"
  return 'text-neutral-600 dark:text-neutral-400';
}

const FileDiff = memo(function FileDiff({ chunk, stat, defaultOpen }: {
  chunk: FileChunk;
  stat?: DiffFileStat;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = useMemo(() => chunk.body.split('\n'), [chunk.body]);
  const shown = open ? lines.slice(0, MAX_LINES_PER_FILE) : [];
  const overflow = lines.length - shown.length;
  const st = stat ? STATUS_META[stat.status] : undefined;
  const binary = stat && (stat.additions < 0 || stat.deletions < 0);

  return (
    <div className="overflow-hidden rounded-md border border-white/10">
      <button
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center gap-1.5 bg-neutral-800/60 px-2 py-1 text-left hover:bg-neutral-800"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />}
        <FileCode className="h-3 w-3 shrink-0 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200" title={chunk.path}>{chunk.path}</span>
        {st && <span className={`shrink-0 rounded px-1 text-[9px] uppercase ${st.cls}`}>{st.label}</span>}
        {stat && !binary && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <span className="text-emerald-400">+{stat.additions}</span> <span className="text-red-400">-{stat.deletions}</span>
          </span>
        )}
        {binary && <span className="shrink-0 text-[10px] text-neutral-500">binario</span>}
      </button>
      {open && (
        <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
          {binary ? (
            <div className="px-2 py-1 text-neutral-500">File binario — nessun diff testuale.</div>
          ) : shown.map((line, i) => {
            const cls = lineClass(line);
            if (cls === 'hidden') return null;
            return <div key={i} className={`whitespace-pre px-2 ${cls}`}>{line || ' '}</div>;
          })}
          {overflow > 0 && <div className="px-2 py-0.5 text-[10px] text-neutral-600">…altre {overflow} righe</div>}
        </div>
      )}
    </div>
  );
});

export function UnifiedDiff({ bundle, defaultOpenFirst = false }: {
  bundle: DiffBundle;
  /** Expand the first file automatically (handy when there's just one). */
  defaultOpenFirst?: boolean;
}) {
  const files = useMemo(() => splitPatch(bundle.patch), [bundle.patch]);
  const statByPath = useMemo(() => {
    const m = new Map<string, DiffFileStat>();
    for (const s of bundle.stat) m.set(s.path, s);
    return m;
  }, [bundle.stat]);

  if (!bundle.patch.trim()) {
    return <div className="px-1 py-1 text-[11px] text-neutral-500">Nessuna modifica.</div>;
  }

  return (
    <div className="space-y-1">
      {files.map((f, i) => (
        <FileDiff key={f.path + i} chunk={f} stat={statByPath.get(f.path)} defaultOpen={defaultOpenFirst && files.length === 1} />
      ))}
      {bundle.truncated && (
        <div className="px-1 py-0.5 text-[10px] text-amber-400/80">Diff troncato (molto grande) — apri il progetto per vederlo intero.</div>
      )}
    </div>
  );
}
