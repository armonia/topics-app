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
import { DndContext, DragOverlay, closestCorners, pointerWithin, useDroppable, PointerSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bot, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Globe, GitCompare, Image as ImageIcon, Link2, Loader2, Lock, Maximize2, MessageSquare, Minimize2, PackageCheck, Paperclip, Plus, Sparkles, Square, Trash2, UploadCloud, X, ShieldCheck, ShieldX, Send, Settings, ArrowUpRight, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { ChatMarkdown } from '../ChatMarkdown';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { getMediaUrl } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';
import { buildTaskLink, consumePendingTaskOpen } from '../../lib/openTaskLink';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import {
  boardApi, boardIdForPath, TASK_STATUSES, STATUS_LABEL, parseQuestionBlock, UNASSIGNED_PROJECT_ID, AUTO_PROJECT_ID, isProjectlessId, boardDrafts,
  type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch,
  type BoardProjectRef, type PublishProject, type DiffBundle, type DispatchCapacity, type GlobalSettings,
} from '../../lib/board';
import { UnifiedDiff } from './UnifiedDiff';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';

/**
 * "claude-opus-4-8" → "Opus 4.8" — strip the `claude-` prefix, capitalize the
 * family name, join the remaining numeric segments with dots as the version.
 * Generic on purpose: a new model id needs no update here.
 */
function friendlyModelLabel(modelId: string): string {
  const parts = modelId.replace(/^claude-/, '').split('-');
  const name = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : modelId;
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/** Compact prose for the shared ChatMarkdown renderer inside small board
 *  surfaces (session slices, comments, task description): small text, tight
 *  paragraph/list rhythm, scrollable code blocks. */
const COMPACT_MD_CLS =
  // list-disc/decimal restore the markers Tailwind's preflight strips — without
  // them ul/ol render as unindented plain text and a bullet/numbered description
  // "non sembra formattata md". Headings get weight/size back too (preflight
  // flattens them), so an agent's plan reads as structured markdown.
  // break-words on prose (p/li/a) so a long unbreakable token — a URL, a path,
  // a hash — wraps instead of forcing the surface (card / drawer) to overflow.
  '[&_p]:my-0.5 [&_p]:break-words [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-2 ' +
  '[&_ul]:my-0.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-0.5 [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:my-0.5 [&_li]:break-words [&_li]:marker:text-neutral-500 ' +
  '[&_h1]:font-semibold [&_h1]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[13px] [&_h3]:font-semibold [&_h3]:text-xs [&_h1]:mt-1 [&_h2]:mt-1 [&_h3]:mt-1 ' +
  '[&_code]:text-[11px] [&_a]:break-words [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 [&_strong]:font-semibold';

// A PLAN is a document, not a chat bubble: this reading typography gives it a
// roomy vertical rhythm, section-divider headings, and prominent numbered steps
// so the agent's proposal is scannable instead of a dense wall. Used only by the
// "Piano" tab (the thread keeps COMPACT_MD_CLS). Kept in one string so the plan
// panel and any future plan surface share the exact same look.
const PLAN_MD_CLS =
  '[&_p]:my-2 [&_p]:leading-relaxed ' +
  // Headings act as section titles with an underline divider; first one flush to top.
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:pb-1 [&_h1]:border-b [&_h1]:border-white/10 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-neutral-100 ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:pb-1 [&_h2]:border-b [&_h2]:border-white/10 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-neutral-100 ' +
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-neutral-200 ' +
  '[&>*:first-child]:mt-0 ' +
  // Roomy lists; numbered steps get a bold violet marker so each step reads as a beat.
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-6 [&_ol]:list-decimal ' +
  '[&_li]:my-1.5 [&_li]:pl-1 [&_li]:leading-relaxed [&_li]:marker:text-violet-300/70 [&_ol>li]:marker:font-semibold [&_ol>li]:marker:text-violet-300 ' +
  '[&_li_ul]:my-1 [&_li_ol]:my-1 ' +
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:text-[12px] ' +
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-white/10 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_code]:text-[12px] ' +
  '[&_a]:text-sky-400 [&_a]:underline [&_strong]:font-semibold [&_strong]:text-neutral-100 ' +
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-violet-400/40 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-400 ' +
  '[&_hr]:my-3 [&_hr]:border-white/10';

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** Deep-link a task's bound agent tab into focus (wired to handleTopicClick). */
  onOpenTopic?: (topicId: string) => void;
}

const PRIORITY_DOT: Record<number, string> = {
  0: 'bg-neutral-400', 1: 'bg-sky-400', 2: 'bg-emerald-400', 3: 'bg-amber-400', 4: 'bg-rose-500',
};
// 4-first: the dispatch queue serves higher priorities first.
const PRIORITY_ORDER = [4, 3, 2, 1, 0] as const;
const PRIORITY_LABEL: Record<number, string> = {
  4: 'Urgente', 3: 'Alta', 2: 'Media', 1: 'Bassa', 0: 'Minima',
};

const STATUS_ICON_COLOR: Record<TaskStatus, string> = {
  backlog: 'text-neutral-500',
  todo: 'text-neutral-300',
  in_progress: 'text-sky-400',
  review: 'text-rose-400',
  done: 'text-emerald-400',
};

/**
 * Linear-style status glyph — the segmented progress circle that became the
 * de-facto standard for issue states (dashed ring → empty ring → half pie →
 * ¾ pie → checked disc). One shape family, color + fill carry the state, so
 * the eye reads progress at a glance even at 12px.
 */
function StatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: TaskStatus; className?: string }) {
  // Inner pie: a fat-stroked circle with pathLength=100 — dasharray N = N% of
  // the disc filled, rotated so the fill grows clockwise from 12 o'clock.
  const pie = (pct: number) => (
    <circle
      cx="7" cy="7" r="2.4" fill="none" stroke="currentColor" strokeWidth="4.8"
      pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 7 7)"
    />
  );
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={`${className} shrink-0 ${STATUS_ICON_COLOR[status]}`}>
      {status === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6.4" fill="currentColor" />
          <path d="M4.3 7.3l1.8 1.8 3.6-3.9" fill="none" stroke="#171717" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.6"
            {...(status === 'backlog' ? { strokeDasharray: '2.4 2.6', strokeLinecap: 'round' as const } : {})}
          />
          {status === 'in_progress' && pie(50)}
          {status === 'review' && pie(75)}
        </>
      )}
    </svg>
  );
}

/**
 * Size a textarea to its content (and keep it sized while typing) so the
 * click-to-edit swap <p> ↔ <textarea> never shifts the layout: same font,
 * same padding, same height as the text it replaces.
 */
const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

/**
 * Two-stage collision for a board that mixes BIG droppables (columns) with
 * SMALL ones (sortable cards). Bare closestCorners compares corner distances,
 * so an EMPTY column loses against a nearby card in the adjacent column — a
 * drop aimed at Todo kept resolving onto the In Progress card ("me lo fa
 * mettere solo in progress"). Pointer-first fixes it: whatever the pointer is
 * INSIDE wins (a card beats its own column for precise insertion; an empty
 * column area is the column); corner distance only breaks ties when the
 * pointer is outside every droppable (fast flicks).
 */
const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) {
    const card = within.find((c) => !TASK_STATUSES.includes(String(c.id) as TaskStatus));
    return card ? [card] : within;
  }
  return closestCorners(args);
};

// Card chip for the dispatch lifecycle (server: tasks.dispatch_state).
const DISPATCH_CHIP: Record<string, { text: string; cls: string; title?: string; Icon?: LucideIcon }> = {
  queued: { text: 'in coda', cls: 'bg-white/10 text-neutral-300' },
  starting: { text: 'avvio…', cls: 'bg-amber-500/15 text-amber-300' },
  working: { text: 'al lavoro', cls: 'bg-sky-500/15 text-sky-300' },
  // Both live in Review, but they ask different things of the human:
  // needs_input = the agent ASKED (answer required); delivered = clean
  // hand-off, the agent believes it's done (approve/reject).
  needs_input: { text: 'serve te', cls: 'bg-rose-500/15 text-rose-300' },
  delivered: { text: 'consegnato', cls: 'bg-emerald-500/15 text-emerald-300', title: "L'agent ha consegnato: aspetta la tua review", Icon: PackageCheck },
  // Parked in backlog after a dispatch ended badly. 'failed' = the agent genuinely
  // failed (timeout without review after the cap / repeated setup errors) — a red,
  // ringed chip so it never reads as a neutral manual "fermato". 'blocked' = a
  // config issue the human must fix first (no worktree / project unresolvable).
  // The specific reason rides in task.dispatchError → shown as the chip tooltip.
  failed: { text: 'fallito', cls: 'bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/40' },
  blocked: { text: 'da sistemare', cls: 'bg-amber-500/15 text-amber-300' },
};

/** Dispatch-state chip: state label + (optional) icon. DRYs the card + drawer
 *  render sites so both stay in lockstep. 'delivered' carries a PackageCheck
 *  glyph so "consegnato" reads at a glance, not just as colored text. */
function DispatchChip({ state, error }: { state: string; error?: string | null }) {
  const chip = DISPATCH_CHIP[state];
  if (!chip) return null;
  const Icon = chip.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${chip.cls}`}
      title={chip.title ?? error ?? undefined}
    >
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {chip.text}
    </span>
  );
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
    try { setG(await boardApi.setGlobalCap(v)); } catch { load(); } finally { setBusy(false); }
  };
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        title="Impostazioni dispatch — globali (tutte le board)"
        className={`flex items-center gap-0.5 rounded p-1 ${open ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
      ><Settings className="h-3.5 w-3.5" /><ChevronDown className="h-3 w-3" /></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288} unmanagedFocus>
        <div className="space-y-2.5 px-3 py-2.5 text-xs text-neutral-300">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Dispatch — tutte le board</p>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-neutral-400" /> Auto-dispatch</span>
            <input type="checkbox" checked={!!g?.autoDispatch} onChange={(e) => toggleAuto(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
          </label>
          <div className="space-y-1 border-t border-white/5 pt-2">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Cap agent automatico</span>
              <input type="checkbox" checked={!!g?.maxAgentsAuto} disabled={busy} onChange={(e) => toggleCap(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
            </label>
            <p className="text-[11px] leading-snug text-neutral-500">
              {g?.maxAgentsAuto
                ? <>Su tutta la macchina: <b className="text-emerald-300">{cap ? cap.recommended : '…'}</b> agent in parallelo{cap && <span className="text-neutral-600"> — {cap.reason}</span>}</>
                : <>Off: ogni board usa il suo cap (⚙ sulla board di progetto).</>}
            </p>
          </div>
        </div>
      </Menu>
    </>
  );
}

/** Collapsible "Modifiche" panel in the task drawer: lazy-loads the unified diff
 *  of what the task's dispatched agent changed in its isolated worktree, so a
 *  reviewer can see the actual changes before approving. */
function TaskChangesSection({ projectId, taskId, bump }: { projectId: string; taskId: string; bump?: string | number }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiffBundle | 'loading' | 'error' | null>(null);
  const fetchDiff = useCallback(() => {
    setState('loading');
    boardApi.taskDiff(projectId, taskId).then(setState).catch(() => setState('error'));
  }, [projectId, taskId]);
  // Re-fetch when the task advances (bump changes) IF the panel is open — the
  // agent may have committed more since it was last viewed.
  useEffect(() => { if (open) fetchDiff(); }, [open, bump, fetchDiff]);
  const toggle = () => setOpen((s) => !s);
  const bundle = state && typeof state === 'object' ? state : null;
  const fileCount = bundle && bundle.code !== 'no_worktree' ? bundle.stat.length : null;
  return (
    <div className="mb-2 rounded border border-white/10">
      <button onClick={toggle} className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-neutral-300 hover:bg-white/5">
        {open ? <ChevronDown className="h-3 w-3 text-neutral-500" /> : <ChevronRight className="h-3 w-3 text-neutral-500" />}
        <GitCompare className="h-3 w-3 text-neutral-500" /> Modifiche
        {fileCount != null && fileCount > 0 && <span className="text-neutral-500">({fileCount} file)</span>}
      </button>
      {open && (
        <div className="max-h-[42vh] overflow-y-auto px-2 pb-1.5">
          {state === 'loading' && <div className="text-[11px] text-neutral-500">Carico il diff…</div>}
          {state === 'error' && <div className="text-[11px] text-red-400">Errore nel caricare il diff.</div>}
          {bundle && bundle.code === 'no_worktree' && (
            <div className="text-[11px] text-neutral-500">Nessun worktree isolato per questo task — niente diff da mostrare.</div>
          )}
          {bundle && bundle.code !== 'no_worktree' && <UnifiedDiff bundle={bundle} defaultOpenFirst />}
        </div>
      )}
    </div>
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
          className="h-6 w-28 rounded-md bg-white/5 pl-6 pr-1.5 text-[11px] leading-none text-neutral-100 outline-none placeholder:text-neutral-600 focus:w-40 focus:bg-white/10"
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
  // Provider model list for the board-default picker (settings panel). Seeded
  // from the snapshot and kept live — same source the composer's picker uses.
  const [claudeModels, setClaudeModels] = useState<string[]>(
    () => getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? [],
  );
  useEffect(() => subscribeProvidersSnapshot((state) => {
    setClaudeModels(state.snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? []);
  }), []);
  // Deep-link target (from ?task=… via openTaskLink): the GLOBAL board owns it
  // (that's what the link opens). Seeded from the one-shot boot pending, and
  // fed live by `topics:open-task` when the board is already open. Held until
  // the task shows up in the loaded list, then it becomes the selection.
  const [pendingSelect, setPendingSelect] = useState<string | null>(
    () => (global ? consumePendingTaskOpen()?.taskId ?? null : null),
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
  useEffect(() => {
    if (!selectedId) return;
    const raf = requestAnimationFrame(() => {
      document.querySelector(`[data-task-card="${selectedId}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
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
    }
  }, [pendingSelect, tasks]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-neutral-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 py-1.5">
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
          <span className="text-xs font-semibold text-neutral-200">Board generale</span>
        )}
        <GlobalSettingsMenu />
        <div className="ml-2 min-w-0">
          <InlineFilters filters={filters} onFiltersChange={setFilters} tasks={tasks} mode={mode} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === 'all' && <span className="text-[11px] text-neutral-500">{tasks.length} task · tutti i progetti</span>}
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
            <div className="flex h-full min-w-0 gap-2 overflow-x-auto px-2 py-3 pb-20 sm:gap-3 sm:px-3">
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
          {/* Anchored to the board AREA (not the pane root) so it stays centered
              on the visible columns when the drawer is open beside them. */}
          <FloatingTaskComposer
            projectId={projectId}
            global={mode === 'all'}
            onCreated={refetch}
            onError={setError}
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
            onOpenTask={setSelectedId}
            onOpenTopic={onOpenTopic}
          />
        )}
      </div>
    </div>
  );
}

// ── Floating task composer ──────────────────────────────────────────────────
/**
 * The "dai questo all'agent" entry point: a floating input at the bottom of
 * the board. Collapsed it's a slim pill; on focus it RISES slightly and
 * expands (plan-first toggle, project select in the global board, submit) —
 * and eases back on blur. The task is born in Todo (the dispatch signal);
 * title = first line, full text goes to the description, and the dispatched
 * agent polishes the wording (kickoff rule) — no model to pick, ever.
 */
/**
 * Menu content shared by every "pick a project" surface (the composer's
 * project chip, the task-detail "Sposta su…" chip): a search box that filters
 * by name (case-insensitive) and, when the typed text matches no project
 * exactly, a "Crea '<text>'…" row that scaffolds it on the spot. Replaces the
 * old two-step "Nuovo progetto…" + separate input flow — search box IS the
 * create box now.
 */
function ProjectPickerBody({ projects, selectedId, isDisabled, onPick, onCreate, busy, listLabel, headerNote, onPickAuto, autoSelected }: {
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

// Single shared new-task draft → single caret key (board composer is global).
const COMPOSER_CURSOR_KEY = 'board:composer';

function FloatingTaskComposer({ projectId, global, onCreated, onError }: {
  projectId: string;
  /** Cross-project mode: no implicit board — the project picker chip appears. */
  global: boolean;
  onCreated: () => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [planFirst, setPlanFirst] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<BoardProjectRef[] | null>(null);
  const [targetProject, setTargetProject] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('board:composerProject');
      // '_none' is no longer a picker choice (auto falls back to it): migrate.
      return !stored || stored === UNASSIGNED_PROJECT_ID ? AUTO_PROJECT_ID : stored;
    } catch { return AUTO_PROJECT_ID; }
  });
  // Project picker — the SAME Menu-primitive selector the task-detail header
  // uses (portal, flip-above, keyboard nav), not a bare native <select>.
  const [projOpen, setProjOpen] = useState(false);
  const [projBusy, setProjBusy] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  // Model picker — "Intelligenza automatica" (null) or a claude-code model.
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  // Priority — "Automatica" (null: the agent evaluates it at kickoff) or 0-4.
  const [prioOpen, setPrioOpen] = useState(false);
  const [prio, setPrio] = useState<number | null>(null);
  const prioBtnRef = useRef<HTMLButtonElement>(null);
  // Server-persisted draft: a half-written task survives reload/app restart
  // and follows the user across clients. Restored once; local typing wins.
  const draftLoaded = useRef(false);
  useEffect(() => {
    let alive = true;
    boardDrafts.getComposer().then((d) => {
      if (!alive) return;
      if (d) {
        setText((cur) => cur || d.text || '');
        setModel((cur) => cur ?? d.model ?? null);
        setPrio((cur) => cur ?? d.prio ?? null);
        if (d.planFirst) setPlanFirst(true);
      }
      draftLoaded.current = true;
      // Restore the caret one frame after the draft text commits into the
      // textarea, so a hot reload lands you exactly where you were typing.
      requestAnimationFrame(() => restoreCursor(COMPOSER_CURSOR_KEY, taRef.current));
    }).catch(() => { draftLoaded.current = true; });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- restore-once on mount
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return; // never clobber the server draft pre-restore
    boardDrafts.putComposer({ text, model, prio, planFirst });
  }, [text, model, prio, planFirst]);
  const [claudeModels, setClaudeModels] = useState<string[]>(
    () => getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? [],
  );
  const modelsSubRef = useRef<(() => void) | null>(null);
  const loadModels = () => {
    if (modelsSubRef.current) return;
    modelsSubRef.current = subscribeProvidersSnapshot((state) => {
      setClaudeModels(state.snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? []);
    });
  };
  useEffect(() => () => { modelsSubRef.current?.(); }, []);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const saveCursor = () => { const ta = taRef.current; if (ta) writeCursor(COMPOSER_CURSOR_KEY, ta.selectionStart, ta.selectionEnd); };
  const wrapRef = useRef<HTMLDivElement>(null);
  // The Menu portals to <body>, so focus leaves the wrapper while it's open —
  // keep the composer expanded anyway.
  const expanded = focused || projOpen || modelOpen || prioOpen || text.trim().length > 0;

  const loadProjects = () => {
    if (projects === null) boardApi.projects().then(setProjects).catch(() => setProjects([]));
  };
  const onFocus = () => {
    setFocused(true);
    markActiveComposer(COMPOSER_CURSOR_KEY);
    if (global) loadProjects();
  };
  // Collapse only when focus truly LEFT the composer (not moving between its
  // own controls) — otherwise clicking "Plan first" would blur-shrink it.
  const onBlurCapture = (e: React.FocusEvent) => {
    if (projOpen || modelOpen) return;
    if (wrapRef.current && e.relatedTarget instanceof Node && wrapRef.current.contains(e.relatedTarget)) return;
    setFocused(false);
  };
  // WebKit: buttons do NOT take focus on click (relatedTarget = null), so the
  // blur check above can't recognise "still inside" and the pill collapsed
  // under the click (project chip, plan-first). Kill the focus steal at the
  // source: pointerdown on the composer's buttons keeps the textarea focused —
  // no blur, nothing to recover. Clicks still fire; the portaled Menu (and the
  // textarea itself) are untouched.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  };

  const target = global ? targetProject : projectId;
  const noneTarget = targetProject === UNASSIGNED_PROJECT_ID;
  const autoTarget = targetProject === AUTO_PROJECT_ID;
  const targetRef = projects?.find((p) => p.projectId === targetProject) ?? null;
  // Readable before the index loads: the stored id minus its hash suffix.
  const targetLabel = autoTarget
    ? 'Progetto auto'
    : noneTarget
      ? 'Nessun progetto'
      : targetRef?.name ?? (targetProject ? targetProject.replace(/-[^-]+$/, '') : '');

  const pickProject = (p: BoardProjectRef) => {
    setTargetProject(p.projectId);
    try { localStorage.setItem('board:composerProject', p.projectId); } catch { /* private mode */ }
    setProjOpen(false);
  };
  const pickSentinel = (id: string) => {
    setTargetProject(id);
    try { localStorage.setItem('board:composerProject', id); } catch { /* private mode */ }
    setProjOpen(false);
  };
  const doCreateProject = async (name: string) => {
    if (!name || projBusy) return;
    setProjBusy(true);
    try {
      const created = await boardApi.createProject(name);
      setProjects((prev) => (prev ? [...prev, created].sort((a, b) => a.name.localeCompare(b.name)) : [created]));
      pickProject(created);
    } catch (e) { onError(e instanceof Error ? e.message : 'create project failed'); }
    finally { setProjBusy(false); }
  };

  const submit = async () => {
    const raw = text.trim();
    if (!raw || submitting) return;
    if (!target) { onError('Scegli il progetto del task.'); setProjOpen(true); loadProjects(); return; }
    const lines = raw.split('\n');
    const firstLine = lines[0].trim();
    const title = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
    // Description = the text AFTER the first line — the drawer must not show
    // the title glued again right under itself. A truncated first line keeps
    // the full text so nothing is lost.
    const rest = lines.slice(1).join('\n').trim();
    const description = firstLine.length > 80 ? raw : rest || null;
    setSubmitting(true);
    try {
      await boardApi.create(target, { text: title, description, status: 'todo', planFirst, model: model ?? undefined, priority: prio ?? undefined });
      setText('');
      setPlanFirst(false);
      setModel(null);
      setPrio(null);
      boardDrafts.clearComposer();
      if (taRef.current) taRef.current.style.height = 'auto';
      onCreated();
    } catch (e) { onError(e instanceof Error ? e.message : 'create failed'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div
        ref={wrapRef}
        onFocusCapture={onFocus}
        onBlurCapture={onBlurCapture}
        onPointerDownCapture={onPointerDownCapture}
        data-testid="board-task-composer"
        className={`input-glass pointer-events-auto w-full max-w-2xl rounded-2xl border shadow-2xl shadow-black/50 transition-all duration-200 ease-out ${
          expanded ? '-translate-y-2 border-white/20' : 'translate-y-0 border-white/10'
        }`}
      >
        <textarea
          value={text} rows={1}
          ref={(el) => { taRef.current = el; autoGrow(el); }}
          onChange={(e) => { setText(e.target.value); autoGrow(e.currentTarget); saveCursor(); }}
          onSelect={saveCursor}
          onKeyUp={saveCursor}
          onClick={saveCursor}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Descrivi un task per l'agent…"
          className={`block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3.5 py-3 text-sm leading-5 text-neutral-100 outline-none transition-[min-height] duration-200 ease-out placeholder:text-neutral-500 ${
            expanded ? 'min-h-[4.5rem]' : 'min-h-0'
          }`}
        />
        <div className={`flex items-center gap-2 overflow-hidden px-2.5 transition-all duration-200 ease-out ${expanded ? 'max-h-12 pb-2 opacity-100' : 'max-h-0 pb-0 opacity-0'}`}>
          {global && (
            <>
              <button
                ref={projBtnRef}
                onClick={() => { setProjOpen(true); loadProjects(); }}
                data-testid="composer-project-chip"
                title={autoTarget
                  ? 'Progetto automatico: risolto dal testo del task (nome citato); se non è chiaro va nel progetto generale'
                  : targetLabel ? `Progetto: ${targetLabel}` : 'Scegli il progetto del task'}
                className="flex min-w-0 max-w-[13rem] items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-neutral-200 hover:bg-white/10"
              >
                {autoTarget
                  ? <Sparkles className="h-3 w-3 shrink-0 text-neutral-500" />
                  : <ProjectFavicon path={targetRef?.path ?? ''} size={13} fallback={<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${targetProject && !noneTarget ? 'bg-emerald-400' : 'bg-neutral-600'}`} />} />}
                <span className="truncate">{targetLabel || 'Progetto…'}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
              </button>
              <Menu
                open={projOpen}
                anchorRef={projBtnRef}
                onClose={() => setProjOpen(false)}
                minWidth={230}
                role="listbox"
                unmanagedFocus
              >
                <ProjectPickerBody
                  projects={projects}
                  selectedId={targetProject}
                  onPick={pickProject}
                  onCreate={doCreateProject}
                  busy={projBusy}
                  listLabel="Progetto del task"
                  onPickAuto={() => pickSentinel(AUTO_PROJECT_ID)}
                  autoSelected={autoTarget}
                />
              </Menu>
            </>
          )}
          <button
            ref={modelBtnRef}
            onClick={() => { setModelOpen(true); loadModels(); }}
            data-testid="composer-model-chip"
            title={model ? `Modello: ${friendlyModelLabel(model)}` : 'Modello: intelligenza automatica (sceglie il provider)'}
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[11px] text-neutral-300 hover:bg-white/10"
          ><Sparkles className="h-3 w-3 text-neutral-500" /> {model ? friendlyModelLabel(model) : 'Modello auto'} <ChevronDown className="h-3 w-3 text-neutral-500" /></button>
          <Menu open={modelOpen} anchorRef={modelBtnRef} onClose={() => setModelOpen(false)} minWidth={170} role="listbox">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Modello</p>
            <button
              role="option" aria-selected={model === null}
              onClick={() => { setModel(null); setModelOpen(false); }}
              title="Lascia scegliere il provider"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
            >
              <span className="min-w-0 flex-1">Intelligenza automatica</span>
              {model === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
            {claudeModels.map((m) => (
              <button
                key={m} role="option" aria-selected={model === m}
                onClick={() => { setModel(m); setModelOpen(false); }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
              >
                <span className="min-w-0 flex-1 truncate">{friendlyModelLabel(m)}</span>
                {model === m && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
            ))}
          </Menu>
          <button
            ref={prioBtnRef}
            onClick={() => setPrioOpen(true)}
            data-testid="composer-priority-chip"
            title={prio !== null ? `Priorità: ${PRIORITY_LABEL[prio]}` : "Priorità automatica: la valuta l'agent appena inquadra il task"}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-[11px] text-neutral-300 hover:bg-white/10"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${prio !== null ? PRIORITY_DOT[prio] : 'border border-neutral-500'}`} />
            {prio !== null ? PRIORITY_LABEL[prio] : 'Priorità auto'} <ChevronDown className="h-3 w-3 text-neutral-500" />
          </button>
          <Menu open={prioOpen} anchorRef={prioBtnRef} onClose={() => setPrioOpen(false)} minWidth={170} role="listbox">
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Priorità</p>
            <button
              role="option" aria-selected={prio === null}
              onClick={() => { setPrio(null); setPrioOpen(false); }}
              title="La valuta l'agent al primo turno; la coda serve prima le priorità alte"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-neutral-500" />
              <span className="min-w-0 flex-1">Automatica</span>
              {prio === null && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
            {PRIORITY_ORDER.map((p) => (
              <button
                key={p} role="option" aria-selected={prio === p}
                onClick={() => { setPrio(p); setPrioOpen(false); }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
                <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
                {prio === p && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
            ))}
          </Menu>
          <button
            onClick={() => setPlanFirst((v) => !v)}
            title="L'agent consegna prima un piano da approvare, implementa dopo il tuo ok"
            className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              planFirst ? 'bg-violet-500/25 text-violet-200' : 'bg-white/5 text-neutral-400 hover:bg-white/10'
            }`}
          ><ClipboardList className="h-3 w-3" /> Plan first</button>
          <button
            onClick={submit} disabled={!text.trim() || submitting}
            title="Crea il task (l'agent parte da Todo)"
            className="ml-auto shrink-0 rounded-lg bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-40"
          >{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
        </div>
      </div>
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────
function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, onError, onRefetch, onOpenTopic, tasksById, projectPathById, liveById }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: (id: string) => void; onCreate: (text: string) => void;
  canCreate: boolean; showProject: boolean; onError: (e: string) => void; onRefetch: () => void;
  onOpenTopic?: (topicId: string) => void; tasksById: Map<string, BoardTask>; projectPathById: Map<string, string>;
  /** Live per-turn usage keyed by task id (ticking chip on working cards). */
  liveById: Map<string, LiveUsage>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };

  return (
    <div ref={setNodeRef} data-testid={`kanban-column-${status}`} className={`flex shrink-0 flex-col rounded-lg border ${status === 'review' ? 'min-w-80 max-h-screen sticky right-0 z-20 lg:static lg:w-[32rem] lg:max-h-none' : 'min-w-72'} ${isOver ? 'border-emerald-400/60 bg-emerald-400/5' : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-300">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-neutral-400">{tasks.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <Card
              key={t.id} task={t} onOpen={onOpen} showProject={showProject} onError={onError} onRefetch={onRefetch} onOpenTopic={onOpenTopic}
              parentTitle={t.parentTaskId ? tasksById.get(t.parentTaskId)?.text : undefined}
              blocker={t.blockedByTaskId ? tasksById.get(t.blockedByTaskId) : undefined}
              projectPath={projectPathById.get(t.projectId)}
              live={liveById.get(t.id)}
            />
          ))}
        </SortableContext>
        {!canCreate ? null : adding ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-2">
            <textarea
              autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setText(''); setAdding(false); } }}
              className="w-full resize-none bg-transparent text-sm text-neutral-100 outline-none" rows={2} placeholder="Task…"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button onClick={() => { setText(''); setAdding(false); }} className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-white/10">Annulla</button>
              <button onClick={submit} className="rounded bg-emerald-500/80 px-2 py-0.5 text-xs text-white hover:bg-emerald-500">Aggiungi</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:bg-white/5">
            <Plus className="h-3.5 w-3.5" /> Aggiungi
          </button>
        )}
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────
function Card({ task, onOpen, showProject, onError, onRefetch, onOpenTopic, parentTitle, blocker, projectPath, live }: {
  task: BoardTask; onOpen: (id: string) => void; showProject: boolean;
  onError: (e: string) => void; onRefetch: () => void; onOpenTopic?: (topicId: string) => void;
  /** Text of the parent task when this card is a subtask (context chip). */
  parentTitle?: string;
  /** The task this one is gated on, when still unresolved (blocked-by chip). */
  blocker?: BoardTask;
  /** Real filesystem path of task.projectId, for the favicon (cross-project board only). */
  projectPath?: string;
  /** Live per-turn usage while this task's agent works (ticking chip). */
  live?: LiveUsage;
}) {
  // Sortable: the source card is dimmed (the DragOverlay carries the visual)
  // but its NEIGHBOURS get the reflow transform — the list opens a gap under
  // the pointer, so dropping "between two cards" reads as such. The ACTIVE
  // card must NOT get its transform (that one follows the pointer): applied,
  // the dim source card flew across the board alongside the overlay and the
  // drop targeting went with it.
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({ id: task.id });

  // "Serve te" context: for an agent-driven task in review, lazily load the
  // thread and surface the LAST comment on the card — as a quick-reply with
  // option buttons when it's a question block, as plain text otherwise. The
  // human must never be asked Approva/Rifiuta blind: the agent's last word is
  // always on the card (the thread stays in the drawer).
  const [lastComment, setLastComment] = useState<TaskComment | null>(null);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  // Right-click menu (archive/select live here now — NOT as a trash icon that
  // crowds the card header). Cursor-positioned, portaled, viewport-clamped.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  useEffect(() => {
    if (!isAgentReview) { setLastComment(null); return; }
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ comments }) => {
        if (!alive) return;
        // Status events are history rows, not the agent's word — skip them.
        const speech = comments.filter((c) => c.kind !== 'status');
        setLastComment(speech[speech.length - 1] ?? null);
      })
      .catch(() => { if (alive) setLastComment(null); });
    return () => { alive = false; };
    // Re-check when the task changes (a re-kick bumps updatedAt).
  }, [isAgentReview, task.projectId, task.id, task.updatedAt]);
  const pending = lastComment ? parseQuestionBlock(lastComment.content) : null;

  // Route mutations by the task's own projectId (works in the global board too).
  const review = async (decision: 'approve' | 'reject', comment?: string) => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.review(task.projectId, task.id, decision, comment); setLastComment(null); setFreeText(''); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'review failed'); }
    finally { setBusy(false); }
  };
  // Answering a question re-kicks the same agent tab (server routes reject →
  // dispatcher.resume), so the answer is a reject carrying the human's choice.
  const answer = (text: string) => review('reject', text);
  const archive = async () => {
    try { await boardApi.archive(task.projectId, task.id); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'archive failed'); }
  };
  // Human-readable project label = the dirName prefix before the id hash.
  // Project-less = truly unassigned OR the catch-all board (which runs the task
  // standalone). Both render with NO chip — the "generale" label is noise.
  const unassigned = isProjectlessId(task.projectId);
  const projectLabel = task.projectId.replace(/-[^-]+$/, '');

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      data-task-card={task.id}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
      className={`group cursor-grab rounded-md border border-white/10 bg-neutral-800/60 p-2.5 text-sm text-neutral-100 shadow-sm hover:border-white/20 ${isDragging ? 'opacity-40' : ''}`}
    >
      {/* Project eyebrow: favicon + plain project name ABOVE the title (no chip),
          so a cross-project card reads "which project" first, then the title —
          the name isn't competing as a pill down in the meta row. */}
      {showProject && !unassigned && (
        <div className="mb-1 flex items-center gap-1 text-[11px] text-neutral-400">
          {projectPath && <ProjectFavicon path={projectPath} size={12} className="shrink-0" />}
          <span className="min-w-0 truncate font-medium">{projectLabel}</span>
        </div>
      )}
      {/* Header: title left, PRIMARY STATE pinned top-right — same slot on every
          card, so the eye finds "dov'è il task" without scanning the chip row.
          No delete icon here: archive/select live in the right-click menu. */}
      <div className="flex items-start gap-2">
        {/* min-w-0 lets the flex item shrink below its content's intrinsic
            width; break-words then wraps long unbreakable tokens (URL, path,
            hash, branch) instead of spilling the card past the column edge. */}
        <span className="min-w-0 flex-1 break-words leading-snug">{task.text}</span>
        {(task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
          <DispatchChip state={task.dispatchState} error={task.dispatchError} />
        ) : (!task.dispatchState && task.dispatchError) ? (
          <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300" title={task.dispatchError}>fermato</span>
        ) : null}
      </div>
      {/* Meta: every informational chip stays VISIBLE, zoned below the title in a
          tidy row (attributi del task). State + archive live top-right, above. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {!task.priorityAuto && task.priority !== 2 && (
          <span
            title={`Priorità: ${PRIORITY_LABEL[task.priority] ?? task.priority}`}
            className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] ${
              task.priority >= 3 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-neutral-400'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
            {PRIORITY_LABEL[task.priority] ?? task.priority}
          </span>
        )}
        {/* Modello effettivo: 'auto' è solo lo stato iniziale — appena il
            dispatcher risolve un modello concreto lo mostriamo qui, così si
            vede con cosa ha girato l'agent (non più un generico "auto"). */}
        {task.model && (
          <span
            title={`Modello: ${fmtModel(task.model)}`}
            className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400"
          >
            <Sparkles className="h-3 w-3 text-neutral-500" />
            {fmtModel(task.model)}
          </span>
        )}
        {/* (Project identity moved to the eyebrow above the title — no chip here.) */}
        {blocker && blocker.status !== 'done' && (
          <span
            title={`In attesa di: ${blocker.text}`}
            className="flex max-w-[11rem] items-center gap-1 truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300"
          ><Lock className="h-3 w-3 shrink-0" /> <span className="truncate">in attesa di: {blocker.text}</span></span>
        )}
        {task.parentTaskId && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(task.parentTaskId!); }}
            title={parentTitle ? `Sottotask di: ${parentTitle}` : 'Apri il task padre'}
            className="max-w-[9rem] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
          >⤴ {parentTitle ?? 'padre'}</button>
        )}
        {task.subtaskCount > 0 && (
          <span
            title={`${task.subtaskDoneCount}/${task.subtaskCount} sottotask completati`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300"
          >↳ {task.subtaskDoneCount}/{task.subtaskCount}</span>
        )}
        {task.planFirst && (
          <span
            title="L'agent consegna prima un piano da approvare"
            className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300"
          >piano</span>
        )}
        {live && task.dispatchState === 'working' ? (
          <LiveEffortChip usage={live} />
        ) : (task.agentMs > 0 || task.agentTokens > 0) ? (
          <span
            title={`Effort dell'agent: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''}${task.model ? ` · modello ${fmtModel(task.model)}` : ''}`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400"
          >⏱ {fmtMs(task.agentMs)}{task.agentTokens > 0 && ` · ${fmtTok(task.agentTokens)} tok`}</span>
        ) : null}
        {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300">@{task.assignedTo}</span>}
        {task.assignedTopicId && onOpenTopic && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTopic(task.assignedTopicId!); }}
            className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-white/20"
            title="Apri la tab dell'agent"
          ><ArrowUpRight className="h-3 w-3" /> apri tab</button>
        )}
      </div>
      {task.status === 'review' && isAgentReview && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {pending ? (
            <p className="break-words text-xs leading-snug text-neutral-200">{stripMarkdown(pending.question)}</p>
          ) : lastComment ? (
            // Render the agent's last word as REAL markdown (bold/headings/lists
            // format instead of showing raw `**`/`#`). Shown in full — no clamp,
            // no fade. Tooltip = plain text.
            <div
              className={`text-xs leading-relaxed text-neutral-300 ${COMPACT_MD_CLS}`}
              title={`${lastComment.author}: ${stripMarkdown(lastComment.content)}`}
            >
              <ChatMarkdown components={{}}>{lastComment.content}</ChatMarkdown>
            </div>
          ) : null}
          {pending && pending.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pending.options.map((opt, i) => (
                <button
                  key={i} disabled={busy}
                  onClick={() => answer(opt)}
                  className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-100 hover:bg-white/20 disabled:opacity-50"
                >{opt}</button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1">
            <input
              value={freeText} disabled={busy}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); answer(freeText.trim()); } }}
              placeholder="Rispondi…"
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => answer(freeText.trim())}
              title="Rispondi (l'agent riparte con la tua risposta)"
              className="flex items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('approve')}
              title="Accetta e completa il task"
              className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            ><ShieldCheck className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('reject')}
              title="Rifiuta (l'agent riparte senza indicazioni)"
              className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50"
            ><ShieldX className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      )}
      {task.status === 'review' && !isAgentReview && (
        <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button disabled={busy} onClick={() => review('approve')} className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">
            <ShieldCheck className="h-3.5 w-3.5" /> Approva
          </button>
          <button disabled={busy} onClick={() => review('reject')} className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50">
            <ShieldX className="h-3.5 w-3.5" /> Rifiuta
          </button>
        </div>
      )}
      {ctxMenu && (
        <ContextMenuPortal open x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpen(task.id); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
          ><ClipboardList className="h-3.5 w-3.5 text-neutral-400" /> Apri</button>
          {task.assignedTopicId && onOpenTopic && (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpenTopic(task.assignedTopicId!); }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
            ><ArrowUpRight className="h-3.5 w-3.5 text-neutral-400" /> Apri tab agent</button>
          )}
          <div className="my-1 border-t border-white/10" />
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); archive(); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-rose-300 hover:bg-rose-500/10"
          ><Trash2 className="h-3.5 w-3.5" /> Archivia</button>
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ── Detail: drawer by default, expandable review surface ────────────────────

/**
 * One tab of a task's surface tab group. The Thread is the always-present body;
 * these are the auxiliary surfaces the side panel / inline tab bar switch to.
 */
type TaskSurface =
  | { id: string; kind: 'output'; label: string; url: string }
  | { id: string; kind: 'plan'; label: string; content: string }
  | { id: string; kind: 'media'; label: string; url: string; path: string };

/** Min drawer width (px) before the surface tab group earns its own side panel;
 *  below it the surfaces fold inline into the body. */
const SIDEPANEL_MIN = 680;

function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
  /**
   * Change signal (the task's updatedAt from the board's live list): any WS
   * task:updated — a step flipping, a new comment — re-fetches the open detail,
   * so the drawer follows the agent in real time instead of freezing at mount.
   */
  bump?: string;
  /** Navigate the drawer to another task (subtask ↔ parent). */
  onOpenTask?: (taskId: string) => void;
  /** Deep-link the agent's chat tab (output panel fallback). */
  onOpenTopic?: (topicId: string) => void;
}) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  // The task's surfaces (plan / output / media attachments) are ONE tab group of
  // the task: `activeSurfaceId` is the selected surface tab. `null` ⟺ the Thread
  // (the always-present primary body). This single selection drives both the
  // inline tab bar (narrow pane) and the side panel (wide pane), replacing the
  // old bodyTab + previewOff + previewPath tangle. Sticky across the drawer's
  // life; a surface that disappears (output cleared) falls back to the Thread.
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const [children, setChildren] = useState<BoardTask[]>([]);
  const [draft, setDraft] = useState('');
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const commentCursorKey = `board:task:${taskId}`;
  const saveCommentCursor = () => { const ta = commentRef.current; if (ta) writeCursor(commentCursorKey, ta.selectionStart, ta.selectionEnd); };
  // Per-task server draft (bounded map in ui-state): restore once per task,
  // save debounced while typing, cleared on successful send.
  const taskDraftLoaded = useRef(false);
  useEffect(() => {
    taskDraftLoaded.current = false;
    let alive = true;
    boardDrafts.getTaskDraft(taskId).then((t) => {
      if (alive) {
        setDraft((cur) => cur || t);
        taskDraftLoaded.current = true;
        // Restore caret after the draft text commits (hot-reload continuity).
        requestAnimationFrame(() => restoreCursor(`board:task:${taskId}`, commentRef.current));
      }
    }).catch(() => { taskDraftLoaded.current = true; });
    return () => { alive = false; };
  }, [taskId]);
  useEffect(() => {
    if (taskDraftLoaded.current) boardDrafts.putTaskDraft(taskId, draft);
  }, [draft, taskId]);
  const [subDraft, setSubDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  // Inline title/description editing (works for subtasks too — the drawer IS
  // the edit surface at every depth). Esc cancels via the ref so the blur-save
  // that follows becomes a no-op.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const editCancelled = useRef(false);
  // Action errors surfaced HERE, in the detail — the board's error bar sits
  // behind the drawer. The 409 open_subtasks on Approva is the load-bearing
  // case: swallowing it made the click look dead.
  const [error, setError] = useState<string | null>(null);
  const showError = (e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e);
    setError(/open subtasks/i.test(raw)
      ? 'Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.'
      : raw);
  };
  // Narrow (default) keeps the board visible behind the drawer; wide grows the
  // drawer so the task's tab group can live in a side panel (Thread on the left,
  // the selected surface on the right) instead of folding inline into the body.
  // Sticky per client.
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('board:taskDetailWide') === '1'; } catch { return false; } });
  const toggleWide = () => setWide((w) => {
    const next = !w;
    try { localStorage.setItem('board:taskDetailWide', next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });
  // Actual rendered width of the drawer — the side panel only makes sense past a
  // threshold. Measured (not derived from `wide`) so the fold is truly dynamic:
  // even an expanded drawer on a small screen stays inline. This is the "…in
  // anteprima se la vista troppo stretta" rule.
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setContainerW(entries[0]!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { task, comments, children } = await boardApi.get(projectId, taskId);
      setTask(task); setComments(comments); setChildren(children ?? []);
    } catch { /* closed or gone */ }
  }, [projectId, taskId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { load(); }, [load, bump]);
  // Wake-up refresh (same rationale as the board's): an open drawer coming back
  // from sleep would keep yesterday's chip/ticker until some WS event lands.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [comments.length]);

  // A human comment on an agent-delivered review IS the answer — same
  // semantics as the card's quick-reply: reject carries the text and resumes
  // the SAME agent tab (server: reviewDecision → comment + in_progress +
  // dispatcher.resume). A plain comment here would sit unread while the chip
  // says "serve te". Non-agent tasks (or any other status) keep plain comments.
  // Distinct media attachments across the whole thread, newest-first, deduped by
  // path — each is one "Anteprima" tab of the task (a delivered PDF/screenshot
  // IS review output even when the agent didn't set output_url).
  const mediaPaths = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (let i = comments.length - 1; i >= 0; i--) {
      for (const m of comments[i].media ?? []) {
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
    }
    return out;
  }, [comments]);
  const isAgentReview = !!task && task.status === 'review' && !!task.assignedTopicId;
  // Pending question = the agent's last word is a question block: its options
  // render as quick-reply buttons right above the composer (same zone as the
  // review actions), mirroring the card.
  // kind='status' rows are transition history, never "the agent's last word".
  const speech = comments.filter((c) => c.kind !== 'status');
  const lastThreadComment = speech[speech.length - 1] ?? null;
  const pending = isAgentReview && lastThreadComment ? parseQuestionBlock(lastThreadComment.content) : null;
  // The plan lives in the agent's last real comment; the "Piano" tab surfaces it.
  // Shown only for plan-first tasks (where a plan is the expected deliverable).
  const planComment = task?.planFirst
    ? ([...speech].reverse().find((c) => c.author !== 'user' && c.author !== 'system') ?? null)
    : null;

  // The task's auxiliary surfaces as ONE ordered tab group: the review target
  // (output_url) first, then the plan-first plan, then each media attachment.
  // The Thread is not in this list — it's the always-present primary body; these
  // are what the side panel (wide) / inline tab bar (narrow) switch between.
  const surfaces = useMemo<TaskSurface[]>(() => {
    const list: TaskSurface[] = [];
    if (task?.outputUrl) list.push({ id: 'output', kind: 'output', label: 'Output', url: task.outputUrl });
    if (planComment) list.push({ id: 'piano', kind: 'plan', label: 'Piano', content: planComment.content });
    for (const p of mediaPaths) list.push({ id: `media:${p}`, kind: 'media', label: p.split('/').pop() || 'Allegato', url: getMediaUrl(p), path: p });
    return list;
  }, [task?.outputUrl, planComment, mediaPaths]);
  const hasSurfaces = surfaces.length > 0;
  // Wide enough to host the side panel? Measured, so an expanded-but-cramped
  // drawer still folds inline. Below the threshold the surfaces live in the body.
  const sidepanel = wide && hasSurfaces && containerW >= SIDEPANEL_MIN;
  const inlineTabs = !sidepanel && hasSurfaces;
  // The selected surface (undefined ⟺ Thread). A stale id (surface vanished)
  // resolves to null → Thread, so the body never blanks.
  const activeSurface = surfaces.find((s) => s.id === activeSurfaceId) ?? null;
  // Side panel always shows something (default = first surface); inline defaults
  // to the Thread until the user picks a surface tab.
  const sideSurface = activeSurface ?? surfaces[0] ?? null;
  // Select a surface tab; if the pane is wide enough to host the side panel but
  // it's collapsed, open it so the surface shows BESIDE the thread rather than
  // replacing it. Clicking a thread attachment routes through here.
  const selectSurface = (id: string) => {
    setActiveSurfaceId(id);
    if (!wide && containerW >= SIDEPANEL_MIN) toggleWide();
  };

  const deliverAnswer = async (v: string, media?: string[]): Promise<boolean> => {
    try {
      if (media && media.length > 0) {
        // Attachments ride the comments endpoint (media isn't a review-decision
        // field); when the task is in agent review the server auto-resumes the
        // agent with the text AND the file paths (boundRootOf path).
        await boardApi.comment(projectId, taskId, v || '(allegato)', { media });
      } else if (isAgentReview) {
        // Race fallback: if the task left review meanwhile, still save the text
        // as a plain comment instead of losing it.
        try { await boardApi.review(projectId, taskId, 'reject', v); }
        catch { await boardApi.comment(projectId, taskId, v); }
      } else {
        await boardApi.comment(projectId, taskId, v);
      }
      setError(null);
      await load(); onChanged();
      return true;
    } catch (e) { showError(e); return false; }
  };
  const send = async () => {
    const v = draft.trim(); if ((!v && attachments.length === 0) || sending) return;
    setSending(true);
    const ok = await deliverAnswer(v, attachments.map((a) => a.path));
    if (ok) { setDraft(''); setAttachments([]); } // cleared on success only
    setSending(false);
  };

  // Attachments: same pipeline as the native chat — POST /api/upload (multipart)
  // → absolute path, rendered via /api/media. Staged here until send.
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string; isImage: boolean }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 8 - attachments.length)) {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        const d = await r.json().catch(() => null) as { path?: string; error?: string } | null;
        if (!r.ok || !d?.path) throw new Error(d?.error || 'upload fallito');
        setAttachments((prev) => [...prev, { path: d.path!, name: file.name, isImage: file.type.startsWith('image/') }]);
      }
      setError(null);
    } catch (e) { showError(e); }
    finally { setUploading(false); }
  };
  const answerOption = async (opt: string) => {
    if (sending) return;
    setSending(true);
    await deliverAnswer(opt);
    setSending(false);
  };

  // Approve/reject from the detail itself — the review surface must not force a
  // round-trip back to the card. Same endpoint, same semantics.
  const decide = async (decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.review(projectId, taskId, decision); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Quick-add a nested subtask. Born in backlog (intake), like agent creates —
  // dragging it to Todo is the explicit "vai" gesture.
  const addSubtask = async () => {
    const v = subDraft.trim(); if (!v || addingSub) return;
    setAddingSub(true);
    try {
      await boardApi.create(projectId, { text: v, status: 'backlog', parentTaskId: taskId });
      setSubDraft('');
      setError(null);
      await load(); onChanged();
    } catch (e) { showError(e); }
    finally { setAddingSub(false); }
  };

  const saveTitle = async () => {
    setEditingTitle(false);
    if (editCancelled.current) { editCancelled.current = false; return; }
    const v = titleDraft.trim();
    if (!task || !v || v === task.text) return;
    try { await boardApi.update(projectId, taskId, { text: v }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
  };
  const saveDesc = async () => {
    setEditingDesc(false);
    if (editCancelled.current) { editCancelled.current = false; return; }
    if (!task) return;
    const v = descDraft.trim();
    if (v === (task.description ?? '')) return;
    try { await boardApi.update(projectId, taskId, { description: v || null }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
  };
  const cancelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { editCancelled.current = true; (e.target as HTMLElement).blur(); }
  };

  // Status selector (header chip): the drawer can move the task directly —
  // same PATCH the column drag uses, same server guards (open_subtasks…).
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const changeStatus = async (s: TaskStatus) => {
    setStatusMenuOpen(false);
    if (!task || s === task.status || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { status: s }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Priority selector (header chip) — same PATCH path, dispatcher queue order.
  const prioBtnRef = useRef<HTMLButtonElement>(null);
  const [prioMenuOpen, setPrioMenuOpen] = useState(false);
  const changePriority = async (p: number) => {
    setPrioMenuOpen(false);
    if (!task || p === task.priority || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { priority: p }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Model selector (header chip): change the model the agent runs on. null =
  // "auto" (the opus-first classifier picks per task); an explicit id pins it.
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [models, setModels] = useState<string[]>(
    () => getProvidersSnapshotState().snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? [],
  );
  useEffect(() => subscribeProvidersSnapshot((state) => {
    setModels(state.snapshot?.providers.find((p) => p.name === 'claude-code')?.models ?? []);
  }), []);
  const changeModel = async (model: string | null) => {
    setModelMenuOpen(false);
    if (!task || (task.model ?? null) === model || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { model }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Project selector (header chip): move the task to another board, open the
  // current project's window, or scaffold a new workspace project. The list is
  // the server-resolvable board index — fetched lazily on first open.
  const projChipRef = useRef<HTMLButtonElement>(null);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [projects, setProjects] = useState<BoardProjectRef[] | null>(null);
  const [projBusy, setProjBusy] = useState(false);

  // Eager, not lazy: the chip needs the real path for its favicon (and an
  // accurate label) the moment the drawer opens, not only after the user
  // clicks "Sposta su…" once.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { boardApi.projects().then(setProjects).catch(() => setProjects([])); }, []);
  const openProjMenu = () => setProjMenuOpen(true);
  const currentProject = projects?.find((p) => p.projectId === task?.projectId) ?? null;
  const projectLabel = task && isProjectlessId(task.projectId)
    ? 'Nessun progetto'
    : currentProject?.name ?? (task ? task.projectId.replace(/-[^-]+$/, '') : '');
  const moveBlocked = !task ? null
    : task.parentTaskId ? 'I sottotask si spostano col loro task padre.'
    : task.assignedTopicId || ['queued', 'starting', 'working'].includes(task.dispatchState ?? '')
      ? "C'è un agent attivo sul task: chiudi prima il giro."
      : null;

  const doMove = async (p: BoardProjectRef) => {
    if (projBusy || !task) return;
    setProjBusy(true);
    try {
      await boardApi.move(task.projectId, taskId, p.projectId);
      setError(null); setProjMenuOpen(false); onChanged();
    } catch (e) { showError(e); }
    finally { setProjBusy(false); }
  };
  const doOpenProject = () => {
    if (!currentProject) return;
    window.dispatchEvent(new CustomEvent('topics:open-project', { detail: { projectPath: currentProject.path } }));
    setProjMenuOpen(false);
  };
  const doCreateProject = async (name: string) => {
    if (!name || projBusy || !task) return;
    setProjBusy(true);
    try {
      const created = await boardApi.createProject(name);
      setProjects((prev) => (prev ? [...prev, created].sort((a, b) => a.name.localeCompare(b.name)) : prev));
      await boardApi.move(task.projectId, taskId, created.projectId);
      setError(null); setProjMenuOpen(false);
      onChanged();
    } catch (e) { showError(e); }
    finally { setProjBusy(false); }
  };

  // Blocked-by selector: gate this task on another ROOT task of the same
  // board. The dispatcher won't start it until the blocker is done (server
  // validates cycles — a 400 surfaces through the same showError as everything
  // else here).
  const blockerBtnRef = useRef<HTMLButtonElement>(null);
  const [blockerMenuOpen, setBlockerMenuOpen] = useState(false);
  const [boardTasks, setBoardTasks] = useState<BoardTask[] | null>(null);
  const openBlockerMenu = () => {
    setBlockerMenuOpen(true);
    if (boardTasks === null && task) boardApi.list(task.projectId).then(setBoardTasks).catch(() => setBoardTasks([]));
  };
  const blockerCandidates = useMemo(
    () => (boardTasks ?? []).filter((t) => !t.parentTaskId && t.id !== taskId),
    [boardTasks, taskId],
  );
  const blockerTask = task?.blockedByTaskId
    ? (boardTasks?.find((t) => t.id === task.blockedByTaskId) ?? null)
    : null;

  // Esc closes the drawer — UNLESS Esc belongs to something inside it: an
  // inline title/desc edit (Esc cancels the edit) or an open menu (Esc closes
  // the menu). Menus use useDismissable (capture + stopPropagation on document)
  // so they already swallow Esc before it reaches this window-level listener;
  // the state guard also covers the edit textareas, whose onKeyDown neither
  // stops nor prevents the event. Refs keep the listener registered once while
  // reading the latest guard/close on each keystroke.
  const escGuardRef = useRef<() => boolean>(() => false);
  escGuardRef.current = () =>
    editingTitle || editingDesc || statusMenuOpen || prioMenuOpen || projMenuOpen || blockerMenuOpen || modelMenuOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (escGuardRef.current()) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // "Copia link" feedback: swap the icon to a check for a beat.
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    if (!task) return;
    try {
      await navigator.clipboard.writeText(buildTaskLink(task.projectId, task.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — nothing to surface */ }
  };

  const pickBlocker = async (id: string | null) => {
    if (!task || projBusy) return;
    setBlockerMenuOpen(false);
    if (id === task.blockedByTaskId) return;
    setProjBusy(true);
    try { await boardApi.update(task.projectId, taskId, { blockedByTaskId: id }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setProjBusy(false); }
  };
  const toggleReuseContext = async () => {
    if (!task || busy) return;
    setBusy(true);
    try { await boardApi.update(task.projectId, taskId, { reuseBlockerContext: !task.reuseBlockerContext }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };
  const togglePlanFirst = async () => {
    if (!task || busy) return;
    setBusy(true);
    try { await boardApi.update(task.projectId, taskId, { planFirst: !task.planFirst }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  const stopAgent = async () => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.stop(projectId, taskId); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // The agent's session (same thread the chat tab shows, read-only), sliced
  // BETWEEN the comments: each reply gets, right above it, the piece of
  // reasoning that produced it. Loaded whenever the task has an agent bound
  // (the slices need timestamps to place themselves); reloads on live bump.
  const [sessionMsgs, setSessionMsgs] = useState<SessionMsg[] | null>(null);
  const sessionKey = task?.assignedTopicId ? `topic:${task.assignedTopicId.slice(0, 8)}` : null;
  const loadSession = useCallback(async () => {
    if (!sessionKey) return;
    try {
      const r = await fetch(`/api/history/${encodeURIComponent(sessionKey)}?limit=200`);
      const d = await r.json().catch(() => null) as { messages?: Array<{ role?: string; content?: string; timestamp?: string; thinking?: string }> } | null;
      const msgs = (Array.isArray(d?.messages) ? d.messages : [])
        // Keep thinking-only partials too: mid-stream the newest message may
        // have reasoning but no prose yet — that IS the live preview.
        .filter((m) => (typeof m?.content === 'string' && m.content.trim()) || (typeof m?.thinking === 'string' && m.thinking.trim()))
        .map((m) => ({ role: m.role ?? 'assistant', content: m.content ?? '', timestamp: m.timestamp ?? '', thinking: m.thinking }));
      setSessionMsgs(msgs);
    } catch { setSessionMsgs([]); }
  }, [sessionKey]);
  useEffect(() => { if (sessionKey) void loadSession(); }, [sessionKey, loadSession, bump]);

  // Live agent state (needed below): typing indicator + stream preview + stop.
  const agentBusy = !!task && ['queued', 'starting', 'working'].includes(task.dispatchState ?? '');

  // While a turn runs, poll the history (it overlays the LIVE stream content)
  // so the drawer shows what the agent is thinking/writing right now.
  useEffect(() => {
    if (!agentBusy || !sessionKey) return;
    const t = setInterval(() => { void loadSession(); }, 3000);
    return () => clearInterval(t);
  }, [agentBusy, sessionKey, loadSession]);

  // Tail of the newest agent message (reasoning first): the "come sta andando"
  // glance without opening anything.
  const streamPreview = useMemo(() => {
    if (!agentBusy || !sessionMsgs?.length) return null;
    const last = [...sessionMsgs].reverse().find((m) => m.role !== 'user');
    if (!last) return null;
    const text = (last.thinking?.trim() || last.content.trim()).replace(/\s+/g, ' ');
    return text ? text.slice(-280) : null;
  }, [agentBusy, sessionMsgs]);

  // Session messages that fall strictly between two thread boundaries (ISO
  // string compare — both sides are UTC toISOString). null = open-ended.
  const sliceBetween = useCallback((from: string | null, to: string | null): SessionMsg[] => {
    if (!sessionMsgs) return [];
    return sessionMsgs.filter((m) =>
      m.timestamp && (!from || m.timestamp > from) && (!to || m.timestamp <= to));
  }, [sessionMsgs]);

  const doneCount = children.filter((c) => c.status === 'done').length;

  return (
    <div
      ref={rootRef}
      data-testid="task-detail-drawer"
      // Always a layout SIBLING (relative, in-flow, shrink-0): the columns
      // viewport shrinks beside it and keeps its own horizontal scroll, so the
      // board is never cut behind the drawer — at any width. Wide is just a
      // bigger review surface (room for the output panel); the 72% cap keeps a
      // usable strip of board even on a small pane, and on a wide screen the
      // 64rem cap leaves most of the board visible. Was `absolute` takeover in
      // wide mode, which hid the board and blocked its scroll on large screens.
      className={`glass-surface relative flex shrink-0 flex-col border-l border-white/10 ${
        wide ? 'w-[min(64rem,72%)] shadow-2xl' : 'w-96 max-w-[75%]'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        {/* Chips live in a shrinkable strip; the expand/close buttons sit
            OUTSIDE it (shrink-0) so a narrow drawer/pane can never push them
            past the edge ("ho stretto la tab e non riesco a riaprirla"). */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <button
          ref={statusBtnRef}
          onClick={() => task && setStatusMenuOpen(true)}
          data-testid="task-status-chip"
          title="Cambia lo stato del task"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs uppercase tracking-wide text-neutral-400 hover:bg-white/10"
        >
          {task ? <StatusIcon status={task.status} /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {task ? STATUS_LABEL[task.status] : 'Carico…'}
          <ChevronDown className="h-3 w-3 text-neutral-600" />
        </button>
        <Menu open={statusMenuOpen} anchorRef={statusBtnRef} onClose={() => setStatusMenuOpen(false)} minWidth={170} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Sposta in…</p>
          {TASK_STATUSES.map((s) => (
            <button
              key={s} role="option" aria-selected={s === task?.status}
              disabled={busy}
              onClick={() => changeStatus(s)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            >
              <StatusIcon status={s} className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1">{STATUS_LABEL[s]}</span>
              {s === task?.status && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        <button
          ref={prioBtnRef}
          onClick={() => task && setPrioMenuOpen(true)}
          data-testid="task-priority-chip"
          title={task?.priorityAuto
            ? "Priorità automatica: la valuta l'agent appena inquadra il task"
            : 'Cambia la priorità del task (la coda serve prima le priorità alte)'}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:bg-white/10"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${task ? PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2] : 'bg-neutral-600'}`} />
          {task ? (task.priorityAuto ? 'Priorità auto' : PRIORITY_LABEL[task.priority] ?? 'Media') : '…'}
          <ChevronDown className="h-3 w-3 text-neutral-600" />
        </button>
        <Menu open={prioMenuOpen} anchorRef={prioBtnRef} onClose={() => setPrioMenuOpen(false)} minWidth={160} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Priorità</p>
          {PRIORITY_ORDER.map((p) => (
            <button
              key={p} role="option" aria-selected={p === task?.priority}
              disabled={busy}
              onClick={() => changePriority(p)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
              <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
              {p === task?.priority && !task?.priorityAuto && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        {task && (
          <button
            ref={projChipRef}
            onClick={openProjMenu}
            data-testid="task-project-chip"
            title={`Progetto: ${projectLabel} — sposta, apri o creane uno nuovo`}
            className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-neutral-200 hover:bg-white/10"
          >
            <ProjectFavicon path={currentProject?.path ?? ''} size={13} fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />} />
            <span className="truncate">{projectLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
          </button>
        )}
        <Menu
          open={projMenuOpen}
          anchorRef={projChipRef}
          onClose={() => setProjMenuOpen(false)}
          minWidth={230}
          unmanagedFocus
        >
          <ProjectPickerBody
            projects={projects}
            selectedId={task?.projectId}
            isDisabled={(p) => p.projectId === task?.projectId || !!moveBlocked}
            onPick={doMove}
            onCreate={doCreateProject}
            busy={projBusy}
            listLabel="Sposta su…"
            headerNote={moveBlocked ? <p className="px-2.5 pb-1 text-[10px] leading-snug text-amber-300/90">{moveBlocked}</p> : undefined}
          />
          <div className="my-1 border-t border-white/10" />
          <button
            role="menuitem" disabled={!currentProject}
            onClick={doOpenProject}
            title={currentProject ? `Apri la finestra di ${currentProject.name}` : 'Percorso del progetto non risolvibile'}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
          ><ArrowUpRight className="h-3.5 w-3.5" /> Apri progetto</button>
        </Menu>
        {task && (
          <button
            ref={modelBtnRef}
            onClick={() => setModelMenuOpen(true)}
            data-testid="task-model-chip"
            title="Cambia il modello dell'agent — Auto = il classificatore opus-first sceglie per task"
            className="flex min-w-0 shrink items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-neutral-200 hover:bg-white/10"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            <span className="truncate">{task.model ? friendlyModelLabel(task.model) : 'Auto'}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
          </button>
        )}
        <Menu open={modelMenuOpen} anchorRef={modelBtnRef} onClose={() => setModelMenuOpen(false)} minWidth={200} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Modello agent</p>
          <button
            role="option" aria-selected={!task?.model} disabled={busy}
            onClick={() => changeModel(null)}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">Auto <span className="text-neutral-500">(opus-first)</span></span>
            {!task?.model && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
          </button>
          {models.map((m) => (
            <button
              key={m} role="option" aria-selected={m === task?.model} disabled={busy}
              onClick={() => changeModel(m)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            >
              <span className="min-w-0 flex-1">{friendlyModelLabel(m)}</span>
              {m === task?.model && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        {/* Primary STATE pinned to the right of the selector strip (coherent with
            the card's top-right slot): dispatch chip + agent effort, next to the
            window actions. Selettori a sinistra, stato a destra. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {task?.dispatchState && DISPATCH_CHIP[task.dispatchState] && (
            <DispatchChip state={task.dispatchState} error={task.dispatchError} />
          )}
          {task && (task.agentMs > 0 || task.agentTokens > 0) && (
            <span
              className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-400"
              title={`Effort dell'agent su questo task: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''}`}
              data-testid="task-agent-effort"
            >⏱ {fmtMs(task.agentMs)}{task.agentTokens > 0 && ` · ${fmtTok(task.agentTokens)} tok`}</span>
          )}
        </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {task && (
            <button
              onClick={copyLink}
              data-testid="task-copy-link"
              title={copied ? 'Link copiato' : 'Copia il link al task (deep-link apribile, per debug/condivisione)'}
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            >{copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Link2 className="h-4 w-4" />}</button>
          )}
          {task?.assignedTopicId && onOpenTopic && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              data-testid="task-open-session-tab"
              title="Apri la tab dell'agent (chiuderla NON ferma la sessione)"
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            ><ArrowUpRight className="h-4 w-4" /></button>
          )}
          {task?.outputUrl && (
            <button
              onClick={() => openExternalOnce(task.outputUrl!)}
              title="Apri l'output nel browser"
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            ><ExternalLink className="h-4 w-4" /></button>
          )}
          {hasSurfaces && (
            <button
              onClick={toggleWide}
              title={wide ? 'Riduci a drawer (vedi la board)' : 'Espandi: mostra il pannello del task a lato'}
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            >{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          )}
          <button onClick={onClose} className="rounded p-1.5 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}
      {!task ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* Left column: meta + subtask tree + chat thread. With the side panel
            open it holds the drawer's left width; the task's surface panel takes
            the rest. */}
        <div className={`flex min-w-0 flex-col ${sidepanel ? 'w-96 shrink-0 border-r border-white/10' : 'flex-1'}`}>
          <div className="border-b border-white/10 px-3 py-3">
            {task?.parentTaskId && onOpenTask && (
              <button
                onClick={() => onOpenTask(task.parentTaskId!)}
                className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
              >⤴ Task padre</button>
            )}
            {task && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  ref={blockerBtnRef}
                  onClick={openBlockerMenu}
                  data-testid="task-blocked-chip"
                  title={blockerTask ? `Bloccato da: ${blockerTask.text}` : 'Fai partire questo task solo dopo un altro'}
                  className={`flex max-w-[14rem] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                    blockerTask && blockerTask.status !== 'done' ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                  }`}
                ><Lock className="h-3 w-3 shrink-0" /> <span className="truncate">{blockerTask ? `Bloccato da: ${blockerTask.text}` : 'Bloccato da…'}</span></button>
                <Menu open={blockerMenuOpen} anchorRef={blockerBtnRef} onClose={() => setBlockerMenuOpen(false)} minWidth={220} role="listbox" unmanagedFocus>
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Bloccato da…</p>
                  <button
                    role="option" aria-selected={!task.blockedByTaskId}
                    onClick={() => pickBlocker(null)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                  >
                    <span className="min-w-0 flex-1">Nessuno</span>
                    {!task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                  </button>
                  <div className="max-h-52 overflow-y-auto">
                    {boardTasks === null ? (
                      <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-neutral-500" /></div>
                    ) : blockerCandidates.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-neutral-500">Nessun altro task su questa board.</p>
                    ) : blockerCandidates.map((t) => (
                      <button
                        key={t.id} role="option" aria-selected={t.id === task.blockedByTaskId}
                        onClick={() => pickBlocker(t.id)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                      >
                        <span className="min-w-0 flex-1 truncate">{t.text}</span>
                        {t.id === task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                      </button>
                    ))}
                  </div>
                </Menu>
                {task.blockedByTaskId && (
                  <button
                    onClick={toggleReuseContext}
                    data-testid="task-reuse-context-toggle"
                    title="Quando parte, l'agent riceve il contesto della sessione del task bloccante invece di uno start a freddo"
                    aria-pressed={task.reuseBlockerContext}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                      task.reuseBlockerContext ? 'bg-sky-500/15 text-sky-300' : 'bg-white/5 text-neutral-500 hover:bg-white/10'
                    }`}
                  >Riusa il contesto dell'agent del task bloccante</button>
                )}
                <button
                  onClick={togglePlanFirst}
                  data-testid="task-plan-first-toggle"
                  title="L'agent consegna un piano da approvare PRIMA di implementare (utile per task fuzzy: prima un checkpoint, meno token sprecati)"
                  aria-pressed={task.planFirst}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                    task.planFirst ? 'bg-violet-500/25 text-violet-200' : 'bg-white/5 text-neutral-500 hover:bg-white/10'
                  }`}
                >piano prima</button>
              </div>
            )}
            {editingTitle ? (
              <textarea
                autoFocus value={titleDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setTitleDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveTitle}
                onKeyDown={(e) => { cancelKey(e); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTitle(); } }}
                className="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded bg-white/5 px-1.5 py-1 text-sm leading-5 text-neutral-100 outline-none"
              />
            ) : (
              <p
                onClick={() => { if (task) { setTitleDraft(task.text); setEditingTitle(true); } }}
                title="Clicca per modificare il titolo"
                className="-mx-1.5 cursor-text rounded px-1.5 py-1 text-sm leading-5 text-neutral-100 hover:bg-white/5"
              >{task?.text}</p>
            )}
            {editingDesc ? (
              <textarea
                autoFocus value={descDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setDescDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveDesc}
                onKeyDown={cancelKey}
                placeholder="Descrizione…"
                className="-mx-1.5 mt-1 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded bg-white/5 px-1.5 py-0.5 text-sm leading-5 text-neutral-300 outline-none"
              />
            ) : task?.description ? (
              <div
                onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
                title="Clicca per modificare la descrizione"
                className={`-mx-1.5 mt-1 cursor-text rounded px-1.5 py-0.5 text-sm leading-5 text-neutral-300 hover:bg-white/5 ${COMPACT_MD_CLS}`}
              ><ChatMarkdown components={{}}>{task.description}</ChatMarkdown></div>
            ) : (
              <button
                onClick={() => { setDescDraft(''); setEditingDesc(true); }}
                className="mt-1 text-[11px] text-neutral-600 hover:text-neutral-400"
              >+ descrizione…</button>
            )}
          </div>
          {/* Subtask tree — unlimited depth, lazy-expanded. The agent's steps
              live here too: dots flip green as it checks them off. */}
          <div className="max-h-[40%] overflow-y-auto border-b border-white/10 px-3 py-2" data-testid="task-detail-subtasks">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Sottotask{children.length > 0 ? ` · ${doneCount}/${children.length}` : ''}
            </p>
            {children.map((c) => (
              <SubtaskNode key={c.id} projectId={projectId} node={c} depth={0} onOpenTask={onOpenTask} />
            ))}
            <div className="relative mt-1">
              <input
                value={subDraft} disabled={addingSub}
                onChange={(e) => setSubDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                placeholder="+ sottotask…"
                className="w-full rounded bg-white/5 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-60"
              />
              {addingSub && <Loader2 className="absolute right-1.5 top-1.5 h-3 w-3 animate-spin text-neutral-400" />}
            </div>
          </div>
          {/* The task's tab group, folded INTO the body (narrow pane): Thread +
              its surfaces (plan / output / media) as one strip. Selecting a
              surface swaps the body; the review actions below stay visible on
              every tab. Wide enough → the surfaces move to the side panel and
              this bar disappears (inlineTabs false). */}
          {inlineTabs && (
            <TaskTabBar
              surfaces={surfaces}
              activeId={activeSurface ? activeSurface.id : 'thread'}
              onSelect={(id) => setActiveSurfaceId(id === 'thread' ? null : id)}
              includeThread
            />
          )}
          {inlineTabs && activeSurface ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <SurfaceContent surface={activeSurface} />
            </div>
          ) : (
          <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {comments.length === 0 && !task.assignedTopicId && <p className="text-xs text-neutral-500">Nessun commento.</p>}
            {comments.map((c, i) => (
              <div key={c.id} className="space-y-2">
                {task.assignedTopicId && (
                  <SessionSlice msgs={sliceBetween(comments[i - 1]?.createdAt ?? null, c.createdAt)} />
                )}
                {c.kind === 'status' ? <StatusEventRow comment={c} /> : <CommentBubble comment={c} onPreview={(p) => selectSurface(`media:${p}`)} />}
              </div>
            ))}
            {/* Turn still running (or ended after the last comment): its
                reasoning-so-far hangs at the tail, before the indicator. */}
            {task.assignedTopicId && (
              <SessionSlice
                msgs={sliceBetween(comments[comments.length - 1]?.createdAt ?? null, null)}
                label={agentBusy ? 'Ragionamento in corso' : undefined}
                preview={streamPreview}
              />
            )}
            {agentBusy && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-2">
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400/80" style={{ animationDelay: `${d}ms` }} />
                    ))}
                    <span className="ml-1.5 text-[11px] text-neutral-400">
                      {task.dispatchState === 'queued' ? 'in coda…' : task.dispatchState === 'starting' ? 'avvio agent…' : 'agent al lavoro…'}
                      {task.inProgressAt && task.dispatchState === 'working' && (
                        <span className="text-neutral-500"> <Ticker since={task.inProgressAt} /></span>
                      )}
                    </span>
                  </div>
                  <button
                    disabled={busy} onClick={stopAgent}
                    title="Ferma l'agent (il task torna in Backlog con il motivo)"
                    className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
                  >{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 fill-current" />} Ferma</button>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          )}
          <div className="border-t border-white/10 p-2">
            {/* What the agent changed in its worktree — see the diff before deciding. */}
            {task.assignedTopicId && <TaskChangesSection projectId={projectId} taskId={taskId} bump={bump} />}
            {/* Review zone — decisions live HERE, where the agent's questions
                land (end of the thread), not up in the header. */}
            {task.status === 'review' && (
              <div className="mb-2 space-y-1.5">
                {pending && pending.options.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pending.options.map((opt, i) => (
                      <button
                        key={i} disabled={sending}
                        onClick={() => answerOption(opt)}
                        className="rounded bg-white/10 px-2 py-1 text-xs text-neutral-100 hover:bg-white/20 disabled:opacity-50"
                      >{opt}</button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={busy} onClick={() => decide('approve')}
                    title="Accetta e completa il task"
                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Approva</button>
                  <button
                    disabled={busy} onClick={() => decide('reject')}
                    title={isAgentReview ? "Rifiuta (l'agent riparte senza indicazioni)" : 'Rifiuta'}
                    className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50"
                  ><ShieldX className="h-3.5 w-3.5" /> Rifiuta</button>
                </div>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span key={a.path} className="group/att relative">
                    {a.isImage ? (
                      <img src={getMediaUrl(a.path)} alt={a.name} title={a.name} className="h-12 w-12 rounded object-cover" />
                    ) : (
                      <span className="flex max-w-[10rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-neutral-300">
                        <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.name}</span>
                      </span>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                      title="Rimuovi allegato"
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-neutral-700 p-0.5 text-neutral-200 group-hover/att:block"
                    ><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1.5">
              <input
                ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()} disabled={uploading || attachments.length >= 8}
                title="Allega file (o incolla un'immagine nel campo)"
                className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-40"
              >{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}</button>
              <textarea
                ref={commentRef}
                value={draft} onChange={(e) => { setDraft(e.target.value); saveCommentCursor(); }} rows={1}
                onSelect={saveCommentCursor} onKeyUp={saveCommentCursor} onClick={saveCommentCursor}
                onFocus={() => markActiveComposer(commentCursorKey)}
                placeholder={isAgentReview ? 'Rispondi all\'agent…' : 'Commenta…'}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                onPaste={(e) => {
                  const imgs = Array.from(e.clipboardData?.items ?? [])
                    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                    .map((i) => i.getAsFile()).filter((f): f is File => !!f);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none"
              />
              <button
                onClick={send} disabled={sending || (!draft.trim() && attachments.length === 0)}
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
        {/* Side panel: the task's surface tab group, only when it fits AND there
            IS a surface — never an empty frame. Thread stays in the left column;
            here the selected surface renders with its own tab strip. */}
        {sidepanel && sideSurface && (
          <div className="flex min-w-0 flex-1 flex-col bg-neutral-950/40" data-testid="task-output-panel">
            <TaskTabBar
              surfaces={surfaces}
              activeId={sideSurface.id}
              onSelect={(id) => setActiveSurfaceId(id)}
              trailing={
                <button
                  onClick={toggleWide}
                  title="Chiudi il pannello"
                  className="shrink-0 rounded p-1.5 text-neutral-400 hover:bg-white/10"
                ><X className="h-4 w-4" /></button>
              }
            />
            <div className="flex min-h-0 flex-1 flex-col">
              <SurfaceContent surface={sideSurface} />
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * One node of the subtask tree. Direct children arrive with the parent task;
 * deeper levels are fetched lazily on first expand (each task's `get` already
 * returns its children — no dedicated tree endpoint needed).
 */
function SubtaskNode({ projectId, node, depth, onOpenTask }: {
  projectId: string; node: BoardTask; depth: number; onOpenTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<BoardTask[] | null>(null);
  const hasKids = node.subtaskCount > 0;
  // A bare row (no description, no subtasks, no agent tab) has nothing to show
  // in the drawer — no click affordance, so it doesn't look openable when it
  // isn't.
  const openable = !!node.description || hasKids || !!node.assignedTopicId;
  const toggle = async () => {
    if (!open && kids === null) {
      try { const { children } = await boardApi.get(projectId, node.id); setKids(children ?? []); }
      catch { setKids([]); }
    }
    setOpen((o) => !o);
  };
  return (
    <div>
      <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-white/5" style={{ paddingLeft: depth * 10 }}>
        {hasKids ? (
          <button onClick={toggle} className="shrink-0 text-neutral-500 hover:text-neutral-300" title={open ? 'Chiudi' : 'Espandi'}>
            <ChevronRight className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
        <span title={STATUS_LABEL[node.status]} className="flex shrink-0">
          <StatusIcon status={node.status} className="h-3 w-3" />
        </span>
        {openable ? (
          <button
            onClick={() => onOpenTask?.(node.id)}
            title="Apri il sottotask"
            className={`min-w-0 flex-1 truncate text-left text-xs ${node.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-200'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-xs ${node.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-400'}`}>{node.text}</span>
        )}
        {hasKids && <span className="shrink-0 text-[10px] text-neutral-500">↳ {node.subtaskDoneCount}/{node.subtaskCount}</span>}
      </div>
      {open && kids?.map((k) => (
        <SubtaskNode key={k.id} projectId={projectId} node={k} depth={depth + 1} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

/** Glyph per surface kind (+ the Thread pseudo-tab), so the task's tab strip
 *  reads in the same icon language as the app's real tab bar. */
function SurfaceIcon({ kind }: { kind: TaskSurface['kind'] | 'thread' }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  if (kind === 'thread') return <MessageSquare className={cls} />;
  if (kind === 'plan') return <ClipboardList className={cls} />;
  if (kind === 'output') return <Globe className={cls} />;
  return <ImageIcon className={cls} />; // media
}

/**
 * The task's surface tab strip — a lightweight, task-scoped version of the app's
 * PaneTabBar: one row of tabs (optionally led by the Thread), the active one
 * raised. Drives both the inline (narrow) body switch and the side panel (wide).
 * `trailing` hosts a per-context action (e.g. the side panel's close button).
 */
function TaskTabBar({ surfaces, activeId, onSelect, includeThread, trailing }: {
  surfaces: TaskSurface[];
  activeId: string;
  onSelect: (id: string) => void;
  includeThread?: boolean;
  trailing?: React.ReactNode;
}) {
  const tabs: Array<{ id: string; label: string; kind: TaskSurface['kind'] | 'thread' }> = [
    ...(includeThread ? [{ id: 'thread', label: 'Thread', kind: 'thread' as const }] : []),
    ...surfaces.map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
  ];
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-topbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            title={t.label}
            className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs ${
              activeId === t.id ? 'bg-white/10 font-medium text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <SurfaceIcon kind={t.kind} />
            <span className="max-w-[11rem] truncate">{t.label}</span>
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
}

/**
 * Renders one task surface full-height (output iframe / media viewer / plan).
 * The caller places it inside a flex-col so the flex-1 children fill the space.
 */
function SurfaceContent({ surface }: { surface: TaskSurface }) {
  if (surface.kind === 'output') return <OutputFrame key={surface.url} url={surface.url} />;
  if (surface.kind === 'media') return <MediaViewer key={surface.url} url={surface.url} path={surface.path} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-4 py-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">Piano proposto</p>
        <div className={`text-sm text-neutral-200 ${PLAN_MD_CLS}`}>
          <ChatMarkdown components={{}}>{surface.content}</ChatMarkdown>
        </div>
      </div>
    </div>
  );
}

/**
 * The sandboxed output iframe with a loading veil (keyed by URL from the
 * caller, so a URL change remounts and the spinner shows again).
 *
 * Sandbox WITHOUT allow-same-origin: combined with allow-scripts it would void
 * the sandbox entirely (a frame pointed at THIS app's origin could reach
 * parent.document). Opaque origin keeps agent-set URLs inert; pages needing
 * their own storage open externally.
 */
/**
 * Viewer for OUR /api/media files (allowlisted attachments): image inline,
 * PDF in a NON-sandboxed frame — the sandbox blocks WKWebView's native PDF
 * viewer (blank white pane). These are static files this server serves, not
 * agent-controlled web pages: the URL-sandbox rationale doesn't apply.
 */
function MediaViewer({ url, path }: { url: string; path: string }) {
  const isImg = /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path);
  const isPdf = /\.pdf$/i.test(path);
  if (isImg) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-neutral-950/60 p-3">
        <img src={url} alt="" className="mx-auto max-w-full rounded" />
      </div>
    );
  }
  if (isPdf) {
    return <iframe src={url} title="anteprima PDF" className="min-h-0 w-full flex-1 border-0 bg-white" />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm text-neutral-400">Nessuna anteprima per questo tipo di file.</p>
      <button
        onClick={() => openExternalOnce(url)}
        className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20"
      ><ExternalLink className="h-3.5 w-3.5" /> Apri nel browser</button>
    </div>
  );
}

function OutputFrame({ url }: { url: string }) {
  const [loading, setLoading] = useState(true);
  return (
    <div className="relative min-h-0 flex-1">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/40">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
        </div>
      )}
      <iframe
        src={url}
        title="Output del task"
        sandbox="allow-scripts allow-forms"
        onLoad={() => setLoading(false)}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

/**
 * Attachments of a thread message: images inline (click = full size), other
 * files as name chips. Served through the allowlist-gated /api/media, exactly
 * like chat message media.
 */
function MediaStrip({ media, onPreview }: { media?: string[]; onPreview?: (path: string) => void }) {
  if (!media || media.length === 0) return null;
  const isImg = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p);
  // In-app preview when the host provides it (drawer → output panel): a
  // target=_blank anchor is a silent no-op inside the Tauri WKWebView.
  const open = (e: React.MouseEvent, p: string) => {
    e.preventDefault();
    if (onPreview) onPreview(p);
    else openExternalOnce(getMediaUrl(p)); // target=_blank is dead in WKWebView
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {media.map((p) => isImg(p) ? (
        <a key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" title={p.split('/').pop()} onClick={(e) => open(e, p)}>
          <img src={getMediaUrl(p)} alt="" loading="lazy" className="max-h-40 max-w-full rounded-md object-contain" />
        </a>
      ) : (
        <a
          key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" onClick={(e) => open(e, p)}
          title={onPreview ? 'Anteprima nel pannello di review' : p.split('/').pop()}
          className="flex max-w-[14rem] items-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-xs text-neutral-200 hover:bg-white/20"
        ><Paperclip className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{p.split('/').pop()}</span></a>
      ))}
    </div>
  );
}

/** Compact chat timestamp: HH:MM today, dd/MM HH:MM otherwise. */
function commentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/**
 * One thread message. Only the HUMAN's messages are chat bubbles (right,
 * accent tint); agent and system output is bare text on the left — no card, no
 * author title (for dispatched agents the raw author is the topic name = the
 * task title, so any label would read like a bogus username; it survives only
 * in the tooltip). System notes are dimmed.
 */
/** One session message with its placement timestamp (from /api/history). */
interface SessionMsg { role: string; content: string; timestamp: string; thinking?: string }

/**
 * A status transition in the timeline: "chi l'ha spostato e quando", rendered
 * as a thin event row between the speech bubbles (content = "from→to",
 * author = the actor — user, agent name, or dispatcher).
 */
function StatusEventRow({ comment }: { comment: TaskComment }) {
  const to = comment.content.split('→')[1] as TaskStatus | undefined;
  const valid = !!to && TASK_STATUSES.includes(to);
  const at = new Date(comment.createdAt);
  return (
    <div
      className="flex items-center gap-1.5 px-1 text-[11px] text-neutral-500"
      title={`${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} className="h-3 w-3" /> : <span className="h-1 w-1 shrink-0 rounded-full bg-neutral-600" />}
      <span className="min-w-0 truncate">
        <span className="text-neutral-400">{comment.author}</span> → {valid ? STATUS_LABEL[to] : comment.content}
      </span>
      <span className="ml-auto shrink-0 text-neutral-600">{at.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  );
}

/** Compact duration: 42s · 7m · 1h12m. */
const fmtMs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
};

/** Live duration — seconds ALWAYS visible so the ticker is seen moving on
 *  in-progress cards (45s · 12m 05s · 1h 20m). fmtMs stays for static totals. */
const fmtLive = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
};

/** Compact token count: 850 · 12.3k · 1.2M. */
const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Live "ci sta mettendo" ticker for the current run (anchored server-side). */
function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live ticker: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtLive(ms) : '0s'}</>;
}

/** Live per-turn usage pushed by the dispatcher (`task:usage-live`, transient). */
export interface LiveUsage { turnStartedAt: number; baseMs: number; liveTokens: number; model: string | null }

/** Model id → compact tier label for the card chip (auto when unresolved). */
const fmtModel = (m: string | null | undefined): string => {
  if (!m) return 'auto';
  const s = m.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('fable')) return 'fable';
  return m.replace(/^claude-/, '').split('-')[0];
};

/**
 * Live effort chip shown while a turn runs: model · execution-time · tokens,
 * ticking every second. The time is EXECUTION-ONLY: `baseMs` is the agent_ms
 * accumulated over PRIOR turns and we add only (now − turnStartedAt) for the
 * current turn — never the idle/queued/asleep gaps between turns (the server
 * anchors turnStartedAt at the actual turn start). Falls back to the static
 * agent_ms/agent_tokens chip the instant the turn ends.
 */
function LiveEffortChip({ usage }: { usage: LiveUsage }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live effort chip: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = usage.baseMs + Math.max(0, Date.now() - usage.turnStartedAt);
  return (
    <span
      title={`In esecuzione — modello ${fmtModel(usage.model)}, ${fmtLive(ms)} di lavoro${usage.liveTokens ? `, ${usage.liveTokens.toLocaleString('it-IT')} token` : ''} (aggiornamento live)`}
      className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300 tabular-nums"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      {fmtModel(usage.model)} · ⏱ {fmtLive(ms)}{usage.liveTokens > 0 && ` · ${fmtTok(usage.liveTokens)} tok`}
    </span>
  );
}

/**
 * The slice of agent session between two thread comments — the "reasoning"
 * that produced the reply below it. Collapsed to a thin toggle by default
 * (chat-style thinking block); expands inline, read-only, same markdown
 * renderer as the chat. Renders nothing when the interval holds no messages.
 */
function SessionSlice({ msgs, label, preview }: {
  msgs: SessionMsg[];
  label?: string;
  /** Live tail of what's streaming NOW — shown on the collapsed block so the
   *  session strip itself answers "come sta andando" at a glance. */
  preview?: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (msgs.length === 0 && !preview) return null;
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Comprimi il ragionamento' : 'Mostra cosa ha fatto la sessione in questo passaggio'}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
      >
        <Bot className="h-3 w-3 shrink-0" />
        <span>{label ?? 'Ragionamento'} · {msgs.length} passagg{msgs.length === 1 ? 'io' : 'i'}</span>
        <ChevronDown className={`ml-auto h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {!open && preview && (
        <p
          data-testid="task-stream-preview"
          title="Anteprima live di ciò che sta streammando ora"
          className="line-clamp-2 border-t border-white/5 px-2.5 py-1.5 text-[11px] italic leading-snug text-neutral-500"
        >…{preview}</p>
      )}
      {open && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t border-white/5 bg-black/20 px-2.5 py-2">
          {msgs.map((m, i) => (
            <div key={i} className="flex gap-1.5 text-xs leading-relaxed">
              <span className={`shrink-0 font-semibold ${m.role === 'user' ? 'text-sky-400' : 'text-neutral-500'}`}>
                {m.role === 'user' ? '›' : '⏺'}
              </span>
              <div className={`min-w-0 flex-1 text-neutral-300 ${COMPACT_MD_CLS}`}>
                <ChatMarkdown components={{}}>{m.content}</ChatMarkdown>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentBubble({ comment, onPreview }: { comment: TaskComment; onPreview?: (path: string) => void }) {
  if (comment.author !== 'user') {
    const system = comment.author === 'system';
    return (
      <div className="pr-8" title={comment.author}>
        <div className={`text-sm ${system ? 'text-neutral-500' : 'text-neutral-200'}`}>
          <CommentBody content={comment.content} />
        </div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-[9px] text-neutral-600">{commentTime(comment.createdAt)}</p>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-sm">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-right text-[9px] text-neutral-500">{commentTime(comment.createdAt)}</p>
      </div>
    </div>
  );
}

/**
 * Comment body (inside a chat bubble). A question block renders as a styled
 * decision request (question + option bullets) instead of raw ``` fences; any
 * text around the block is kept. Quick-reply buttons live on the card; in the
 * drawer the composer is the answer path (reject-with-text → agent resumes).
 */
function CommentBody({ content }: { content: string }) {
  const q = parseQuestionBlock(content);
  if (!q) return <div className={`mt-0.5 text-neutral-100 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{content}</ChatMarkdown></div>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <div className={`text-neutral-100 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{outside}</ChatMarkdown></div>}
      <div className="rounded border border-rose-500/25 bg-rose-500/5 px-2 py-1.5">
        <p className="text-[13px] leading-snug text-neutral-100">{q.question}</p>
        {q.options.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {q.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-neutral-200">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-rose-300/70" />{opt}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Board settings (auto-dispatch config) ───────────────────────────────────
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function BoardSettingsPanel({ projectId, settings: s, dispatchOn, models, onToggleDispatch, onChanged, onClose, onError }: {
  projectId: string;
  /** Owned by the board (per-project config) — this panel only renders and patches it. */
  settings: BoardSettings | null;
  /** The GLOBAL start switch — owned by the board header (same value as the pill). */
  dispatchOn: boolean | null;
  /** Model ids from the provider snapshot (for the board-default picker). */
  models: string[];
  onToggleDispatch: () => void;
  onChanged: (s: BoardSettings) => void;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const patch = async (p: BoardSettingsPatch) => {
    try { onChanged(await boardApi.updateSettings(projectId, p)); }
    catch (e) { onError(e instanceof Error ? e.message : 'settings save failed'); }
  };
  // Live machine capacity for the "Auto" cap — fetched when the panel opens.
  const [cap, setCap] = useState<DispatchCapacity | null>(null);
  useEffect(() => { boardApi.dispatchCapacity().then(setCap).catch(() => setCap(null)); }, []);

  if (!s) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-white/10 bg-neutral-900/60 px-3 py-2.5 text-xs text-neutral-300">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-neutral-200">Auto-dispatch</span>
        <button onClick={onClose} className="rounded p-0.5 text-neutral-400 hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span>Avvia un agent quando un task entra in <b>Todo</b> <span className="text-neutral-500">— interruttore globale, vale per tutte le board</span></span>
        <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
      </label>

      <div className="space-y-1">
        <label className="flex cursor-pointer items-center justify-between">
          <span>Agent in parallelo (cap)</span>
          <span className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            Auto
            <input
              type="checkbox" checked={s.maxAgentsAuto}
              onChange={(e) => patch({ maxAgentsAuto: e.target.checked })}
              className="h-3.5 w-3.5 accent-emerald-500"
              title="Dimensiona il cap in automatico dalle risorse della macchina (CPU/carico)"
            />
          </span>
        </label>
        {s.maxAgentsAuto ? (
          <p className="text-[11px] text-neutral-500">
            Auto: <b className="text-emerald-300">{cap ? cap.recommended : '…'}</b> agent in parallelo
            {cap && <span className="text-neutral-600"> — {cap.reason}</span>}
          </p>
        ) : (
          <label className="flex items-center justify-between">
            <span className="text-[11px] text-neutral-500">Valore manuale{cap && <span className="text-neutral-600"> (consigliato {cap.recommended})</span>}</span>
            <input
              type="number" min={1} max={10} value={s.maxAgents}
              onChange={(e) => patch({ maxAgents: Number(e.target.value) })}
              className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-neutral-100 outline-none"
            />
          </label>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span>Effort</span>
        <div className="flex gap-0.5">
          {EFFORTS.map((ef) => (
            <button
              key={ef} onClick={() => patch({ dispatchEffort: ef })}
              className={`rounded px-1.5 py-0.5 ${s.dispatchEffort === ef ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-neutral-400 hover:bg-white/10'}`}
            >{ef}</button>
          ))}
        </div>
      </div>

      <label className="flex items-center justify-between gap-2" title="Auto: un classificatore sceglie il modello per ogni task. Un modello fisso forza OGNI dispatch di questa board su quel modello (un task con modello esplicito vince comunque).">
        <span>Modello</span>
        <select
          value={s.dispatchModel || 'auto'}
          onChange={(e) => patch({ dispatchModel: e.target.value })}
          className="max-w-[55%] rounded bg-white/5 px-1.5 py-0.5 text-neutral-100 outline-none"
        >
          <option value="auto">Auto (sceglie il classificatore)</option>
          {models.map((m) => (
            <option key={m} value={m}>{friendlyModelLabel(m)}</option>
          ))}
        </select>
      </label>

      <label className="flex cursor-pointer items-center justify-between">
        <span>Isola ogni agent in un git worktree</span>
        <input type="checkbox" checked={s.dispatchUseWorktree} onChange={(e) => patch({ dispatchUseWorktree: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      <label className="flex cursor-pointer items-center justify-between" title="Su Approva, mergia il branch del task in main nel checkout principale. Merge pulito → landa in locale (niente push); conflitto → rimanda all'agent del task; checkout sporco o non su main → salta con un commento. Richiede il worktree attivo.">
        <span>Auto-merge su Approva</span>
        <input type="checkbox" checked={s.dispatchAutoMerge} disabled={!s.dispatchUseWorktree} onChange={(e) => patch({ dispatchAutoMerge: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500 disabled:opacity-40" />
      </label>

      <label className="flex cursor-pointer items-center justify-between" title="Bridge only: l'agent ha solo i tool di Topics (task + browser) — meno token per turno. Fleet completa: eredita tutti gli MCP dell'utente (exa, gateway…), utile solo se i task usano quei tool.">
        <span>Fleet MCP completa per gli agent</span>
        <input type="checkbox" checked={s.dispatchMcp === 'inherit'} onChange={(e) => patch({ dispatchMcp: e.target.checked ? 'inherit' : 'bridge-only' })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      {dispatchOn && (
        <p className="text-[11px] text-amber-300/80">Attivo: spostare un task in Todo avvierà un agent con permessi pieni.</p>
      )}
    </div>
  );
}
