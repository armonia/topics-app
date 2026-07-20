/**
 * KanbanBoardPane — lean, Master-free task board (human surface).
 *
 * Rebuilt after the Master/Board subsystem was removed (42e92c1d): no Crown/lead,
 * no proposal cards, no autopilot. Five columns, drag between columns to change
 * status, a detail drawer with the comment thread, and a human review gate on the
 * Review column (approve → done / reject → in_progress). Talks only to the
 * project-scoped board API (client/src/lib/board.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { Bot, Check, ChevronDown, ChevronRight, Loader2, Search, Settings, UploadCloud, X } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { currentTaskTarget, reflectTaskOpen, reflectTaskClose, subscribePopstateTask } from '../../lib/openTaskLink';
import {
  boardApi, boardIdForPath, TASK_STATUSES, UNASSIGNED_PROJECT_ID,
  type BoardTask, type TaskStatus, type BoardSettings,
  type PublishProject, type DiffBundle, type DispatchCapacity, type GlobalSettings,
} from '../../lib/board';
import { UnifiedDiff } from './UnifiedDiff';
import { PRIORITY_DOT, PRIORITY_ORDER, PRIORITY_LABEL, type LiveUsage } from './constants';
import { boardCollision } from './format';
import { FloatingTaskComposer } from './FloatingTaskComposer';
import { Column } from './Card';
import { TaskDetail, BoardSettingsPanel } from './TaskDetail';

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
  const [projects, setProjects] = useState<PublishProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffBundle | 'loading' | 'error'>>({});
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
    const preview = p.commits.slice(0, 8).map((c) => `  • ${c.subject} (${c.hash}, ${c.author})`).join('\n');
    const more = p.commits.length > 8 ? `\n  …e altri ${p.commits.length - 8}` : '';
    if (!window.confirm(`Pubblicare "${p.name}" — push di ${p.ahead} commit su origin/${p.branch}?\n\n${preview}${more}\n\nAvvia il deploy dove configurato.`)) return;
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
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${pending.length ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' : 'bg-white/10 text-neutral-400 hover:bg-white/15'}`}
      >
        <UploadCloud className="h-3 w-3" /> Pubblica{total > 0 && <span className="ml-0.5 rounded bg-amber-500/30 px-1 tabular-nums">{total}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-96 overflow-y-auto rounded-lg border border-white/10 bg-neutral-900 p-1 shadow-xl">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500">Da pubblicare — controlla i commit prima</div>
            {pending.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-neutral-500">Niente da pubblicare — tutto già su remoto.</div>
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
                      {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">{p.name}<span className="ml-1 text-[11px] text-neutral-500">{p.ahead} commit · {p.branch}</span></span>
                    </button>
                    <button disabled={busy === p.projectId} onClick={() => doPublish(p)} className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 disabled:opacity-50">{busy === p.projectId ? '…' : 'Pubblica'}</button>
                  </div>
                  {isOpen && (
                    <ul className="mb-1 ml-4 space-y-0.5 border-l border-white/10 pl-2">
                      {p.commits.map((c) => (
                        <li key={c.hash} className="flex items-baseline gap-1.5 text-[11px] leading-tight">
                          <code className="shrink-0 text-neutral-500">{c.hash}</code>
                          <span className="min-w-0 flex-1 truncate text-neutral-300" title={c.subject}>{c.subject}</span>
                          <span className="shrink-0 text-neutral-600">{c.author} · {c.when}</span>
                        </li>
                      ))}
                      {p.commits.length >= 50 && <li className="text-[10px] text-neutral-600">…troncato a 50</li>}
                    </ul>
                  )}
                  {isOpen && (
                    <div className="mb-1.5 ml-4 border-l border-white/10 pl-2">
                      <div className="mb-0.5 text-[9px] uppercase tracking-wide text-neutral-600">Diff che verrà pubblicato</div>
                      {diffs[p.projectId] === 'loading' && <div className="text-[11px] text-neutral-500">Carico il diff…</div>}
                      {diffs[p.projectId] === 'error' && <div className="text-[11px] text-red-400">Errore nel caricare il diff.</div>}
                      {diffs[p.projectId] && typeof diffs[p.projectId] === 'object' && (
                        <UnifiedDiff bundle={diffs[p.projectId] as DiffBundle} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {msg && <div className="mt-0.5 border-t border-white/10 px-2 py-1.5 text-[11px] text-neutral-400">{msg}</div>}
          </div>
        </>
      )}
    </div>
  );
}

/** Machine-wide dispatch settings, reachable from EVERY board header (incl. the
 *  general board): the global auto-dispatch switch + the auto concurrency cap
 *  that is sized from live capacity and enforced across ALL boards. Per-board
 *  overrides still live in the project board's ⚙ inline panel. */
function GlobalSettingsMenu() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [g, setG] = useState<GlobalSettings | null>(null);
  const [cap, setCap] = useState<DispatchCapacity | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    boardApi.getGlobalSettings().then(setG).catch(() => { /* keep last */ });
    boardApi.dispatchCapacity().then(setCap).catch(() => { /* optional */ });
  };
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
        className={`-ml-1 flex items-center bg-transparent p-0 ${open ? 'text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`}
      ><ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288} unmanagedFocus>
        <div className="space-y-2.5 px-3 py-2.5 text-xs text-neutral-300">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Dispatch — tutte le board</p>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-neutral-400" /> Auto-dispatch</span>
            <input type="checkbox" checked={!!g?.autoDispatch} onChange={(e) => toggleAuto(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
          </label>
          <div className="space-y-1 border-t border-white/5 pt-2">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Agent in parallelo — auto</span>
              <input type="checkbox" checked={!!g?.maxAgentsAuto} disabled={busy} onChange={(e) => toggleCap(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
            </label>
            {g?.maxAgentsAuto ? (
              <p className="text-[11px] leading-snug text-neutral-500">
                <b className="text-emerald-300">{cap ? cap.recommended : '…'}</b> agent in parallelo su tutta la macchina{cap && <span className="text-neutral-600"> — {cap.reason}</span>}
              </p>
            ) : (
              <label className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-neutral-500">Numero fisso{cap && <span className="text-neutral-600"> (consigliato {cap.recommended})</span>}</span>
                <input
                  type="number" min={1} max={20} value={g?.maxAgents ?? 3}
                  onChange={(e) => setManual(Number(e.target.value))}
                  className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-neutral-100 outline-none"
                />
              </label>
            )}
            <p className="text-[10px] leading-snug text-neutral-600">Vale su TUTTE le board (una sola macchina, un solo limite).</p>
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
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
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
  const toggleProject = (pid: string) => {
    const updated = filters.projectId.includes(pid)
      ? filters.projectId.filter((x) => x !== pid)
      : [...filters.projectId, pid];
    onFiltersChange({ ...filters, projectId: updated });
  };
  const reset = () => onFiltersChange({ priority: [], assignedTo: [], text: '', projectId: [] });

  const assignees = Array.from(new Set(tasks.map((t) => t.assignedTo).filter(Boolean) as string[])).sort();
  const projects = Array.from(new Set(tasks.map((t) => t.projectId))).sort();
  const showProjects = mode === 'all' && projects.length > 0;
  const projName = (pid: string) => (pid === UNASSIGNED_PROJECT_ID ? 'senza progetto' : pid.replace(/-[^-]+$/, ''));
  const anyActive = filters.priority.length + filters.assignedTo.length + filters.projectId.length + (filters.text ? 1 : 0) > 0;

  // Same chip look the composer uses for its model/priority/project pickers.
  // Explicit h-6 (not py-*) so the search <input> — which renders taller from
  // its UA line-height — sits at the exact same height as these buttons.
  const chip = (active: boolean) =>
    `flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${
      active ? 'bg-white/15 text-neutral-100' : 'bg-white/5 text-neutral-300 hover:bg-white/10'
    }`;
  const menuHeader = 'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500';

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* Search — always visible */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500" />
        <input
          value={filters.text}
          onChange={(e) => onFiltersChange({ ...filters, text: e.target.value })}
          placeholder="cerca…"
          aria-label="Cerca nei task"
          className="h-6 w-28 rounded-md bg-white/5 pl-6 pr-1.5 text-[11px] leading-none text-neutral-100 outline-none placeholder:text-neutral-600 focus:bg-white/10 sm:w-40"
        />
      </div>

      {/* Priority — chip + Menu (multi-select, no "auto") */}
      <button ref={prioBtnRef} onClick={() => setPrioOpen(true)} title="Filtra per priorità" className={chip(filters.priority.length > 0)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-neutral-500" />
        Priorità{filters.priority.length > 0 && <span className="tabular-nums text-neutral-400">·{filters.priority.length}</span>}
        <ChevronDown className="h-3 w-3 text-neutral-500" />
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
            Assegnatario{filters.assignedTo.length > 0 && <span className="tabular-nums text-neutral-400">·{filters.assignedTo.length}</span>}
            <ChevronDown className="h-3 w-3 text-neutral-500" />
          </button>
          <Menu open={asgOpen} anchorRef={asgBtnRef} onClose={() => setAsgOpen(false)} minWidth={170} role="listbox">
            <p className={menuHeader}>Assegnatario</p>
            {assignees.map((a) => (
              <FilterOption key={a} selected={filters.assignedTo.includes(a)} onClick={() => toggleAssignedTo(a)} label={`@${a}`} />
            ))}
          </Menu>
        </>
      )}

      {/* Project — chip + Menu, only in the 'all' view */}
      {showProjects && (
        <>
          <button ref={projBtnRef} onClick={() => setProjOpen(true)} title="Filtra per progetto" className={chip(filters.projectId.length > 0)}>
            Progetto{filters.projectId.length > 0 && <span className="tabular-nums text-neutral-400">·{filters.projectId.length}</span>}
            <ChevronDown className="h-3 w-3 text-neutral-500" />
          </button>
          <Menu open={projOpen} anchorRef={projBtnRef} onClose={() => setProjOpen(false)} minWidth={200} role="listbox">
            <p className={menuHeader}>Progetto</p>
            {projects.map((pid) => (
              <FilterOption key={pid} selected={filters.projectId.includes(pid)} onClick={() => toggleProject(pid)} label={projName(pid)} />
            ))}
          </Menu>
        </>
      )}

      {/* Reset — only when something is active */}
      {anyActive && (
        <button onClick={reset} title="Resetta filtri" className="rounded p-0.5 text-neutral-500 hover:bg-white/10 hover:text-neutral-200">
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columnsScrollRef = useRef<HTMLDivElement>(null);
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
        taskId?: string; turnStartedAt?: number; baseMs?: number; liveTokens?: number; model?: string | null };
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

  const byStatus = useMemo(() => {
    const m: Record<TaskStatus, BoardTask[]> = { backlog: [], todo: [], in_progress: [], review: [], done: [] };
    for (const t of tasks) {
      // Apply filters: all active conditions must match (AND logic).
      if (filters.priority.length > 0 && !filters.priority.includes(t.priority)) continue;
      if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(t.assignedTo || '')) continue;
      if (filters.text && !t.text.toLowerCase().includes(filters.text.toLowerCase())) continue;
      if (filters.projectId.length > 0 && !filters.projectId.includes(t.projectId)) continue;
      (m[t.status] ??= []).push(t);
    }
    for (const s of TASK_STATUSES) m[s].sort((a, b) => a.kanbanOrder - b.kanbanOrder);
    // Review is a human inbox, not a hand-ordered lane: order it by LAST UPDATE
    // (most recent first) so a fresh delivery or a just-answered "serve te" floats
    // to the top — matching the "ultimo aggiornamento" shown on each card. The
    // other columns keep their manual kanbanOrder.
    m.review.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return m;
  }, [tasks, filters]);

  // Task lookup by id for card-level context chips: parent title ("⤴ epic…")
  // and blocked-by ("in attesa di…", needs the blocker's status too). Best
  // effort: a referenced task not in the current fetch (e.g. filtered) just
  // shows no chip.
  const tasksById = useMemo(() => {
    const m = new Map<string, BoardTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Project path index, only needed in the cross-project board (per-card
  // favicon — task.projectId is a one-way hash, ProjectFavicon needs a path).
  const [projectPathById, setProjectPathById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (mode !== 'all') return;
    let alive = true;
    boardApi.projects()
      .then((ps) => { if (alive) setProjectPathById(new Map(ps.map((p) => [p.projectId, p.path]))); })
      .catch(() => { /* card just falls back to the text label */ });
    return () => { alive = false; };
  }, [mode]);

  const patchLocal = useCallback((id: string, patch: Partial<BoardTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /** Persist a drop: status and/or position, optimistically. Routed by the
   *  task's OWN projectId so it works identically in the global board. */
  const dropTo = useCallback(async (task: BoardTask, patch: { status?: TaskStatus; kanbanOrder?: number }) => {
    patchLocal(task.id, patch); // optimistic
    try { await boardApi.update(task.projectId, task.id, patch); }
    catch (e) { setError(e instanceof Error ? e.message : 'update failed'); refetch(); }
  }, [patchLocal, refetch]);

  const [activeId, setActiveId] = useState<string | null>(null);
  // Hide the floating "Descrivi un task" composer while the human is typing in
  // ANY other field — a card's quick-reply / "Scrivi all'agent" box (which sit
  // low on screen, right under the composer) or the drawer thread. Tracked from
  // document focus so it covers every feedback input without wiring each one.
  const [typingElsewhere, setTypingElsewhere] = useState(false);
  useEffect(() => {
    const sync = () => {
      const el = document.activeElement as HTMLElement | null;
      const isField = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      const inComposer = !!el?.closest('[data-testid="board-task-composer"]');
      setTypingElsewhere(isField && !inComposer);
    };
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => { window.removeEventListener('focusin', sync); window.removeEventListener('focusout', sync); };
  }, []);
  // Mouse: pick a card up after a 4px drag. Touch: require a 200ms press-and-hold
  // (with an 8px slop) before a drag starts, so a horizontal swipe scrolls the
  // snap carousel instead of yanking the card under the finger.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const flushDrag = useCallback(() => {
    draggingRef.current = false;
    if (pendingRefetch.current) { pendingRefetch.current = false; refetch(); }
  }, [refetch]);
  const onDragStart = useCallback((e: DragStartEvent) => {
    draggingRef.current = true;
    setActiveId(String(e.active.id));
  }, []);
  // Fractional insertion key between two neighbours (SQLite NUMERIC affinity
  // keeps the float): no renumbering, one PATCH per drop.
  const between = (prev: number | undefined, next: number | undefined): number =>
    prev === undefined && next === undefined ? 1
    : prev === undefined ? next! - 1
    : next === undefined ? prev + 1
    : (prev + next) / 2;
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    flushDrag();
    const task = tasks.find((t) => t.id === e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!task || !overId || overId === task.id) return;
    // Dropped on a COLUMN (its empty area) → append; on a CARD → take its place.
    const overTask = TASK_STATUSES.includes(overId as TaskStatus) ? undefined : tasks.find((t) => t.id === overId);
    const status = overTask ? overTask.status : (overId as TaskStatus);
    if (!TASK_STATUSES.includes(status)) return;
    const col = byStatus[status].filter((t) => t.id !== task.id); // already kanbanOrder-sorted
    let idx = overTask ? col.findIndex((t) => t.id === overTask.id) : col.length;
    if (idx < 0) idx = col.length;
    // Same-column move DOWN past the over card = land after it (its old slot).
    if (overTask && task.status === status && task.kanbanOrder < overTask.kanbanOrder) idx += 1;
    const kanbanOrder = between(col[idx - 1]?.kanbanOrder, col[idx]?.kanbanOrder);
    if (task.status === status && kanbanOrder === task.kanbanOrder) return;
    dropTo(task, task.status === status ? { kanbanOrder } : { status, kanbanOrder });
  }, [tasks, byStatus, dropTo, flushDrag]);
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
  }, [global, selectedId, pendingSelect]);

  // Back/forward drive the drawer from history: the value-equality guard in
  // reflect* means setting the selection here won't re-push a duplicate entry.
  useEffect(() => {
    if (!global) return;
    return subscribePopstateTask((target) => setSelectedId(target?.taskId ?? null));
  }, [global]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-neutral-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally.
          On phone the toolbar is too dense to fit — it becomes a single
          horizontally-scrollable strip (no wrap, hidden scrollbar) so nothing is
          clipped; on desktop it sits inline with the trailing actions ml-auto'd. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:px-3">
        {canToggle ? (
          <>
            <button
              onClick={() => setMode('project')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'project' ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
            >Questo progetto</button>
            <button
              onClick={() => setMode('all')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'all' ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
            >Tutti i progetti</button>
          </>
        ) : (
          <span className="text-xs font-semibold text-neutral-200">Board<span className="hidden sm:inline"> generale</span></span>
        )}
        <GlobalSettingsMenu />
        <div className="ml-2 min-w-0">
          <InlineFilters filters={filters} onFiltersChange={setFilters} tasks={tasks} mode={mode} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === 'all' && <span className="hidden text-[11px] text-neutral-500 sm:inline">{tasks.length} task · tutti i progetti</span>}
          {/* Auto-dispatch on/off lives in GlobalSettingsMenu now — no duplicate pill. */}
          <PublishControl />
          {hasProject && (
            <button
              onClick={() => setShowSettings((s) => !s)}
              className={`rounded p-1 ${showSettings ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
              title="Impostazioni auto-dispatch"
            ><Settings className="h-3.5 w-3.5" /></button>
          )}
        </div>
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
                  onOpen={setSelectedId}
                  onCreate={(text) => create(status, text)}
                  canCreate={mode === 'project'}
                  showProject={mode === 'all'}
                  onError={setError}
                  onRefetch={refetch}
                  onOpenTopic={onOpenTopic}
                  tasksById={tasksById}
                  projectPathById={projectPathById}
                  liveById={liveUsage}
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
                  <div className="w-64 rounded-md border border-white/20 bg-neutral-800 p-2.5 text-sm text-neutral-100 shadow-xl">
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
              visible columns). Hidden while a task is open: the drawer is where
              you review and write feedback, and the floating "Descrivi un task"
              box otherwise sits on top of that input — reappears on close. */}
          {!selected && !typingElsewhere && (
            <FloatingTaskComposer
              projectId={projectId}
              global={mode === 'all'}
              onCreated={refetch}
              onError={setError}
            />
          )}
        </div>
        {selected && (
          <TaskDetail
            key={selected.id} /* fresh edit/scroll state per task (drawer navigation) */
            projectId={selected.projectId}
            taskId={selected.id}
            bump={selected.updatedAt}
            onClose={() => setSelectedId(null)}
            onChanged={refetch}
            onOpenTask={setSelectedId}
            onOpenTopic={onOpenTopic}
          />
        )}
      </div>
    </div>
  );
}
