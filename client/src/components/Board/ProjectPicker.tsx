import { useState, useMemo } from 'react';
import { Check, Loader2, Plus, Sparkles } from 'lucide-react';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import type { BoardProjectRef } from '../../lib/board';

/**
 * Menu content shared by every "pick a project" surface (the composer's
 * project chip, the task-detail "Sposta su…" chip): a search box that filters
 * by name (case-insensitive) and, when the typed text matches no project
 * exactly, a "Crea '<text>'…" row that scaffolds it on the spot. Replaces the
 * old two-step "Nuovo progetto…" + separate input flow — search box IS the
 * create box now.
 */
export function ProjectPickerBody({ projects, selectedId, isDisabled, onPick, onCreate, busy, listLabel, headerNote, onPickAuto, autoSelected }: {
  projects: BoardProjectRef[] | null;
  selectedId?: string | null;
  isDisabled?: (p: BoardProjectRef) => boolean;
  onPick: (p: BoardProjectRef) => void;
  onCreate: (name: string) => void;
  busy: boolean;
  listLabel: string;
  headerNote?: React.ReactNode;
  /** Offer "Automatico": the server resolves the board from the task text;
   *  unresolved/ambiguous = the task stays project-less (human assigns). */
  onPickAuto?: () => void;
  autoSelected?: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!projects) return [];
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);
  const exactMatch = useMemo(
    () => (projects ?? []).some((p) => p.name.toLowerCase() === query.trim().toLowerCase()),
    [projects, query],
  );
  const showCreate = query.trim().length > 0 && !exactMatch;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || busy) return;
    e.preventDefault();
    const only = filtered.length === 1 ? filtered[0] : null;
    if (only && !isDisabled?.(only)) onPick(only);
    else if (filtered.length === 0 && query.trim()) onCreate(query.trim());
  };

  return (
    <>
      <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{listLabel}</p>
      {headerNote}
      <div className="px-2.5 pb-1.5">
        <input
          autoFocus value={query} disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Cerca o crea…"
          className="w-full rounded bg-white/5 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
        />
      </div>
      <div className="max-h-60 overflow-y-auto">
        {onPickAuto && !query.trim() && (
          <button
            role="option" aria-selected={!!autoSelected} disabled={busy}
            onClick={onPickAuto}
            title="Il progetto lo capisce il sistema dal testo del task (nome di progetto citato); se non è chiaro va nel progetto 'generale'"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/10 disabled:opacity-40"
          >
            <Sparkles className="h-3 w-3 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">Automatico</span>
            {autoSelected && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        )}
        {projects === null ? (
          <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-neutral-500" /></div>
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-neutral-500">{query.trim() ? 'Nessun progetto corrisponde.' : 'Nessun progetto trovato.'}</p>
        ) : filtered.map((p) => {
          const disabled = (isDisabled?.(p) ?? false) || busy;
          return (
            <button
              key={p.projectId} role="option" aria-selected={p.projectId === selectedId}
              disabled={disabled}
              onClick={() => onPick(p)}
              title={p.path}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            >
              <ProjectFavicon path={p.path} size={13} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.projectId === selectedId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          );
        })}
      </div>
      {showCreate && (
        <>
          <div className="my-1 border-t border-white/10" />
          <button
            role="option" aria-selected={false} disabled={busy}
            onClick={() => onCreate(query.trim())}
            title={`Crea il progetto "${query.trim()}" nel workspace`}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
          >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Crea &quot;{query.trim()}&quot;…</button>
        </>
      )}
    </>
  );
}
