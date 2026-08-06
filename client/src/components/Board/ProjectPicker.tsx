import { useState, useMemo } from 'react';
import { Check, Loader2, Plus, Sparkles } from 'lucide-react';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import type { BoardProjectRef } from '../../lib/board';
import { POPOVER_DIVIDER, POPOVER_ITEM } from '@/lib/popoverStyles';

/**
 * Menu content shared by OGNI superficie «scegli un progetto»: il chip del
 * composer del task, il «Sposta su…» del drawer di dettaglio, e il filtro
 * «Progetto» della kanban. Una casella di ricerca che filtra per nome
 * (case-insensitive) e, quando il testo digitato non corrisponde esattamente a
 * nessun progetto, una riga «Crea '<testo>'…» che lo scaffolda sul posto —
 * sostituisce il vecchio flusso in due passi «Nuovo progetto…» + input a
 * parte: la casella di ricerca È la casella di creazione.
 *
 * Due modalità di selezione, stesso corpo:
 *   - SINGOLA (`selectedId`) — scegliere il progetto di un task;
 *   - MULTIPLA (`selectedIds`) — filtrare la board per più progetti. Il menu
 *     NON si chiude a ogni scelta: sta al chiamante decidere (un filtro si
 *     costruisce a più clic).
 * `onCreate` è opzionale: da un FILTRO non si crea un progetto — filtrare per
 * qualcosa che non esiste ancora non ha senso, e la riga «Crea…» sparisce.
 */
export function ProjectPickerBody({
  projects, selectedId, selectedIds, isDisabled, onPick, onCreate, busy,
  listLabel, headerNote, onPickAuto, autoSelected, counts, emptyLabel,
}: {
  projects: BoardProjectRef[] | null;
  /** Selezione singola: l'id scelto. Ignorato se `selectedIds` è presente. */
  selectedId?: string | null;
  /** Selezione multipla (filtri): gli id attivi. Attiva la modalità multipla. */
  selectedIds?: readonly string[];
  isDisabled?: (p: BoardProjectRef) => boolean;
  onPick: (p: BoardProjectRef) => void;
  /** Assente = niente riga «Crea…» (superfici di sola lettura, es. i filtri). */
  onCreate?: (name: string) => void;
  busy: boolean;
  listLabel: string;
  headerNote?: React.ReactNode;
  /** Offer "Automatico": the server resolves the board from the task text;
   *  unresolved/ambiguous = the task stays project-less (human assigns). */
  onPickAuto?: () => void;
  autoSelected?: boolean;
  /** Conteggio per progetto mostrato in coda alla riga (quanti task ha). */
  counts?: Record<string, number>;
  /** Testo quando la lista è vuota e non si sta cercando. */
  emptyLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const multi = selectedIds !== undefined;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!projects) return [];
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);
  const exactMatch = useMemo(
    () => (projects ?? []).some((p) => p.name.toLowerCase() === query.trim().toLowerCase()),
    [projects, query],
  );
  const showCreate = !!onCreate && query.trim().length > 0 && !exactMatch;
  const isSelected = (p: BoardProjectRef) => (multi ? selectedIds!.includes(p.projectId) : p.projectId === selectedId);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || busy) return;
    e.preventDefault();
    const only = filtered.length === 1 ? filtered[0] : null;
    if (only && !isDisabled?.(only)) onPick(only);
    else if (filtered.length === 0 && query.trim() && onCreate) onCreate(query.trim());
  };

  return (
    <>
      <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{listLabel}</p>
      {headerNote}
      <div className="px-2.5 pb-1.5">
        <input
          autoFocus value={query} disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={onCreate ? 'Cerca o crea…' : 'Cerca…'}
          aria-label={onCreate ? 'Cerca o crea un progetto' : 'Cerca un progetto'}
          className="w-full rounded bg-black/5 px-2 py-1 text-xs text-app-text outline-none placeholder:text-app-placeholder dark:bg-white/5"
        />
      </div>
      <div className="max-h-60 overflow-y-auto">
        {onPickAuto && !query.trim() && (
          <button
            role="option" aria-selected={!!autoSelected} disabled={busy}
            onClick={onPickAuto}
            title="Il progetto lo capisce il sistema dal testo del task (nome di progetto citato); se non è chiaro va nel progetto 'generale'"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-app-text-heading hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10"
          >
            <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1">Automatico</span>
            {autoSelected && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
        )}
        {projects === null ? (
          <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-app-text-muted" /></div>
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-app-text-muted">{query.trim() ? 'Nessun progetto corrisponde.' : emptyLabel ?? 'Nessun progetto trovato.'}</p>
        ) : filtered.map((p) => {
          const disabled = (isDisabled?.(p) ?? false) || busy;
          return (
            <button
              key={p.projectId} role="option" aria-selected={isSelected(p)}
              disabled={disabled}
              onClick={() => onPick(p)}
              title={p.path || p.name}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
            >
              <ProjectFavicon path={p.path} size={13} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {counts?.[p.projectId] !== undefined && (
                <span className="shrink-0 tabular-nums text-[10px] text-app-text-muted">{counts[p.projectId]}</span>
              )}
              {isSelected(p) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          );
        })}
      </div>
      {showCreate && (
        <>
          <div className={POPOVER_DIVIDER} />
          <button
            role="option" aria-selected={false} disabled={busy}
            onClick={() => onCreate!(query.trim())}
            title={`Crea il progetto "${query.trim()}" nel workspace`}
            className={`${POPOVER_ITEM} disabled:opacity-40`}
          >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Crea &quot;{query.trim()}&quot;…</button>
        </>
      )}
    </>
  );
}
