import { useState, useMemo, useRef } from 'react';
import { useT } from '@/hooks/useT';
import { Check, Loader2, Plus, Sparkles } from 'lucide-react';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { ProjectTaskCounts } from './atoms';
import type { BoardProjectRef } from '../../lib/board';
import type { ProjectCounts } from '../../lib/projectTaskCounts';
import { POPOVER_DIVIDER, POPOVER_ITEM } from '@/lib/popoverStyles';

/**
 * Menu content shared by OGNI superficie «scegli un progetto»: il chip del
 * composer del task, il «Sposta su…» del drawer di dettaglio, e il filtro
 * «Progetto» della kanban. Una casella di ricerca che filtra per nome
 * (case-insensitive) e che È ANCHE la casella di creazione: il nome digitato,
 * se non esiste, scaffolda il progetto sul posto.
 *
 * In fondo, sempre visibile quando la superficie sa creare, UNA riga per il
 * progetto nuovo: «Nuovo progetto…» a vuoto (porta il cursore nella casella),
 * «Crea "x"… in <cartella>» appena digiti un nome. Era invisibile finché non
 * indovinavi il gesto di scrivere un nome — cioè, per chi guardava il menu,
 * non esisteva. UNA, non due: «nuovo» e «apri/crea» sono la stessa cosa detta
 * in due modi, e due voci indistinguibili sono una promessa che il prodotto
 * non mantiene (è la stessa regola del menu «+», addMenuItems.tsx).
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
  listLabel, headerNote, onPickAuto, autoSelected, counts, emptyLabel, newProjectDir,
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
  /** Quanti task ha ogni progetto, per stato: mostrati in coda alla riga con i
   *  glifi della kanban (vedi `ProjectTaskCounts`). Assente = nessun conteggio,
   *  che è il caso delle superfici dove si SCEGLIE un progetto (comporre un
   *  task, spostarlo): lì il carico di lavoro altrui non c'entra niente. */
  counts?: Record<string, ProjectCounts>;
  /** Testo quando la lista è vuota e non si sta cercando. */
  emptyLabel?: string;
  /** La cartella in cui nascerà un progetto creato per nome, mostrata sulla
   *  riga: è dedotta dal server, e va detta prima di creare. */
  newProjectDir?: string | null;
}) {
  const tr = useT();
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
  const typed = query.trim();
  const isSelected = (p: BoardProjectRef) => (multi ? selectedIds!.includes(p.projectId) : p.projectId === selectedId);
  // La riga «nuovo progetto» c'è SEMPRE (quando la superficie sa creare), non
  // solo dopo aver digitato un nome che non esiste: prima era invisibile finché
  // non indovinavi il gesto, cioè per l'utente non esisteva. A vuoto invita a
  // scrivere il nome (la casella di ricerca È la casella di creazione); con un
  // nome digitato È il bottone che crea; se quel nome esiste già resta lì,
  // spenta e con la sua ragione, invece di sparire sotto il cursore.
  const searchRef = useRef<HTMLInputElement>(null);
  const createState: 'prompt' | 'ready' | 'exists' = !typed ? 'prompt' : exactMatch ? 'exists' : 'ready';
  const runCreate = () => {
    if (!onCreate || busy) return;
    if (createState === 'ready') onCreate(typed);
    else if (createState === 'prompt') searchRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || busy) return;
    e.preventDefault();
    const only = filtered.length === 1 ? filtered[0] : null;
    if (only && !isDisabled?.(only)) onPick(only);
    else if (filtered.length === 0 && typed && onCreate) onCreate(typed);
  };

  return (
    <>
      <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{listLabel}</p>
      {headerNote}
      <div className="px-2.5 pb-1.5">
        <input
          ref={searchRef}
          autoFocus value={query} disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={onCreate ? tr('picker.searchOrCreate') : tr('picker.search')}
          aria-label={onCreate ? tr('picker.searchOrCreate.aria') : tr('picker.search.aria')}
          className="w-full rounded bg-black/5 px-2 py-1 text-xs text-app-text outline-none placeholder:text-app-placeholder dark:bg-white/5"
        />
      </div>
      <div className="max-h-60 overflow-y-auto">
        {onPickAuto && !query.trim() && (
          <button
            role="option" aria-selected={!!autoSelected} disabled={busy}
            onClick={onPickAuto}
            title={tr('picker.auto.hint')}
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
              {counts?.[p.projectId] && <ProjectTaskCounts counts={counts[p.projectId]!} />}
              {isSelected(p) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          );
        })}
      </div>
      {onCreate && (
        <>
          <div className={POPOVER_DIVIDER} />
          <button
            role="option" aria-selected={false} disabled={busy || createState === 'exists'}
            onClick={runCreate}
            data-testid="project-picker-create"
            title={createState === 'exists'
              ? tr('picker.exists', { name: typed })
              : createState === 'ready'
                ? tr('picker.create', { name: typed, where: newProjectDir ? tr('picker.create.in', { dir: newProjectDir }) : '' })
                : tr('picker.typeName', { where: newProjectDir ? tr('picker.typeName.in', { dir: newProjectDir }) : '' })}
            className={`${POPOVER_ITEM} disabled:opacity-40`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Plus className="h-3.5 w-3.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">
              {createState === 'ready' ? <>Crea &quot;{typed}&quot;…</> : 'Nuovo progetto…'}
            </span>
            {/* DOVE nascerà: la cartella è dedotta dal server, e una deduzione
                che crea cartelle sul disco si dichiara PRIMA, non si scopre dopo. */}
            {newProjectDir && (
              <span className="shrink-0 text-[10px] text-app-text-muted">in {newProjectDir.split('/').pop()}</span>
            )}
          </button>
        </>
      )}
    </>
  );
}
