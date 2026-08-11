/**
 * KanbanBoardPane — lean, Master-free task board (human surface).
 *
 * Rebuilt after the Master/Board subsystem was removed (42e92c1d): no Crown/lead,
 * no proposal cards, no autopilot. Five columns, drag between columns to change
 * status, a detail drawer with the comment thread, and a human review gate on the
 * Review column (approve → done / reject → in_progress). Talks only to the
 * project-scoped board API (client/src/lib/board.ts).
 */
import { useT } from '../../hooks/useT';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, Loader2, Search, Settings, UploadCloud, X } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { ExternalSessionsBadge } from './ExternalSessionsBadge';
import { useExternalSessions } from '../../hooks/useExternalSessions';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { currentTaskTarget, reflectTaskOpen, reflectTaskClose, subscribePopstateTask } from '../../lib/openTaskLink';
import {
  boardApi, boardIdForPath, isProjectlessId, TASK_STATUSES, UNASSIGNED_PROJECT_ID,
  type BoardProjectRef, type BoardTask, type TaskStatus, type BoardSettings,
  type PublishProject, type DiffBundle, type DispatchCapacity, type GlobalSettings,
} from '../../lib/board';
import { groupByStatus, planDrop, type DropPlan, type OrderScope } from '../../lib/boardOrder';
import { DONE_FLASH_MS, landedInDone, statusSnapshot } from '../../lib/justDone';
import { resolveProjectRefs, useBoardProjects } from '../../lib/boardProjectsStore';
import { ProjectPickerBody } from './ProjectPicker';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { UnifiedDiff } from './UnifiedDiff';
import { useConfirm } from '../../hooks/useConfirm';
import { PRIORITY_DOT, PRIORITY_ORDER, PRIORITY_LABEL, type LiveUsage, type OpenTask } from './constants';
import { boardCollision } from './format';
import { FloatingTaskComposer } from './FloatingTaskComposer';
import { Column } from './Card';
import { TaskDetail, BoardSettingsPanel } from './TaskDetail';
import { POPOVER_ITEM } from '@/lib/popoverStyles';

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** Deep-link a task's bound agent tab into focus (wired to handleTopicClick). */
  onOpenTopic?: (topicId: string) => void;
}

/** Publish control: lists projects with unpushed commits on their current branch
 *  and pushes on demand (→ deploy CI where configured). Lives in the header so it
 *  works from the GLOBAL board too, where every project shows up together. */
function PublishControl() {
  const tr = useT();
  const [projects, setProjects] = useState<PublishProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffBundle | 'loading' | 'error'>>({});
  const confirm = useConfirm();
  const refresh = useCallback(() => {
    boardApi.publishStatus().then(setProjects).catch(() => setProjects([]));
  }, []);
  const toggleExpand = (projectId: string, isOpen: boolean) => {
    if (isOpen) { setExpanded(null); return; }
    setExpanded(projectId);
    // Lazy-load the diff once per project when it's first opened.
    if (!diffs[projectId]) {
      setDiffs((d) => ({ ...d, [projectId]: 'loading' }));
      boardApi.publishDiff(projectId)
        .then((b) => setDiffs((d) => ({ ...d, [projectId]: b })))
        .catch(() => setDiffs((d) => ({ ...d, [projectId]: 'error' })));
    }
  };
  useEffect(() => { refresh(); }, [refresh]);
  const pending = (projects ?? []).filter((p) => p.ahead > 0);
  const total = pending.reduce((n, p) => n + p.ahead, 0);
  const doPublish = async (p: PublishProject) => {
    // Show the exact commits in the confirm so a wrong-project / un-approved
    // commit is caught before the push — a push ships the WHOLE branch tip.
    const shown = p.commits.slice(0, 8);
    const more = p.commits.length > 8 ? p.commits.length - 8 : 0;
    const ok = await confirm({
      title: `Pubblicare "${p.name}"?`,
      confirmLabel: `Push ${p.ahead} commit`,
      body: (
        <div className="space-y-2">
          <p>Push di {p.ahead} commit su <span className="font-mono">origin/{p.branch}</span>. Avvia il deploy dove configurato.</p>
          <ul className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-[11px]">
            {shown.map((c) => (
              <li key={c.hash} className="truncate">• {c.subject} ({c.hash}, {c.author})</li>
            ))}
          </ul>
          {more > 0 && <p className="text-app-text-secondary">…e altri {more}</p>}
        </div>
      ),
    });
    if (!ok) return;
    setBusy(p.projectId); setMsg(null);
    try {
      const r = await boardApi.publish(p.projectId);
      setMsg(r.ok ? `${p.name}: pubblicato ✓` : `${p.name}: ${r.error ?? 'errore'}`);
      refresh();
    } catch (e) { setMsg(`${p.name}: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  return (
    <div className="relative">
      <button
        onClick={() => { setOpen((s) => !s); refresh(); }}
        title={pending.length ? `${total} commit da pubblicare` : 'Niente da pubblicare'}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${pending.length ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' : 'bg-white/10 text-app-text-secondary hover:bg-white/15'}`}
      >
        <UploadCloud className="h-3 w-3" /> Pubblica{total > 0 && <span className="ml-0.5 rounded bg-amber-500/30 px-1 tabular-nums">{total}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-96 overflow-y-auto rounded-lg border border-app-border bg-surface p-1 shadow-xl">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-app-text-muted">{tr('board.publish.toPublish')}</div>
            {pending.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-app-text-muted">{tr('board.publish.nothing')}</div>
            ) : pending.map((p) => {
              const isOpen = expanded === p.projectId;
              return (
                <div key={p.projectId} className="rounded">
                  <div className="flex items-center gap-1.5 px-1 py-1 hover:bg-white/5">
                    <button
                      onClick={() => toggleExpand(p.projectId, isOpen)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={isOpen ? 'Nascondi commit e diff' : 'Mostra commit e diff da pubblicare'}
                    >
                      {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-app-text">{p.name}<span className="ml-1 text-[11px] text-app-text-muted">{p.ahead} commit · {p.branch}</span></span>
                    </button>
                    <button disabled={busy === p.projectId} onClick={() => doPublish(p)} className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 disabled:opacity-50">{busy === p.projectId ? '…' : 'Pubblica'}</button>
                  </div>
                  {isOpen && (
                    <ul className="mb-1 ml-4 space-y-0.5 border-l border-app-border pl-2">
                      {p.commits.map((c) => (
                        <li key={c.hash} className="flex items-baseline gap-1.5 text-[11px] leading-tight">
                          <code className="shrink-0 text-app-text-muted">{c.hash}</code>
                          <span className="min-w-0 flex-1 truncate text-app-text-heading" title={c.subject}>{c.subject}</span>
                          <span className="shrink-0 text-app-text-faint">{c.author} · {c.when}</span>
                        </li>
                      ))}
                      {p.commits.length >= 50 && <li className="text-[10px] text-app-text-faint">…troncato a 50</li>}
                    </ul>
                  )}
                  {isOpen && (
                    <div className="mb-1.5 ml-4 border-l border-app-border pl-2">
                      <div className="mb-0.5 text-[9px] uppercase tracking-wide text-app-text-faint">{tr('board.publish.diffTitle')}</div>
                      {diffs[p.projectId] === 'loading' && <div className="text-[11px] text-app-text-muted">{tr('board.publish.loadingDiff')}</div>}
                      {diffs[p.projectId] === 'error' && <div className="text-[11px] text-red-400">{tr('board.publish.diffError')}</div>}
                      {diffs[p.projectId] && typeof diffs[p.projectId] === 'object' && (
                        <UnifiedDiff bundle={diffs[p.projectId] as DiffBundle} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {msg && <div className="mt-0.5 border-t border-app-border px-2 py-1.5 text-[11px] text-app-text-secondary">{msg}</div>}
          </div>
        </>
      )}
    </div>
  );
}

/** Visible overload signal in the board header. The dispatch cap is advisory
 *  when set to a fixed number (a human can knowingly run more agents than the
 *  machine recommends) — but the only place that recommendation lived was the
 *  /api/system/dispatch-capacity JSON and the settings popover. This surfaces it
 *  where the human already is: a pill that lights up when the 1-min load average
 *  approaches/exceeds the core count. It never blocks dispatch — it just makes
 *  "the box is on its knees" impossible to miss. Polls every 15s (cheap probe). */
function OverloadBadge() {
  const [cap, setCap] = useState<DispatchCapacity | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => boardApi.dispatchCapacity().then((c) => { if (alive) setCap(c); }).catch(() => { /* optional */ });
    tick();
    const id = setInterval(tick, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!cap) return null;
  // load1 vs cores is the honest live saturation signal (see dispatch-capacity.ts).
  const ratio = cap.cores > 0 ? cap.load1 / cap.cores : 0;
  if (ratio < 0.9) return null; // healthy — say nothing
  const severe = ratio >= 1.3;
  const cls = severe
    ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30'
    : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30';
  return (
    <span
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${cls}`}
      title={`Load ${cap.load1.toFixed(1)} su ${cap.cores} core — la macchina è sotto carico. Consigliati ${cap.recommended} agent in parallelo${severe ? '. Valuta se fermare qualche agente.' : '.'}`}
    >
      <AlertTriangle className="h-3 w-3" />
      {severe ? 'Carico critico' : 'Carico alto'}
      <span className="text-app-text-muted">· max {cap.recommended}</span>
    </span>
  );
}

/** Machine-wide dispatch settings, reachable from EVERY board header (incl. the
 *  general board): the global auto-dispatch switch + the auto concurrency cap
 *  that is sized from live capacity and enforced across ALL boards. Per-board
 *  overrides still live in the project board's ⚙ inline panel. */
function GlobalSettingsMenu({ onMessage }: { onMessage?: (handler: (msg: WSMessage) => void) => () => void }) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [g, setG] = useState<GlobalSettings | null>(null);
  const [cap, setCap] = useState<DispatchCapacity | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    boardApi.getGlobalSettings().then(setG).catch(() => { /* keep last */ });
    boardApi.dispatchCapacity().then(setCap).catch(() => { /* optional */ });
  };
  // Il cap globale vale per TUTTE le board, quindi cambiarlo in una finestra
  // riguarda anche le altre — ed e' per questo che il server manda
  // `board:global-cap` (`server/routes/tasks.ts`). Nessuno lo ascoltava: la
  // finestra che lo cambiava si aggiornava dalla propria risposta, le altre
  // restavano sul valore vecchio finche' non riaprivano il menu.
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      const m = msg as { type?: string; maxAgentsAuto?: boolean; maxAgents?: number };
      if (m.type !== 'board:global-cap') return;
      setG((p) => (p ? {
        ...p,
        ...(typeof m.maxAgentsAuto === 'boolean' ? { maxAgentsAuto: m.maxAgentsAuto } : {}),
        ...(typeof m.maxAgents === 'number' ? { maxAgents: m.maxAgents } : {}),
      } : p));
    });
  }, [onMessage]);

  const toggleAuto = async (v: boolean) => {
    setG((p) => (p ? { ...p, autoDispatch: v } : p));
    try { await boardApi.setGlobalDispatch(v); } catch { load(); }
  };
  const toggleCap = async (v: boolean) => {
    setBusy(true);
    setG((p) => (p ? { ...p, maxAgentsAuto: v } : p));
    try { setG(await boardApi.setGlobalCap({ auto: v })); } catch { load(); } finally { setBusy(false); }
  };
  const setManual = async (n: number) => {
    const max = Math.max(1, Math.min(20, Math.round(n)));
    setG((p) => (p ? { ...p, maxAgents: max } : p));
    try { setG(await boardApi.setGlobalCap({ max })); } catch { load(); }
  };
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        title="Impostazioni dispatch — globali (tutte le board)"
        className={`-ml-1 flex items-center bg-transparent p-0 ${open ? 'text-app-text' : 'text-app-text-muted hover:text-app-text-heading'}`}
      ><ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288} unmanagedFocus>
        <div className="space-y-2.5 px-3 py-2.5 text-xs text-app-text-heading">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.dispatch.allBoards')}</p>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.settings.autoDispatch')}</span>
            <input type="checkbox" checked={!!g?.autoDispatch} onChange={(e) => toggleAuto(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
          </label>
          <div className="space-y-1 border-t border-app-border-subtle pt-2">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>{tr('board.dispatch.parallelAuto')}</span>
              <input type="checkbox" checked={!!g?.maxAgentsAuto} disabled={busy} onChange={(e) => toggleCap(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
            </label>
            {g?.maxAgentsAuto ? (
              <p className="text-[11px] leading-snug text-app-text-muted">
                <b className="text-emerald-300">{cap ? cap.recommended : '…'}</b> agent in parallelo su tutta la macchina{cap && <span className="text-app-text-faint"> — {cap.reason}</span>}
              </p>
            ) : (
              <label className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-app-text-muted">Numero fisso{cap && <span className="text-app-text-faint"> (consigliato {cap.recommended})</span>}</span>
                <input
                  type="number" min={1} max={20} value={g?.maxAgents ?? 3}
                  onChange={(e) => setManual(Number(e.target.value))}
                  className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
                />
              </label>
            )}
            <p className="text-[10px] leading-snug text-app-text-faint">{tr('board.dispatch.oneMachine')}</p>
          </div>
        </div>
      </Menu>
    </>
  );
}

interface FilterPanelProps {
  filters: { priority: number[]; assignedTo: string[]; text: string; projectId: string[] };
  onFiltersChange: (filters: { priority: number[]; assignedTo: string[]; text: string; projectId: string[] }) => void;
  tasks: BoardTask[];
  mode: 'project' | 'all';
}

/** Row inside a filter dropdown — same markup as the composer's picker options
 *  (dot/label + emerald check when selected), so filters and the create-task
 *  input share one visual language. */
function FilterOption({ selected, onClick, dot, label, title }: {
  selected: boolean; onClick: () => void; dot?: React.ReactNode; label: string; title?: string;
}) {
  return (
    <button
      role="option" aria-selected={selected} onClick={onClick} title={title}
      className={POPOVER_ITEM}
    >
      {dot}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
    </button>
  );
}

/** Filters shown INLINE in the board header. Built from the SAME picker primitive
 *  as the task composer (`Menu` chip + dropdown), just multi-select — no separate
 *  bespoke widgets. Priority/assignee/project have no "auto" entry: filtering by
 *  "let the agent decide" makes no sense, so it's dropped. */
function InlineFilters({ filters, onFiltersChange, tasks, mode }: FilterPanelProps) {
  const tr = useT();
  const prioBtnRef = useRef<HTMLButtonElement>(null);
  const asgBtnRef = useRef<HTMLButtonElement>(null);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const [prioOpen, setPrioOpen] = useState(false);
  const [asgOpen, setAsgOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);

  const togglePriority = (p: number) => {
    const updated = filters.priority.includes(p)
      ? filters.priority.filter((x) => x !== p)
      : [...filters.priority, p].sort((a, b) => b - a);
    onFiltersChange({ ...filters, priority: updated });
  };
  const toggleAssignedTo = (a: string) => {
    const updated = filters.assignedTo.includes(a)
      ? filters.assignedTo.filter((x) => x !== a)
      : [...filters.assignedTo, a];
    onFiltersChange({ ...filters, assignedTo: updated });
  };
  const reset = () => onFiltersChange({ priority: [], assignedTo: [], text: '', projectId: [] });

  const assignees = Array.from(new Set(tasks.map((t) => t.assignedTo).filter(Boolean) as string[])).sort();

  // ── Progetto: LO STESSO selettore del composer ────────────────────────────
  // Prima questo filtro era un widget a parte che dell'indice progetti non
  // sapeva nulla: niente ricerca, niente icone, e come nome l'id della board
  // con l'hash tagliato via (`topics-app-4f2c` → «topics-app»), che assomiglia
  // al nome vero ma non lo è. Ora la lista passa per `resolveProjectRefs`, che
  // risolve nome e `path` — e senza `path` non c'è icona — dallo stesso indice
  // che alimenta il chip del composer e il «Sposta su…» del drawer.
  const projectIndex = useBoardProjects(mode === 'all');
  const taskProjectIds = useMemo(() => Array.from(new Set(tasks.map((t) => t.projectId))), [tasks]);
  // I task «senza progetto» sono di DUE specie (`_none` e la board catch-all
  // `generale-<hash>`), ma per chi filtra sono una cosa sola: una riga, che
  // accende e spegne entrambi gli id.
  const projectlessIds = useMemo(() => taskProjectIds.filter(isProjectlessId), [taskProjectIds]);
  const projectCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of tasks) {
      const key = isProjectlessId(t.projectId) ? UNASSIGNED_PROJECT_ID : t.projectId;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }, [tasks]);
  const projectOptions = useMemo(() => {
    const refs = resolveProjectRefs(taskProjectIds.filter((id) => !isProjectlessId(id)), projectIndex);
    return projectlessIds.length
      ? [{ projectId: UNASSIGNED_PROJECT_ID, name: 'Senza progetto', path: '' }, ...refs]
      : refs;
  }, [taskProjectIds, projectlessIds, projectIndex]);
  const showProjects = mode === 'all' && projectOptions.length > 0;
  // Gli id che la riga «Senza progetto» rappresenta davvero.
  const idsFor = (p: BoardProjectRef) =>
    (p.projectId === UNASSIGNED_PROJECT_ID && projectlessIds.length ? projectlessIds : [p.projectId]);
  const selectedProjectIds = useMemo(() => {
    const sel = new Set(filters.projectId);
    // La riga sintetica si accende se è acceso uno QUALSIASI dei suoi id.
    if (projectlessIds.some((id) => sel.has(id))) sel.add(UNASSIGNED_PROJECT_ID);
    return Array.from(sel);
  }, [filters.projectId, projectlessIds]);
  const toggleProject = (p: BoardProjectRef) => {
    const ids = idsFor(p);
    const on = ids.some((id) => filters.projectId.includes(id));
    const updated = on
      ? filters.projectId.filter((x) => !ids.includes(x))
      : [...filters.projectId, ...ids.filter((id) => !filters.projectId.includes(id))];
    onFiltersChange({ ...filters, projectId: updated });
  };
  // Le RIGHE accese (non gli id: «Senza progetto» ne rappresenta due). Un solo
  // progetto filtrato → il chip lo MOSTRA (icona + nome), invece di dire
  // «Progetto ·1» e costringere ad aprire il menu per sapere quale.
  const pickedProjects = useMemo(
    () => projectOptions.filter((p) => selectedProjectIds.includes(p.projectId)),
    [projectOptions, selectedProjectIds],
  );
  const soleProject = pickedProjects.length === 1 ? pickedProjects[0]! : null;

  const anyActive = filters.priority.length + filters.assignedTo.length + filters.projectId.length + (filters.text ? 1 : 0) > 0;

  // Same chip look the composer uses for its model/priority/project pickers.
  // Explicit h-6 (not py-*) so the search <input> — which renders taller from
  // its UA line-height — sits at the exact same height as these buttons.
  const chip = (active: boolean) =>
    `flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${
      active ? 'bg-black/15 text-app-text dark:bg-white/15' : 'bg-black/5 text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
    }`;
  const menuHeader = 'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted';

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* Search — always visible */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-app-text-secondary" />
        <input
          value={filters.text}
          onChange={(e) => onFiltersChange({ ...filters, text: e.target.value })}
          placeholder="cerca…"
          aria-label="Cerca nei task"
          className="h-6 w-28 rounded-md bg-black/5 pl-6 pr-1.5 text-[11px] leading-none text-app-text outline-none placeholder:text-app-placeholder focus:bg-black/10 dark:bg-white/5 dark:focus:bg-white/10 sm:w-40"
        />
      </div>

      {/* Priority — chip + Menu (multi-select, no "auto") */}
      <button ref={prioBtnRef} onClick={() => setPrioOpen(true)} title="Filtra per priorità" className={chip(filters.priority.length > 0)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-app-text-faint" />
        Priorità{filters.priority.length > 0 && <span className="tabular-nums text-app-text-secondary">·{filters.priority.length}</span>}
        <ChevronDown className="h-3 w-3 text-app-text-muted" />
      </button>
      <Menu open={prioOpen} anchorRef={prioBtnRef} onClose={() => setPrioOpen(false)} minWidth={170} role="listbox">
        <p className={menuHeader}>Priorità</p>
        {PRIORITY_ORDER.map((p) => (
          <FilterOption
            key={p} selected={filters.priority.includes(p)} onClick={() => togglePriority(p)}
            dot={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />} label={PRIORITY_LABEL[p]}
          />
        ))}
      </Menu>

      {/* Assignee — chip + Menu (only when there are assignees) */}
      {assignees.length > 0 && (
        <>
          <button ref={asgBtnRef} onClick={() => setAsgOpen(true)} title="Filtra per assegnatario" className={chip(filters.assignedTo.length > 0)}>
            Assegnatario{filters.assignedTo.length > 0 && <span className="tabular-nums text-app-text-secondary">·{filters.assignedTo.length}</span>}
            <ChevronDown className="h-3 w-3 text-app-text-muted" />
          </button>
          <Menu open={asgOpen} anchorRef={asgBtnRef} onClose={() => setAsgOpen(false)} minWidth={170} role="listbox">
            <p className={menuHeader}>{tr('board.filter.assignee')}</p>
            {assignees.map((a) => (
              <FilterOption key={a} selected={filters.assignedTo.includes(a)} onClick={() => toggleAssignedTo(a)} label={`@${a}`} />
            ))}
          </Menu>
        </>
      )}

      {/* Progetto — chip + LO STESSO ProjectPickerBody del composer, in
          modalità multi-selezione: il menu non si chiude a ogni clic perché un
          filtro si costruisce a più scelte. */}
      {showProjects && (
        <>
          <button
            ref={projBtnRef} onClick={() => setProjOpen(true)}
            data-testid="filter-project-chip"
            title={soleProject ? `Filtro progetto: ${soleProject.name}` : 'Filtra per progetto'}
            className={`${chip(filters.projectId.length > 0)} min-w-0 max-w-[11rem]`}
          >
            {soleProject && <ProjectFavicon path={soleProject.path} size={12} />}
            <span className="min-w-0 truncate">{soleProject ? soleProject.name : 'Progetto'}</span>
            {!soleProject && pickedProjects.length > 0 && (
              <span className="tabular-nums text-app-text-secondary">·{pickedProjects.length}</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
          </button>
          <Menu open={projOpen} anchorRef={projBtnRef} onClose={() => setProjOpen(false)} minWidth={230} role="listbox" unmanagedFocus>
            <ProjectPickerBody
              projects={projectOptions}
              selectedIds={selectedProjectIds}
              onPick={toggleProject}
              busy={false}
              listLabel={tr('common.project')}
              counts={projectCounts}
            />
          </Menu>
        </>
      )}

      {/* Reset — only when something is active */}
      {anyActive && (
        <button onClick={reset} title="Resetta filtri" className="rounded p-0.5 text-app-text-muted hover:bg-white/10 hover:text-app-text">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function KanbanBoardPane({ projectPath, global = false, onMessage, onOpenTopic }: Props) {
  const projectId = useMemo(() => (projectPath ? boardIdForPath(projectPath) : ''), [projectPath]);
  // The project/all toggle only makes sense inside a project window. The global
  // pane has no project, so it locks to 'all'.
  const canToggle = !!projectPath && !global;
  // Per-board dispatch settings only exist for a single project (the global board
  // aggregates many), so the gear only shows inside a project window.
  const hasProject = !!projectPath && !global;
  // 'project' = this project only · 'all' = the global cross-project board.
  const [mode, setMode] = useState<'project' | 'all'>(canToggle ? 'project' : 'all');
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  // Sessions running outside the kanban. Scoped to this board in project mode,
  // machine-wide on the global board — same scoping rule as the task list.
  const externalSessions = useExternalSessions(onMessage, mode === 'project' ? projectId : undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Quale tab del task mettere davanti all'apertura, quando ad aprirlo è stato
  // un gesto mirato (il bottone «apri in una tab» sull'anteprima della card).
  // Si azzera a ogni altra apertura: vale per QUEL click, non è uno stato.
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
  const openTask = useCallback<OpenTask>((id, focusPaneId) => {
    setSelectedId(id);
    setPendingPaneId(focusPaneId ?? null);
  }, []);
  const columnsScrollRef = useRef<HTMLDivElement>(null);
  // Mobile-only affordance: the toolbar strip below scrolls horizontally with
  // a hidden scrollbar, so without a visible cue the actions past the right
  // edge are only discoverable by swiping blind. Tracks live scroll position
  // to fade out once the strip reaches its end.
  const toolbarScrollRef = useRef<HTMLDivElement>(null);
  const [toolbarOverflowRight, setToolbarOverflowRight] = useState(false);
  // Provider model list for the board-default picker (settings panel). Seeded
  // from the snapshot and kept live — same source the composer's picker uses.
  const [claudeModels, setClaudeModels] = useState<string[]>(
    () => getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? [],
  );
  useEffect(() => subscribeProvidersSnapshot((state) => {
    setClaudeModels(state.snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? []);
  }), []);
  // Deep-link target (from /task/<id> via openTaskLink): the GLOBAL board owns it
  // (that's what the link opens). Seeded from the CURRENT URL (not a one-shot
  // boot pending) so it survives a remount and an inactive→active board tab —
  // the URL is the source of truth. Fed live by `topics:open-task` when the
  // board is already open. Held until the task shows up in the loaded list,
  // then it becomes the selection.
  const [pendingSelect, setPendingSelect] = useState<string | null>(
    () => (global ? currentTaskTarget()?.taskId ?? null : null),
  );
  useEffect(() => {
    if (!global) return;
    const onOpenTask = (e: Event) => {
      const id = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (id) setPendingSelect(id);
    };
    window.addEventListener('topics:open-task', onOpenTask as EventListener);
    return () => window.removeEventListener('topics:open-task', onOpenTask as EventListener);
  }, [global]);
  // Opening the drawer shrinks the columns viewport (flex sibling): the card
  // that was just clicked can end up outside it. Bring it back after layout
  // settles — rAF fires post-commit, when the row already has its new width.
  // Scroll the columns row's OWN scrollLeft directly (never
  // element.scrollIntoView(): its automatic ancestor-walk can escape this
  // (horizontal-only) concern onto an unrelated vertical/overflow-hidden
  // ancestor — that's what silently scrolled the whole drawer, header and
  // close button included, out of view on mobile).
  useEffect(() => {
    if (!selectedId) return;
    const raf = requestAnimationFrame(() => {
      const container = columnsScrollRef.current;
      const card = document.querySelector(`[data-task-card="${selectedId}"]`);
      if (!container || !card) return;
      const containerRect = container.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      if (cardRect.left < containerRect.left) {
        container.scrollBy({ left: cardRect.left - containerRect.left, behavior: 'smooth' });
      } else if (cardRect.right > containerRect.right) {
        container.scrollBy({ left: cardRect.right - containerRect.right, behavior: 'smooth' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);
  const [showSettings, setShowSettings] = useState(false);
  // Per-board dispatch settings, owned HERE (not by the settings panel) so the
  // header can always answer "does moving a task to Todo start an agent?" —
  // the exact feedback that was missing when a task sat in Todo doing nothing.
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  // The START switch is GLOBAL (one for every board) — so the pill lives on
  // every header, including the global board, and clicking it IS the toggle.
  const [dispatchOn, setDispatchOn] = useState<boolean | null>(null);

  // Filters state + localStorage persistence (per board / per 'all' view).
  interface Filters {
    priority: number[];
    assignedTo: string[];
    text: string;
    projectId: string[];
  }
  const storageKey = `board:filters-${mode === 'all' ? 'all' : projectId}`;
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : { priority: [], assignedTo: [], text: '', projectId: [] };
    } catch { return { priority: [], assignedTo: [], text: '', projectId: [] }; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(filters)); } catch { /* private mode */ }
  }, [filters, storageKey]);

  useEffect(() => {
    let alive = true;
    boardApi.getGlobalDispatch()
      .then((v) => { if (alive) setDispatchOn(v); })
      .catch(() => { /* pill just stays hidden */ });
    return () => { alive = false; };
  }, []);

  const toggleDispatch = useCallback(async () => {
    if (dispatchOn === null) return;
    try { setDispatchOn(await boardApi.setGlobalDispatch(!dispatchOn)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'dispatch toggle failed'); }
  }, [dispatchOn]);

  useEffect(() => {
    if (!hasProject) { setSettings(null); return; }
    let alive = true;
    boardApi.getSettings(projectId)
      .then((v) => { if (alive) setSettings(v); })
      .catch(() => { /* panel just stays empty */ });
    return () => { alive = false; };
  }, [hasProject, projectId]);

  const refetch = useCallback(async () => {
    try {
      setTasks(mode === 'all' ? await boardApi.listAll() : await boardApi.list(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load board');
    } finally {
      setLoading(false);
    }
  }, [projectId, mode]);

  useEffect(() => { setLoading(true); refetch(); }, [refetch]);

  // Live updates. In 'all' mode any task event is relevant; in 'project' mode
  // only events for this project (or project-less broadcasts) trigger a refetch.
  // board:settings keeps the header pill honest when another client toggles it.
  //
  // While a card is being DRAGGED the refetch is deferred: replacing `tasks`
  // mid-drag re-renders the columns under the pointer (chip flips, status
  // events, other clients) and the drag stutters or drops — the queued refetch
  // flushes at drag end.
  // Live per-turn usage (model · execution-time · tokens) keyed by task id,
  // fed by `task:usage-live` and dropped when the turn ends. Drives the ticking
  // chip on working cards; the persisted agent_ms/agent_tokens take over after.
  const [liveUsage, setLiveUsage] = useState<Map<string, LiveUsage>>(new Map());
  // «Questo task aspetta TE», mentre il turno e' ancora vivo: un pannello di
  // domanda o un permesso aperti a meta' turno. Transitorio come liveUsage, e
  // per una ragione in piu': l'attesa vive nelle mappe in memoria del server, e
  // a server riavviato NON esiste piu'. Persisterla in dispatch_state la farebbe
  // sopravvivere a cio' che la sostiene — ed e' gia' costata un task congelato.
  const [awaitingHuman, setAwaitingHuman] = useState<Set<string>>(new Set());
  const draggingRef = useRef(false);
  const pendingRefetch = useRef(false);
  const safeRefetch = useCallback(() => {
    if (draggingRef.current) { pendingRefetch.current = true; return; }
    refetch();
  }, [refetch]);
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string; settings?: BoardSettings; autoDispatch?: boolean; task?: BoardTask;
        taskId?: string; turnStartedAt?: number; baseMs?: number; liveTokens?: number; model?: string | null;
        waiting?: boolean };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        if (mode === 'all' || m.projectId === undefined || m.projectId === projectId) safeRefetch();
        // A turn that ended (or a task that left 'working') drops its live chip;
        // the refetched task then carries the final agent_ms/agent_tokens.
        if (m.task && m.task.dispatchState !== 'working') {
          setLiveUsage((prev) => { if (!prev.has(m.task!.id)) return prev; const n = new Map(prev); n.delete(m.task!.id); return n; });
        }
      }
      // Live per-turn preview from the dispatcher: model + tokens-so-far +
      // execution-time-so-far, ticked on the card while the agent works.
      if (m.type === 'task:usage-live' && typeof m.taskId === 'string'
        && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
        setLiveUsage((prev) => {
          const n = new Map(prev);
          n.set(m.taskId!, { turnStartedAt: m.turnStartedAt ?? Date.now(), baseMs: m.baseMs ?? 0, liveTokens: m.liveTokens ?? 0, model: m.model ?? null });
          return n;
        });
      }
      if (m.type === 'task:awaiting-human' && typeof m.taskId === 'string'
        && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
        setAwaitingHuman((prev) => {
          const has = prev.has(m.taskId!);
          if (m.waiting === has) return prev; // nessun cambio: niente re-render
          const n = new Set(prev);
          if (m.waiting) n.add(m.taskId!); else n.delete(m.taskId!);
          return n;
        });
      }
      if (m.type === 'board:settings' && m.projectId === projectId && m.settings) setSettings(m.settings);
      // Global switch flipped anywhere (any board, any client) → this pill too.
      if (m.type === 'board:dispatch' && typeof m.autoDispatch === 'boolean') setDispatchOn(m.autoDispatch);
    });
  }, [onMessage, projectId, safeRefetch, mode]);

  // Wake-up refresh: a window coming back from sleep/background has yesterday's
  // board (WS events happened while it slept) — and the live "ci sta mettendo"
  // Ticker recomputes from Date.now(), so a stale 'working' card reads hours of
  // agent work that never happened. Any return to visibility refetches.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') safeRefetch(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [safeRefetch]);

  // Task chiusi la cui consegna NON risulta su main (verdetto dell'audit
  // periodico). Deliberatamente NON filtrato dai filtri di header: è un allarme
  // sull'integrità della board, non una vista.
  const unlandedTasks = useMemo(
    () => tasks.filter((t) => t.status === 'done' && t.landingState === 'unlanded'),
    [tasks],
  );

  // Quanti CHECKOUT vivi tiene questo progetto.
  //
  // Il chip «non su main» accanto conta i BRANCH non landati; questo conta le
  // cartelle. Sono due accumuli diversi e si spostano separatamente: un branch
  // landato libera il suo worktree, ma un worktree tenuto perche' il task e'
  // ancora aperto non ha nessun branch da landare. Con un numero solo non si
  // capisce quale dei due sta crescendo — ed e' cresciuto in silenzio fino a
  // ~40 worktree il 21/07.
  const [worktreeCount, setWorktreeCount] = useState(0);
  const [gcRunning, setGcRunning] = useState(false);
  /** Rami locali non su main: quanti, e quanti non li reclama nessun task. */
  const [branchInv, setBranchInv] = useState<{ total: number; orphan: number; onOpenTasks: number } | null>(null);
  const [gcResult, setGcResult] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath || global) { setWorktreeCount(0); return; }
    let alive = true;
    const load = () => {
      fetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { worktrees?: unknown[] } | null) => {
          if (alive && Array.isArray(b?.worktrees)) setWorktreeCount(b.worktrees.length);
        })
        .catch(() => {});
    };
    load();
    // Il GC gira ogni 30 minuti e i dispatch creano worktree in continuazione:
    // un conteggio letto una volta sola al mount invecchia sotto gli occhi.
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [projectPath, global]);

  // I RAMI non su main, col task che li reclama.
  //
  // Il chip «N non su main» accanto conta solo i task CHIUSI: un ramo di un task
  // ancora in backlog — o di nessun task — non compariva da nessuna parte. È
  // così che quattro rami con lavoro fatto sono rimasti invisibili per
  // settimane, mentre la board riproponeva come «da fare» cose già scritte lì
  // dentro. Il numero che conta è quello degli ORFANI: nessuno li reclamerà.
  useEffect(() => {
    if (!projectPath || global) { setBranchInv(null); return; }
    let alive = true;
    fetch(`/api/worktrees/branches?project_path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { summary?: { total: number; orphan: number; onOpenTasks: number } } | null) => {
        if (alive && b?.summary) setBranchInv(b.summary);
      })
      // Un progetto che non è un repo git risponde 500: nessun inventario, e va
      // bene — non è un errore da mostrare, è un progetto senza rami.
      .catch(() => {});
    return () => { alive = false; };
  }, [projectPath, global]);

  // «Pulisci landati»: anticipa la passata del GC invece di aspettarne una.
  //
  // Non è più permissivo dell'automatico — è la STESSA passata, che reapa solo
  // ciò che è provabilmente sicuro. Per questo l'esito deve dire anche quanti
  // ne ha TENUTI e perché: un «0 ripuliti» secco farebbe sembrare rotto un
  // bottone che sta facendo la cosa giusta.
  const runGc = useCallback(async () => {
    setGcRunning(true);
    setGcResult(null);
    try {
      const r = await fetch('/api/worktrees/gc', { method: 'POST' });
      const b = (await r.json()) as { summary?: { reaped?: number; landed?: number; freed?: number; kept?: number; slimmed?: number; slimmedBytes?: number; keptReasons?: Record<string, number> } };
      const sm = b?.summary;
      if (!sm) { setGcResult('Il GC non ha risposto'); return; }
      const motivi = Object.entries(sm.keptReasons ?? {}).sort((a, b2) => b2[1] - a[1]).slice(0, 2)
        .map(([m, n]) => `${n}× ${m}`).join('; ');
      // `liberati` è la voce che oggi fa quasi tutto il lavoro (cartella via,
      // branch conservato): senza, la passata che ne libera 77 direbbe «0
      // ripuliti, 0 landati» e sembrerebbe non aver fatto niente.
      //
      // Lo stesso vale per gli `snelliti`: una passata che tiene TUTTI i
      // worktree può comunque aver liberato qualche giga di `node_modules`, e
      // senza questa voce direbbe solo «0, 0, 0, N tenuti».
      const snelliti = (sm.slimmed ?? 0) > 0
        ? `, ${sm.slimmed} snelliti (${Math.round((sm.slimmedBytes ?? 0) / 1_048_576)} MB)`
        : '';
      setGcResult(
        `${sm.reaped ?? 0} ripuliti, ${sm.freed ?? 0} liberati (branch salvo), ${sm.landed ?? 0} landati${snelliti}, ${sm.kept ?? 0} tenuti`
        + (motivi ? ` — ${motivi}` : ''),
      );
      // Il conteggio accanto deve riflettere la passata appena fatta.
      if (projectPath) {
        const rr = await fetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`);
        if (rr.ok) {
          const bb = (await rr.json()) as { worktrees?: unknown[] };
          if (Array.isArray(bb.worktrees)) setWorktreeCount(bb.worktrees.length);
        }
      }
    } catch {
      setGcResult('Il GC non ha risposto');
    } finally {
      setGcRunning(false);
    }
  }, [projectPath]);

  // `kanbanOrder` è una chiave PER BOARD: nella board generale i numeri vengono
  // da sequenze indipendenti e non si confrontano. Lo scope lo dice al
  // comparatore (e a `planDrop`, che lì non scrive posizioni).
  const orderScope: OrderScope = mode === 'all' ? 'cross-project' : 'board';

  const byStatus = useMemo(() => {
    const visible = tasks.filter((t) => {
      // Apply filters: all active conditions must match (AND logic).
      if (filters.priority.length > 0 && !filters.priority.includes(t.priority)) return false;
      if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(t.assignedTo || '')) return false;
      if (filters.text && !t.text.toLowerCase().includes(filters.text.toLowerCase())) return false;
      if (filters.projectId.length > 0 && !filters.projectId.includes(t.projectId)) return false;
      return true;
    });
    return groupByStatus(visible, orderScope);
  }, [tasks, filters, orderScope]);

  // Le card appena CHIUSE, per il lampo verde. Si guarda `tasks` (la lista
  // grezza), non `byStatus`: un filtro attivo può nascondere la card, e il lampo
  // non deve dipendere da cosa si sta guardando — quando riappare l'ha già
  // consumato, che è giusto, ma la transizione resta registrata una volta sola.
  //
  // Vale per OGNI via di chiusura, perché nessuna passa di qui direttamente: il
  // trascinamento, l'approvazione dal drawer e un altro device finiscono tutti e
  // tre nello stesso refetch. Il confronto è con lo stato precedente (vedi
  // `lib/justDone`), non con la freschezza di `completedAt`.
  const [justDone, setJustDone] = useState<Set<string>>(() => new Set());
  const prevStatusRef = useRef<Map<string, TaskStatus> | null>(null);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const landed = landedInDone(prevStatusRef.current, tasks);
    prevStatusRef.current = statusSnapshot(tasks);
    if (landed.length === 0) return;
    setJustDone((prev) => {
      const next = new Set(prev);
      for (const id of landed) next.add(id);
      return next;
    });
    for (const id of landed) {
      clearTimeout(flashTimers.current.get(id));
      flashTimers.current.set(id, setTimeout(() => {
        flashTimers.current.delete(id);
        setJustDone((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, DONE_FLASH_MS));
    }
  }, [tasks]);
  // Smontando la pane a lampo acceso i timer resterebbero appesi a chiamare un
  // setState su un componente che non c'è più.
  useEffect(() => {
    const timers = flashTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  // …e portare Done DOVE SI GUARDA. Il lampo da solo non bastava: nel layout
  // normale — sidebar più cinque colonne, con Review più larga delle altre —
  // Done sta oltre il bordo destro. Misurato: a 1600×900 il bordo destro della
  // card appena chiusa cadeva a 2195px, cioè quasi 600 fuori dalla finestra. La
  // card arrivava, lampeggiava e si spegneva senza che nessuno la vedesse.
  //
  // Si scorre la riga delle colonne per la sua PROPRIA `scrollLeft`, mai
  // `element.scrollIntoView()`: la sua risalita automatica degli antenati può
  // uscire da questa preoccupazione (orizzontale) e portarsi dietro un antenato
  // verticale — vedi la nota sull'effetto della selezione qui sopra.
  useEffect(() => {
    if (justDone.size === 0) return;
    // rAF: l'effetto parte nello stesso commit in cui la card entra in colonna,
    // e il rettangolo di Done va misurato a layout fatto.
    const raf = requestAnimationFrame(() => {
      const container = columnsScrollRef.current;
      const col = container?.querySelector('[data-testid="kanban-column-done"]');
      if (!container || !col) return;
      const cRect = container.getBoundingClientRect();
      const dRect = col.getBoundingClientRect();
      if (dRect.left >= cRect.left && dRect.right <= cRect.right) return; // già in vista
      container.scrollBy({ left: dRect.right - cRect.right, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [justDone]);

  // Task lookup by id for the parent chip ("⤴ epic…"). Best effort: a parent
  // not in the current fetch just shows the generic label.
  //
  // Il chip «in attesa di» NON passa più di qui: il bloccante lo risolve il
  // server (`task.blockedBy`), perché questa lista è un progetto solo,
  // `rootsOnly`, non archiviati — e un bloccante fuori da quel taglio faceva
  // sparire il chip da una card che il dispatcher teneva ferma comunque.
  const tasksById = useMemo(() => {
    const m = new Map<string, BoardTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Project path index, only needed in the cross-project board (per-card
  // favicon — task.projectId is a one-way hash, ProjectFavicon needs a path).
  // Dallo store CONDIVISO: card, filtro e composer devono vedere lo stesso
  // indice nello stesso istante, altrimenti l'icona compare su una superficie
  // e non sull'altra a seconda di chi ha fetchato prima.
  const projectIndex = useBoardProjects(mode === 'all');
  const projectPathById = useMemo(
    () => new Map((projectIndex ?? []).map((p) => [p.projectId, p.path])),
    [projectIndex],
  );

  const patchLocal = useCallback((id: string, patch: Partial<BoardTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /**
   * Persist a drop: status and/or position, optimistically. Routed by the
   * task's OWN projectId so it works identically in the global board.
   *
   * `plan.renumber` c'è solo nel caso raro in cui l'interstizio frazionario si
   * è esaurito (vedi `lib/boardOrder`): allora la colonna va riscritta a interi,
   * N patch invece di una. Si spedisce PRIMA la colonna e poi la card
   * trascinata, così se una scrittura cade a metà la card non resta l'unica
   * spostata in un ordine che non le corrisponde più; un errore qualsiasi
   * rifetcha e la verità torna dal server.
   */
  const dropTo = useCallback(async (task: BoardTask, plan: DropPlan) => {
    for (const r of plan.renumber ?? []) patchLocal(r.id, { kanbanOrder: r.kanbanOrder });
    patchLocal(task.id, plan.patch); // optimistic
    try {
      // `renumber` esiste solo nello scope `board` (nella board generale la
      // posizione non si scrive affatto), quindi le card riscritte sono per
      // costruzione dello STESSO progetto della trascinata.
      for (const r of plan.renumber ?? []) {
        await boardApi.update(task.projectId, r.id, { kanbanOrder: r.kanbanOrder });
      }
      await boardApi.update(task.projectId, task.id, plan.patch);
    } catch (e) { setError(e instanceof Error ? e.message : 'update failed'); refetch(); }
  }, [patchLocal, refetch]);

  const [activeId, setActiveId] = useState<string | null>(null);
  // Hide the floating "Descrivi un task" composer while the human is typing in
  // a field that SITS ON IT: a card's quick-reply / "Scrivi all'agent" box,
  // which opens low in a column, right under the composer.
  //
  // Il gate è ristretto alle COLONNE della board. Prima il listener era su
  // `window` e il predicato «un campo qualsiasi ha il fuoco»: mettere il cursore
  // nella chat di un'altra pane, in un terminale o in una ricerca faceva sparire
  // il composer di qua — un focus-out dalla board non sovrappone proprio niente.
  const [typingElsewhere, setTypingElsewhere] = useState(false);
  useEffect(() => {
    const sync = () => {
      const el = document.activeElement as HTMLElement | null;
      const isField = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      // Solo i campi DENTRO il carosello delle colonne si sovrappongono al
      // composer. Il composer stesso e i menu portalati su <body> ne sono fuori
      // per costruzione, quindi non serve escluderli a mano.
      const inColumns = !!el && !!columnsScrollRef.current?.contains(el);
      setTypingElsewhere(isField && inColumns);
    };
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => { window.removeEventListener('focusin', sync); window.removeEventListener('focusout', sync); };
  }, []);
  // Mouse: pick a card up after a 4px drag. Touch: require a 200ms press-and-hold
  // (with an 8px slop) before a drag starts, so a horizontal swipe scrolls the
  // snap carousel instead of yanking the card under the finger.
  // Tastiera: spazio/invio afferra la card, le frecce la spostano, spazio molla,
  // Esc annulla. Senza questo sensore riordinare una colonna era possibile SOLO
  // col mouse — cambiare stato no (il selettore nel drawer c'è), ma la posizione
  // dentro la colonna non era raggiungibile in nessun altro modo.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const flushDrag = useCallback(() => {
    draggingRef.current = false;
    if (pendingRefetch.current) { pendingRefetch.current = false; refetch(); }
  }, [refetch]);
  const onDragStart = useCallback((e: DragStartEvent) => {
    draggingRef.current = true;
    setActiveId(String(e.active.id));
  }, []);
  // Cosa produce un drop sta in `lib/boardOrder` — puro e testato (bun:test):
  // qui resta solo il raccordo fra dnd-kit e la PATCH.
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    flushDrag();
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) return;
    const plan = planDrop({
      task,
      overId: e.over ? String(e.over.id) : null,
      byStatus,
      scope: orderScope,
    });
    if (plan) dropTo(task, plan);
  }, [tasks, byStatus, dropTo, flushDrag, orderScope]);
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;

  const create = useCallback(async (status: TaskStatus, text: string) => {
    // A task can't be created directly in Done — land it in Todo instead.
    const target: TaskStatus = status === 'done' ? 'todo' : status;
    try { await boardApi.create(projectId, { text, status: target }); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : 'create failed'); }
  }, [projectId, refetch]);

  const selected = tasks.find((t) => t.id === selectedId) || null;

  // Promote a deep-link target to the selection once the task lands in the
  // loaded list (the global board loads every project's tasks, so it will).
  useEffect(() => {
    if (!pendingSelect) return;
    if (tasks.some((t) => t.id === pendingSelect)) {
      setSelectedId(pendingSelect);
      setPendingSelect(null);
      // The deep-link is fulfilled (drawer opening) → release the board focus
      // intent held in usePanelLifecycle so later hydrates behave normally.
      window.dispatchEvent(new CustomEvent('topics:task-opened'));
    }
  }, [pendingSelect, tasks]);

  // URL ⇄ drawer reflection (GLOBAL board only — `/task/<id>` points at the
  // global board, matching buildTaskLink). Opening a drawer pushes `/task/<id>`;
  // closing it returns to '/' — so every open drawer has a copyable,
  // refresh-survivable URL and Back closes it. While a deep-link is still
  // resolving (pendingSelect set, task not yet loaded) leave the URL alone so
  // the incoming path isn't wiped before the drawer opens.
  useEffect(() => {
    if (!global) return;
    if (selected) { reflectTaskOpen({ taskId: selected.id }); return; }
    if (pendingSelect) return; // deep-link mid-flight — keep the URL
    reflectTaskClose();
    // Depend on selectedId (primitive), NOT the `selected` object: its reference
    // churns on every board refetch while the id is what actually gates the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [global, selectedId, pendingSelect]);

  // Back/forward drive the drawer from history: the value-equality guard in
  // reflect* means setting the selection here won't re-push a duplicate entry.
  useEffect(() => {
    if (!global) return;
    return subscribePopstateTask((target) => setSelectedId(target?.taskId ?? null));
  }, [global]);

  useEffect(() => {
    const el = toolbarScrollRef.current;
    if (!el) return;
    const update = () => {
      setToolbarOverflowRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tasks, filters, mode, unlandedTasks.length]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-app-text-secondary"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally.
          On phone the toolbar is too dense to fit — it becomes a single
          horizontally-scrollable strip (no wrap, hidden scrollbar) so nothing is
          clipped; on desktop it sits inline with the trailing actions ml-auto'd.
          The fade+chevron below is the mobile-only affordance that the strip
          continues past the right edge — it tracks live scroll position and
          disappears once fully scrolled. */}
      <div className="relative shrink-0 border-b border-app-border">
      <div ref={toolbarScrollRef} className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:px-3">
        {canToggle ? (
          <>
            <button
              onClick={() => setMode('project')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'project' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >Questo progetto</button>
            <button
              onClick={() => setMode('all')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'all' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >Tutti i progetti</button>
          </>
        ) : (
          <span className="text-xs font-semibold text-app-text">Board<span className="hidden sm:inline"> generale</span></span>
        )}
        <GlobalSettingsMenu onMessage={onMessage} />
        <OverloadBadge />
        {/* Landing audit: task chiusi il cui lavoro NON è su main. Zero = il
            badge sparisce. Un click apre il primo, così il contatore è una
            porta e non un numero da guardare. */}
        {unlandedTasks.length > 0 && (
          <button
            onClick={() => setSelectedId(unlandedTasks[0]!.id)}
            title={`${unlandedTasks.length} task chiusi il cui lavoro non risulta su main:\n${unlandedTasks.slice(0, 8).map((t) => `• ${t.text}`).join('\n')}`}
            className="flex items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/30"
            data-testid="unlanded-badge"
          ><AlertTriangle className="h-3 w-3 shrink-0" /> {unlandedTasks.length} non su main</button>
        )}
        {worktreeCount > 0 && (
          <span
            title={`${worktreeCount} worktree vivi per questo progetto.\nIl GC ne ripulisce solo quelli provabilmente sicuri, e scrive nel log dei motivi perche' tiene gli altri.`}
            className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[11px] text-app-text-secondary"
            data-testid="worktree-count-badge"
          >{worktreeCount} worktree</span>
        )}
        {branchInv && branchInv.total > 0 && (branchInv.orphan > 0 || branchInv.onOpenTasks > 0) && (
          <span
            title={`${branchInv.total} rami locali non su main.\n${branchInv.orphan} non appartengono a nessun task — nessuno li reclamerà.\n${branchInv.onOpenTasks} sono di task ancora aperti: quel lavoro esiste già.`}
            className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300"
            data-testid="branch-inventory-badge"
          >{branchInv.orphan > 0 ? `${branchInv.orphan} rami orfani` : `${branchInv.onOpenTasks} rami su task aperti`}</span>
        )}
        {worktreeCount > 0 && (
          <button
            onClick={runGc}
            disabled={gcRunning}
            title={gcResult ?? "Anticipa la passata del GC. Reapa SOLO cio che e provabilmente sicuro — la stessa regola della passata automatica ogni 30 minuti, non una piu aggressiva."}
            className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/20 disabled:opacity-50"
            data-testid="worktree-gc-button"
          >{gcRunning ? 'Pulisco…' : 'Pulisci landati'}</button>
        )}
        {gcResult && (
          <span className="shrink-0 text-[11px] text-app-text-muted" data-testid="worktree-gc-result">{gcResult}</span>
        )}
        <div className="ml-2 min-w-0">
          <InlineFilters filters={filters} onFiltersChange={setFilters} tasks={tasks} mode={mode} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === 'all' && <span className="hidden text-[11px] text-app-text-muted sm:inline">{tasks.length} task · tutti i progetti</span>}
          {/* The work the kanban does NOT govern — otherwise a repo with three
              bare `claude` sessions and no cards reads as "fermo". */}
          <ExternalSessionsBadge sessions={externalSessions} showProject={mode === 'all'} onOpenTopic={onOpenTopic} />
          {/* Auto-dispatch on/off lives in GlobalSettingsMenu now — no duplicate pill. */}
          <PublishControl />
          {hasProject && (
            <button
              onClick={() => setShowSettings((s) => !s)}
              className={`rounded p-1 ${showSettings ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
              title="Impostazioni auto-dispatch"
            ><Settings className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
      {toolbarOverflowRight && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-app-bg to-transparent sm:hidden"
          data-testid="toolbar-overflow-affordance"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
        </div>
      )}
      </div>
      {error && <div className="shrink-0 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">{error}</div>}
      {showSettings && hasProject && (
        <BoardSettingsPanel
          projectId={projectId}
          settings={settings}
          dispatchOn={dispatchOn}
          models={claudeModels}
          onToggleDispatch={toggleDispatch}
          onChanged={setSettings}
          onClose={() => setShowSettings(false)}
          onError={setError}
        />
      )}
      {/* Board area + drawer share a flex row: an open (narrow) drawer SHRINKS
          the columns viewport instead of covering it, so every column stays
          reachable through the row's own horizontal scroll — nothing is ever
          "cut" behind the drawer. Wide mode opts back into absolute takeover
          (the drawer positions itself; out of flow, the board re-expands). */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); flushDrag(); }}>
            <div ref={columnsScrollRef} className="flex h-full min-w-0 snap-x snap-mandatory scroll-smooth gap-2 overflow-x-auto px-2 py-3 sm:gap-3 sm:px-3">
              {TASK_STATUSES.map((status) => (
                <Column
                  key={status}
                  status={status}
                  tasks={byStatus[status]}
                  onOpen={openTask}
                  onCreate={(text) => create(status, text)}
                  canCreate={mode === 'project'}
                  showProject={mode === 'all'}
                  onError={setError}
                  onRefetch={refetch}
                  onOpenTopic={onOpenTopic}
                  tasksById={tasksById}
                  projectPathById={projectPathById}
                  liveById={liveUsage}
                  awaitingHuman={awaitingHuman}
                  justDone={justDone}
                />
              ))}
            </div>
            {/* Portal to <body>: the overlay is position:fixed, and a transformed
                ancestor (pane translateX, FLIP animations) would re-anchor fixed
                positioning to itself — the ghost card then renders far from the
                pointer. On body there is no transform above it, ever. */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeTask ? (
                  <div className="w-64 rounded-md border border-app-border bg-surface p-2.5 text-sm text-app-text shadow-xl">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[activeTask.priority] ?? PRIORITY_DOT[2]}`} />
                      <span className="flex-1 leading-snug">{activeTask.text}</span>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          {/* New-task composer, anchored to the board AREA (centered on the
              visible columns). SEMPRE montato: quello che ci hai scritto dentro
              non deve evaporare perché hai guardato altrove o hai aperto un
              task. Si nasconde soltanto quando qualcosa gli sta davvero sopra —
              un campo aperto in una colonna, o (sotto lg) il drawer del task,
              che lì è un overlay a tutto schermo. Su desktop il drawer è un
              fratello in-flow accanto alle colonne: non lo copre, resta. */}
          <FloatingTaskComposer
            projectId={projectId}
            global={mode === 'all'}
            onCreated={refetch}
            onError={setError}
            hidden={typingElsewhere}
            hiddenBelowLg={!!selected}
            onOpenTopic={onOpenTopic}
          />

        </div>
        {selected && (
          <TaskDetail
            key={selected.id} /* fresh edit/scroll state per task (drawer navigation) */
            projectId={selected.projectId}
            taskId={selected.id}
            bump={selected.updatedAt}
            onClose={() => setSelectedId(null)}
            onChanged={refetch}
            onOpenTask={openTask}
            onOpenTopic={onOpenTopic}
            focusPaneId={pendingPaneId ?? undefined}
            /* Apertura automatica nel workspace: SOLO dalla board globale, che
               è una superficie a sé. Dentro una finestra di progetto la board è
               una pane di quella stessa finestra, e promuovere lì il risultato
               vorrebbe dire togliere spazio al drawer che stai leggendo — e
               rifare lo split a ogni card. Il bottone «Apri nel workspace»
               resta comunque, in entrambi i casi. */
            autoOpenInWorkspace={global}
          />
        )}
      </div>
    </div>
  );
}
