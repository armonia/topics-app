import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent as ReactTouchEvent } from 'react';
import { ArrowUpRight, Bot, Camera, Check, ChevronDown, ChevronRight, Clock, Download, ExternalLink, Footprints, GitMerge, Globe, Link2, Loader2, Lock, Maximize2, Minimize2, MoreHorizontal, Paperclip, Plus, RotateCw, Send, ShieldCheck, ShieldX, Sparkles, Square, Unplug, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ReasoningRow } from '../Chat/ReasoningRow';
import { Menu } from '../Shared/Menu';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { getMediaUrl } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';
import { buildTaskLink } from '../../lib/openTaskLink';
import { enqueueProjectBrowserNavigate } from '../../state/pane/adapters';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { boardApi, STATUS_LABEL, TASK_STATUSES, parseQuestionBlock, isProjectlessId, boardDrafts, type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch, type BoardProjectRef, type DiffBundle } from '../../lib/board';
import { UnifiedDiff } from './UnifiedDiff';
import { COMPACT_MD_CLS, PLAN_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, DISPATCH_CHIP, EFFORTS, type TaskSurface } from './constants';
import { friendlyModelLabel, fmtModel, commentTime, fmtMs, fmtLive, fmtTok, fmtUpdatedAt, autoGrow } from './format';
import { StatusIcon, DispatchChip } from './atoms';
import { ProjectPickerBody } from './ProjectPicker';
import { GroupLayout } from '../Layout/GroupLayout';
import { useTaskBrowserGroupLayout, type TaskBrowserGroupLayout, type RenderSurface } from './useTaskBrowserGroupLayout';
import { POPOVER_DIVIDER, POPOVER_ITEM } from '@/lib/popoverStyles';

/** Feature flag (per-client kill-switch): the task's browser lives as a
 *  task-owned tiling group driven by the app's real GroupLayout engine (split /
 *  drag / tab-stack / resize), scoped to the drawer and OUT of pane-store-v2.
 *  Default ON; set `localStorage['board:taskBrowser'] = '0'` to force it off. */
/** Hostname of a URL for a compact tab label, or '' if unparseable. */
function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Collapsible "Modifiche" panel in the task drawer: the unified diff of what
 *  the task's dispatched agent changed in its isolated worktree, so a reviewer
 *  can see the actual changes before approving. Renders NOTHING when there's no
 *  worktree or the diff is empty ("non mostrare modifiche se non ci sono") — it
 *  probes eagerly and owns its own section chrome so an unchanged task shows no
 *  bar at all. */
export function TaskChangesSection({ projectId, taskId, bump }: { projectId: string; taskId: string; bump?: string | number }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiffBundle | 'loading' | 'error' | null>(null);
  const fetchDiff = useCallback(() => {
    setState('loading');
    boardApi.taskDiff(projectId, taskId).then(setState).catch(() => setState('error'));
  }, [projectId, taskId]);
  // Eager (not lazy): visibility depends on whether the worktree has changes, so
  // we must probe up-front. Re-runs when the task advances (bump) — the agent
  // may have committed more.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { fetchDiff(); }, [fetchDiff, bump]);
  const bundle = state && typeof state === 'object' ? state : null;
  const fileCount = bundle && bundle.code !== 'no_worktree' ? bundle.stat.length : 0;
  // Nothing to show → nothing at all (no empty bar): still probing, errored, no
  // worktree, or a zero-file diff.
  if (!bundle || bundle.code === 'no_worktree' || fileCount === 0) return null;
  return (
    <div className="shrink-0 border-b border-white/10 px-3 py-2">
      <button onClick={() => setOpen((s) => !s)} className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-300">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Modifiche <span className="normal-case tracking-normal text-neutral-600">· {fileCount} file</span>
      </button>
      {open && (
        <div className="mt-1.5 max-h-[42vh] overflow-y-auto">
          <UnifiedDiff bundle={bundle} defaultOpenFirst />
        </div>
      )}
    </div>
  );
}

// ── Detail: drawer by default, expandable review surface ────────────────────

export function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic }: {
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
  // Collapsible description + subtask sections (sticky per client): the drawer
  // header can grow tall, and both are secondary to the thread/body — collapsing
  // them reclaims vertical room for the chat.
  const [descOpen, setDescOpen] = useState(() => { try { return localStorage.getItem('board:taskDescOpen') !== '0'; } catch { return true; } });
  const [subtasksOpen, setSubtasksOpen] = useState(() => { try { return localStorage.getItem('board:taskSubtasksOpen') !== '0'; } catch { return true; } });
  const toggleDescOpen = () => setDescOpen((o) => { const n = !o; try { localStorage.setItem('board:taskDescOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  const toggleSubtasksOpen = () => setSubtasksOpen((o) => { const n = !o; try { localStorage.setItem('board:taskSubtasksOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  // The workspace (the task's GroupLayout: thread + browser + piano + media) is
  // itself an accordion, coherent with the others — the tab bar sits UNDER a
  // "Spazio di lavoro" label. Default open.
  const [workspaceOpen, setWorkspaceOpen] = useState(() => { try { return localStorage.getItem('board:taskWorkspaceOpen') !== '0'; } catch { return true; } });
  const toggleWorkspaceOpen = () => setWorkspaceOpen((o) => { const n = !o; try { localStorage.setItem('board:taskWorkspaceOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  // The drawer body is ONE task-scoped GroupLayout (Thread + browser tabs +
  // Piano + media as panes → the app's real PaneTabBar). `wide` is now a pure
  // width preference (more room for the native tiling), no side-panel fold.
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Swipe-to-close (mobile full-screen overlay only). Track the first touch and
  // lock onto a horizontal drag (dominant X vs Y) so a vertical scroll inside the
  // drawer never turns into a dismiss; drag follows the finger, release past a
  // threshold closes. Disabled on lg+ where the drawer is an in-flow side panel.
  const [dragX, setDragX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const swipeStart = useRef<{ x: number; y: number; locked: boolean } | null>(null);
  const onSwipeStart = (e: ReactTouchEvent) => {
    if (window.innerWidth >= 1024) return;
    const t = e.touches[0];
    swipeStart.current = { x: t.clientX, y: t.clientY, locked: false };
  };
  const onSwipeMove = (e: ReactTouchEvent) => {
    const s = swipeStart.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      if (Math.abs(dx) <= Math.abs(dy)) { swipeStart.current = null; return; }
      s.locked = true;
      setSwiping(true);
    }
    setDragX(Math.max(0, dx));
  };
  const onSwipeEnd = () => {
    const s = swipeStart.current;
    if (s?.locked && dragX > 90) { onClose(); return; }
    swipeStart.current = null;
    setSwiping(false);
    setDragX(0);
  };

  const load = useCallback(async () => {
    try {
      const { task, comments, children } = await boardApi.get(projectId, taskId);
      setTask(task); setComments(comments); setChildren(children ?? []);
    } catch { /* closed or gone */ }
  }, [projectId, taskId]);
  // fetch-on-mount: setState lands after the await, not synchronously
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

  // Land = accept + merge the branch on main (local, no push). Explicit, separate
  // from Approva (which only accepts the task). The merge/build runs server-side
  // and surfaces its outcome as system comments in the thread.
  const doLand = async () => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.land(projectId, taskId); setError(null); await load(); onChanged(); }
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
  // clicks "Sposta su…" once. (fetch-on-mount: setState lands after the await.)
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
  // "Apri nel workspace": open the delivered result as a REAL Topics browser tab
  // (managed pane — split/resize/close) in the task's project window, NOT the OS
  // browser. If that window isn't mounted yet, park the navigate so it drains on
  // mount; topics:open-project triggers the mount, the racing event loses it.
  const openInWorkspace = useCallback(() => {
    const projectPath = currentProject?.path;
    const url = task?.outputUrl;
    if (!url || !projectPath) return;
    // Deterministic contextId → same pane is reused on re-open and the agent can
    // steer it later (login handoff, fase 2).
    const contextId = task?.assignedTopicId || `task-${task?.id}`;
    enqueueProjectBrowserNavigate(projectPath, { url, contextId });
    window.dispatchEvent(new CustomEvent('topics:open-project', { detail: { projectPath } }));
    window.dispatchEvent(new CustomEvent('browser:open-and-navigate', { detail: { projectPath, url, topicId: task?.assignedTopicId, contextId } }));
  }, [currentProject?.path, task?.outputUrl, task?.assignedTopicId, task?.id]);
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

  // Overflow "⋯" menu (header): the less-frequent task config lives here instead
  // of as always-on chips in the meta row — blocked-by, plan-first, reuse
  // context, plus "aggiungi sottotask". Keeps the meta row to priorità + modello.
  const optionsBtnRef = useRef<HTMLButtonElement>(null);
  const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);
  // Reveal the subtask composer even when there are no subtasks yet (the section
  // is hidden when empty — this opens it on demand from the ⋯ menu).
  const [subtaskComposerOpen, setSubtaskComposerOpen] = useState(false);

  // Esc closes the drawer — UNLESS Esc belongs to something inside it: an
  // inline title/desc edit (Esc cancels the edit) or an open menu (Esc closes
  // the menu). Menus use useDismissable (capture + stopPropagation on document)
  // so they already swallow Esc before it reaches this window-level listener;
  // the state guard also covers the edit textareas, whose onKeyDown neither
  // stops nor prevents the event. Refs keep the listener registered once while
  // reading the latest guard/close on each keystroke.
  const escGuardRef = useRef<() => boolean>(() => false);
  escGuardRef.current = () =>
    editingTitle || editingDesc || statusMenuOpen || prioMenuOpen || projMenuOpen || blockerMenuOpen || modelMenuOpen || optionsMenuOpen;
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
      await navigator.clipboard.writeText(buildTaskLink(task.id));
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

  // ── Drawer body = ONE task-scoped GroupLayout ─────────────────────────────
  // Thread, live browser tabs, Piano and each media attachment are all PANES of
  // the app's REAL PaneTabBar (a single tab bar; native split/resize/drag). The
  // hook owns identity + tiling; the derived (thread/plan/media) pane bodies
  // render through `renderSurface`. Defined here (after the thread deps:
  // sliceBetween/agentBusy/streamPreview…) so every dep array is in scope.
  const browserRef = useRef<TaskBrowserGroupLayout | null>(null);
  const renderThread = useCallback((): React.ReactNode => {
    if (!task) return null;
    return (
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {comments.length === 0 && !task.assignedTopicId && <p className="text-xs text-neutral-500">Nessun commento.</p>}
        {comments.map((c, i) => (
          <div key={c.id} className="space-y-2">
            {task.assignedTopicId && (
              <SessionSlice msgs={sliceBetween(comments[i - 1]?.createdAt ?? null, c.createdAt)} />
            )}
            {c.kind === 'status' ? <StatusEventRow comment={c} /> : <CommentBubble comment={c} onPreview={(p) => browserRef.current?.focusPane(`media:${p}`)} />}
          </div>
        ))}
        {task.assignedTopicId && (
          <SessionSlice
            msgs={sliceBetween(comments[comments.length - 1]?.createdAt ?? null, null)}
            label={agentBusy ? 'Sta lavorando' : undefined}
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
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopAgent/bottomRef are stable enough; the meaningful inputs are listed
  }, [task, comments, sliceBetween, agentBusy, streamPreview, busy]);

  const renderSurface = useCallback<RenderSurface>((pane, _isVisible) => {
    if (pane.id.startsWith('thread:')) return renderThread();
    if (pane.id.startsWith('plan:') && planComment)
      return <SurfaceContent surface={{ id: pane.id, kind: 'plan', label: 'Piano', content: planComment.content }} taskId={taskId} />;
    if (pane.id.startsWith('media:')) {
      const p = pane.id.slice('media:'.length);
      return <SurfaceContent surface={{ id: pane.id, kind: 'media', label: pane.title || 'Allegato', url: getMediaUrl(p), path: p }} taskId={taskId} />;
    }
    return null;
  }, [renderThread, planComment, taskId]);

  // The single GroupLayout that IS the drawer body's tab system.
  const browser = useTaskBrowserGroupLayout(taskId, { planActive: !!planComment, mediaPaths, renderSurface });
  browserRef.current = browser;
  // Seed the first browser tab from the review output_url once, when the task
  // has no tabs yet (so the reviewer lands on the delivered page). NO forced
  // "Output" label — it's just a normal browser tab: the bar shows the system
  // default ("Browser") until the page loads, then the page's OWN title (auto).
  useEffect(() => {
    if (!task?.outputUrl) return;
    void browser.seedFromUrl(task.outputUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedFromUrl is stable per taskId; refire only when the output_url changes
  }, [task?.outputUrl]);

  const doneCount = children.filter((c) => c.status === 'done').length;

  return (
    <div
      ref={rootRef}
      data-testid="task-detail-drawer"
      onTouchStart={onSwipeStart}
      onTouchMove={onSwipeMove}
      onTouchEnd={onSwipeEnd}
      onTouchCancel={onSwipeEnd}
      style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
      // Mobile (<lg): a FULL-SCREEN overlay (`absolute inset-0`) that sits ABOVE
      // the board's own topbar (z-40) with swipe-right-to-close — no compact
      // side strip on a phone. Desktop (lg+): a layout SIBLING (relative, in-flow,
      // shrink-0) so the columns viewport shrinks beside it and the board stays
      // scrollable; wide just grows the review surface (72%/64rem caps keep a
      // strip of board visible).
      className={`glass-surface flex flex-col border-white/10 ${swiping ? '' : 'transition-transform duration-200'} absolute inset-0 z-40 w-full lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l ${
        wide ? 'lg:w-[min(64rem,72%)] lg:shadow-2xl' : 'lg:w-96 lg:max-w-[75%]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2.5">
        {/* Topbar = slim window-chrome row: the status selector on the left,
            window actions on the right. Everything else — project eyebrow,
            title + dispatch state, and the attribute chips — lives in the
            content block below, laid out exactly like the Kanban card. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <button
          ref={statusBtnRef}
          onClick={() => task && setStatusMenuOpen(true)}
          data-testid="task-status-chip"
          title="Cambia lo stato del task"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-neutral-300 hover:bg-white/10"
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
              className={`${POPOVER_ITEM} disabled:opacity-40`}
            >
              <StatusIcon status={s} className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1">{STATUS_LABEL[s]}</span>
              {s === task?.status && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {task && (
            <button
              ref={optionsBtnRef}
              onClick={() => setOptionsMenuOpen((o) => !o)}
              data-testid="task-options-menu"
              title="Altre opzioni: piano prima, bloccato da, sottotask…"
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            ><MoreHorizontal className="h-4 w-4" /></button>
          )}
          {task && (
            <Menu open={optionsMenuOpen} anchorRef={optionsBtnRef} onClose={() => setOptionsMenuOpen(false)} align="right" minWidth={240}>
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Opzioni task</p>
              <button
                role="menuitem" disabled={busy} onClick={togglePlanFirst}
                title="L'agent consegna un piano da approvare PRIMA di implementare"
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1">Piano prima</span>
                {task.planFirst && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); openBlockerMenu(); }}
                className={POPOVER_ITEM}
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <span className="min-w-0 flex-1 truncate">{blockerTask ? `Bloccato da: ${blockerTask.text}` : 'Bloccato da…'}</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
              </button>
              {task.blockedByTaskId && (
                <button
                  role="menuitem" disabled={busy} onClick={toggleReuseContext}
                  title="Quando parte, l'agent riceve il contesto della sessione del task bloccante invece di uno start a freddo"
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1">Riusa il contesto del bloccante</span>
                  {task.reuseBlockerContext && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              )}
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); setSubtasksOpen(true); setSubtaskComposerOpen(true); }}
                className={POPOVER_ITEM}
              ><Plus className="h-3.5 w-3.5 shrink-0 text-neutral-400" /> Aggiungi sottotask</button>
            </Menu>
          )}
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
              onClick={openInWorkspace}
              data-testid="task-open-in-workspace"
              title="Apri il risultato come tab nel workspace del progetto"
              className="rounded p-1.5 text-neutral-400 hover:bg-white/10"
            ><Globe className="h-4 w-4" /></button>
          )}
          {/* Espandi/riduci ha senso solo sul side-panel desktop: su mobile il
              drawer è già full-screen, quindi il toggle è nascosto (<lg). */}
          <button
            onClick={toggleWide}
            title={wide ? 'Riduci il drawer (vedi la board)' : 'Allarga il drawer (più spazio per il tiling)'}
            className="hidden rounded p-1.5 text-neutral-400 hover:bg-white/10 lg:block"
          >{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          <button onClick={onClose} className="rounded p-1.5 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* Verdetto dell'audit di landing: un task chiuso il cui lavoro non è su
          main. Sta QUI, in cima al drawer, e non solo come commento nel thread —
          il commento si perde, la banda no. */}
      {task?.status === 'done' && task.landingState === 'unlanded' && (
        <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          ⚠️ Chiuso ma <strong>non su main</strong>: il commit consegnato
          {task.deliveryCommit ? <> <code className="rounded bg-black/30 px-1">{task.deliveryCommit.slice(0, 8)}</code></> : null}
          {task.deliveryBranch ? <> (branch <code className="rounded bg-black/30 px-1">{task.deliveryBranch}</code>)</> : null}
          {' '}non risulta nel contenuto di main. Landa il branch, o recupera il commit prima che venga potato.
        </div>
      )}
      {!task ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Single column: meta + subtask tree + the one GroupLayout body +
            composer/review actions. No more left/right surface split — the
            GroupLayout tiles natively when the user splits. `min-h-0` is
            load-bearing: without it this column grows to its content instead of
            the drawer height, so the subtask tray's `max-h-[40%]` and the
            thread's `overflow-y-auto` never get a bounded height → nothing
            scrolls. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-white/10 px-3 py-3">
            {task?.parentTaskId && onOpenTask && (
              <button
                onClick={() => onOpenTask(task.parentTaskId!)}
                className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
              >⤴ Task padre</button>
            )}
            {/* Project EYEBROW + PRIMARY STATE on one row — favicon + name on the
                left, the dispatch chip aligned right (card's top-right slot). The
                title below then gets the FULL width, no chip competing with it. */}
            {task && (
              <div className="mb-1 flex items-center gap-2">
                <button
                  ref={projChipRef}
                  onClick={openProjMenu}
                  data-testid="task-project-chip"
                  title={`Progetto: ${projectLabel} — sposta, apri o creane uno nuovo`}
                  className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
                >
                  <ProjectFavicon path={currentProject?.path ?? ''} size={14} className="shrink-0" fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />} />
                  <span className="min-w-0 truncate font-medium">{projectLabel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
                </button>
                {(task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
                  <DispatchChip state={task.dispatchState} error={task.dispatchError} />
                ) : (!task.dispatchState && task.dispatchError) ? (
                  <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300" title={task.dispatchError}>fermato</span>
                ) : null}
              </div>
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
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem" disabled={!currentProject}
                onClick={doOpenProject}
                title={currentProject ? `Apri la finestra di ${currentProject.name}` : 'Percorso del progetto non risolvibile'}
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              ><ArrowUpRight className="h-3.5 w-3.5" /> Apri progetto</button>
            </Menu>
            {/* Title — FULL width (the dispatch state moved up to the project
                eyebrow row, so nothing competes with it here). */}
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
            {/* Meta row — compact chips that wrap, card-style: priorità,
                modello · ⏱ effort (UN chip, come la card), piano-prima,
                blocked-by + reuse. Editable selectors keep their portaled Menus. */}
            {task && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className="flex items-center gap-1 text-[11px] text-neutral-500"
                  title={`Ultimo aggiornamento: ${new Date(task.updatedAt).toLocaleString('it-IT')}`}
                ><Clock className="h-3 w-3 shrink-0" /> {fmtUpdatedAt(task.updatedAt)}</span>
                <button
                  ref={prioBtnRef}
                  onClick={() => task && setPrioMenuOpen(true)}
                  data-testid="task-priority-chip"
                  title={task.priorityAuto
                    ? "Priorità automatica: la valuta l'agent appena inquadra il task"
                    : 'Cambia la priorità del task (la coda serve prima le priorità alte)'}
                  className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] ${
                    !task.priorityAuto && task.priority >= 3 ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
                  {task.priorityAuto ? 'Priorità auto' : PRIORITY_LABEL[task.priority] ?? 'Media'}
                  <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
                </button>
                <Menu open={prioMenuOpen} anchorRef={prioBtnRef} onClose={() => setPrioMenuOpen(false)} minWidth={160} role="listbox">
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Priorità</p>
                  {PRIORITY_ORDER.map((p) => (
                    <button
                      key={p} role="option" aria-selected={p === task?.priority}
                      disabled={busy}
                      onClick={() => changePriority(p)}
                      className={`${POPOVER_ITEM} disabled:opacity-40`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
                      <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
                      {p === task?.priority && !task?.priorityAuto && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                    </button>
                  ))}
                </Menu>
                <button
                  ref={modelBtnRef}
                  onClick={() => setModelMenuOpen(true)}
                  data-testid="task-model-chip"
                  title={(task.agentMs > 0 || task.agentTokens > 0)
                    ? `Modello ${task.model ? fmtModel(task.model) : 'Auto'} · effort ${fmtMs(task.agentMs)}${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''} — clicca per cambiare modello`
                    : "Modello dell'agent — Auto = il classificatore opus-first sceglie per task"}
                  className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-white/20"
                >
                  <Sparkles className="h-3 w-3 shrink-0 text-neutral-500" />
                  <span className="truncate">{task.model ? fmtModel(task.model) : 'Auto'}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}`}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
                </button>
                <Menu open={modelMenuOpen} anchorRef={modelBtnRef} onClose={() => setModelMenuOpen(false)} minWidth={200} role="listbox">
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Modello agent</p>
                  <button
                    role="option" aria-selected={!task?.model} disabled={busy}
                    onClick={() => changeModel(null)}
                    className={`${POPOVER_ITEM} disabled:opacity-40`}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    <span className="min-w-0 flex-1">Auto <span className="text-neutral-500">(opus-first)</span></span>
                    {!task?.model && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                  </button>
                  {models.map((m) => (
                    <button
                      key={m} role="option" aria-selected={m === task?.model} disabled={busy}
                      onClick={() => changeModel(m)}
                      className={`${POPOVER_ITEM} disabled:opacity-40`}
                    >
                      <span className="min-w-0 flex-1">{friendlyModelLabel(m)}</span>
                      {m === task?.model && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                    </button>
                  ))}
                </Menu>
                {/* Blocked-by / plan-first / reuse moved to the ⋯ header menu.
                    Only the blocker PICKER stays here — portaled, anchored to the
                    ⋯ button, opened from that menu. */}
                <Menu open={blockerMenuOpen} anchorRef={optionsBtnRef} onClose={() => setBlockerMenuOpen(false)} align="right" minWidth={220} role="listbox" unmanagedFocus>
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Bloccato da…</p>
                  <button
                    role="option" aria-selected={!task.blockedByTaskId}
                    onClick={() => pickBlocker(null)}
                    className={POPOVER_ITEM}
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
                        className={POPOVER_ITEM}
                      >
                        <span className="min-w-0 flex-1 truncate">{t.text}</span>
                        {t.id === task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                      </button>
                    ))}
                  </div>
                </Menu>
              </div>
            )}
          </div>
          {/* Descrizione — accordion coerente con Sottotask/Modifiche: stesso
              container (px-3 py-2), stessa label (chevron + uppercase), corpo a
              mt-1.5. Spazio sopra/sotto la label uguale (il py-2 del contenitore). */}
          <div className="shrink-0 border-b border-white/10 px-3 py-2">
            {editingDesc ? (
              <textarea
                autoFocus value={descDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setDescDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveDesc}
                onKeyDown={cancelKey}
                placeholder="Descrizione…"
                className="block w-full resize-none overflow-hidden rounded bg-white/5 px-1.5 py-0.5 text-sm leading-5 text-neutral-300 outline-none"
              />
            ) : task?.description ? (
              <>
                <button
                  onClick={toggleDescOpen}
                  className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
                >
                  {descOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Descrizione
                </button>
                {descOpen && (
                  <div
                    onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
                    title="Clicca per modificare la descrizione"
                    className={`mt-1.5 cursor-text rounded px-1.5 py-0.5 text-sm leading-5 text-neutral-300 hover:bg-white/5 ${COMPACT_MD_CLS}`}
                  ><ChatMarkdown components={{}}>{task.description}</ChatMarkdown></div>
                )}
              </>
            ) : (
              <button
                onClick={() => { setDescDraft(''); setEditingDesc(true); }}
                className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600 hover:text-neutral-400"
              >+ descrizione…</button>
            )}
            {/* Anteprima della consegna anche nel drawer (non solo sulla card):
                intera, object-contain — il reviewer deve poter vedere TUTTO lo
                screenshot. Click → apre l'immagine piena fuori dal drawer. */}
            {task?.previewImage && (
              <img
                src={getMediaUrl(task.previewImage)}
                alt="Anteprima della consegna"
                loading="lazy"
                title="Apri lo screenshot a grandezza piena"
                onClick={() => openExternalOnce(getMediaUrl(task.previewImage!))}
                className="mt-2 max-h-[50vh] w-full cursor-zoom-in rounded border border-white/10 bg-black/20 object-contain"
              />
            )}
            {/* File consegnati: ogni artefatto (screenshot/video/PDF) è
                polimorfo — click sul nome lo apre come TAB nel workspace del
                task, l'icona lo SCARICA. Rimpiazza l'idea di "output" a parte:
                il risultato è tab + lista scaricabili. */}
            {mediaPaths.length > 0 && (
              <div className="mt-3" data-testid="task-downloads">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-600">File consegnati</div>
                <ul className="flex flex-col gap-1">
                  {mediaPaths.map((p) => {
                    const name = p.split('/').pop() || p;
                    return (
                      <li key={p} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs text-neutral-300">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                        <button
                          type="button"
                          onClick={() => browser.focusPane(`media:${p}`)}
                          title="Apri come tab nel workspace del task"
                          className="min-w-0 flex-1 truncate text-left hover:text-white"
                        >{name}</button>
                        <a
                          href={getMediaUrl(p)}
                          download={name}
                          title="Scarica il file"
                          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white"
                        ><Download className="h-3.5 w-3.5" /></a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          {/* Closed-tab tray — ONLY the soft-closed browser tabs live here under
              the description so a closed tab stays reopenable and previewable
              ("quando chiuso"). Live tabs (and the "+" to add one) belong to the
              GroupLayout's own PaneTabBar below — the single tab system. */}
          {browser.parkedTabs.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/10 px-3 py-2 scrollbar-topbar" data-testid="task-browser-previews">
              {browser.parkedTabs.map((t) => {
                const label = t.title || hostLabel(t.url) || 'Nuova scheda';
                return (
                  <div
                    key={t.contextId}
                    className="group/prev flex shrink-0 items-center rounded-md border border-white/10 bg-white/[0.02] text-xs text-neutral-500"
                  >
                    <button
                      onClick={() => browser.reopenTab(t.contextId)}
                      title="Riapri questa scheda"
                      className="flex items-center gap-1.5 px-2 py-1"
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{label}</span>
                      <span className="text-[9px] uppercase tracking-wide text-neutral-600">chiusa</span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); browser.removeTab(t.contextId); }}
                      title="Rimuovi la scheda"
                      className="mr-1 rounded p-0.5 text-neutral-500 opacity-0 hover:bg-white/10 hover:text-neutral-200 group-hover/prev:opacity-100"
                    ><X className="h-3 w-3" /></button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Subtask tree — collapsible; unlimited depth, lazy-expanded. The
              agent's steps live here too: dots flip green as it checks them off.
              Hidden entirely when there are no subtasks ("non mostrare se non ci
              sono") — added on demand from the ⋯ menu (subtaskComposerOpen). */}
          {(children.length > 0 || subtaskComposerOpen) && (
          <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-white/10 px-3 py-2" data-testid="task-detail-subtasks">
            <button
              onClick={toggleSubtasksOpen}
              className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
            >
              {subtasksOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Sottotask{children.length > 0 ? ` · ${doneCount}/${children.length}` : ''}
            </button>
            {subtasksOpen && (
              <div className="mt-1.5">
                {children.map((c) => (
                  <SubtaskNode key={c.id} projectId={projectId} node={c} depth={0} onOpenTask={onOpenTask} />
                ))}
                <div className="relative mt-1">
                  <input
                    value={subDraft} disabled={addingSub}
                    autoFocus={subtaskComposerOpen && children.length === 0}
                    onChange={(e) => setSubDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                    placeholder="+ sottotask…"
                    className="w-full rounded bg-white/5 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-60"
                  />
                  {addingSub && <Loader2 className="absolute right-1.5 top-1.5 h-3 w-3 animate-spin text-neutral-400" />}
                </div>
              </div>
            )}
          </div>
          )}
          {/* "Modifiche" (worktree diff) lives HERE — above the body, OUT of the
              chat composer area ("sopra la chat era fastidioso"). It renders
              NOTHING when there's no worktree / an empty diff (owns its own
              section chrome), so an unchanged task shows no "Modifiche" bar. */}
          {task.assignedTopicId && <TaskChangesSection projectId={projectId} taskId={taskId} bump={bump} />}
          {/* "Spazio di lavoro" — the task's ONE GroupLayout (Thread + browser
              tabs + Piano + media, the app's real PaneTabBar). Collapsible like
              the other sections: the tab bar sits UNDER this label. Default open;
              when collapsed the panes hide and a flex spacer keeps the composer
              pinned to the bottom. */}
          <div className={`flex min-w-0 flex-col ${workspaceOpen ? 'min-h-0 flex-1' : 'shrink-0'}`}>
            <button
              onClick={toggleWorkspaceOpen}
              className="flex w-full shrink-0 items-center gap-1 border-b border-white/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
            >
              {workspaceOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Spazio di lavoro
            </button>
            {workspaceOpen && (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
                <GroupLayout {...browser.groupLayoutProps} />
              </div>
            )}
          </div>
          {!workspaceOpen && <div className="flex-1" />}
          <div className="border-t border-white/10 p-2">
            {/* Review zone — decisions live HERE, where the agent's questions
                land (end of the thread), not up in the header. ("Modifiche" moved
                up above the body, out of this composer area.) */}
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
                    title="Accetta e completa il task. NON fa il merge — per landare il branch su main usa 'Landa su main'."
                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Approva</button>
                  <button
                    disabled={busy} onClick={() => decide('reject')}
                    title={isAgentReview ? "Rifiuta (l'agent riparte senza indicazioni)" : 'Rifiuta'}
                    className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50"
                  ><ShieldX className="h-3.5 w-3.5" /> Rifiuta</button>
                </div>
                {/* Explicit landing — accept + merge the branch on main (local, no
                    push, build server-side). Separate from Approva by design: the
                    merge no longer rides "da sotto" on an approve. */}
                {isAgentReview && (
                  <button
                    disabled={busy} onClick={doLand}
                    title="Accetta e fai il merge del branch su main (locale, nessun push online). La build gira lato server; l'esito appare nel thread."
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-sky-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  ><GitMerge className="h-3.5 w-3.5" /> Landa su main</button>
                )}
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
                placeholder={isAgentReview ? 'Rispondi all\'agent…' : agentBusy ? 'Scrivi all\'agent mentre lavora — lo riceve al prossimo turno…' : 'Commenta…'}
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
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : agentBusy ? "Invia all'agent — lo riceve al prossimo turno (come Claude Code)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview || agentBusy ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
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
export function SubtaskNode({ projectId, node, depth, onOpenTask }: {
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

/**
 * Renders one LIGHT task surface full-height (output iframe / media viewer /
 * plan). The browser group is NOT handled here — it renders through the app's
 * real GroupLayout engine (see useTaskBrowserGroupLayout), placed directly by
 * TaskDetail. The caller places this inside a flex-col so flex-1 children fill.
 */
export function SurfaceContent({ surface, taskId }: { surface: TaskSurface; taskId?: string }) {
  void taskId;
  if (surface.kind === 'output') return <OutputFrame key={surface.url} url={surface.url} />;
  if (surface.kind === 'media') return <MediaViewer key={surface.url} url={surface.url} path={surface.path} />;
  if (surface.kind === 'browser') return null; // handled by GroupLayout in TaskDetail
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
export function MediaViewer({ url, path }: { url: string; path: string }) {
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

export function OutputFrame({ url }: { url: string }) {
  // 'loading' → spinner over a still-loading iframe; 'ok' → the page rendered;
  // 'unreachable' → the target never answered (dead dev server, refused
  // connection, or a page the browser refuses to embed). A bare iframe to an
  // unreachable URL paints a blank white void with zero signal — so we probe
  // reachability and, on failure, swap in an actionable card instead of
  // leaving the reviewer staring at nothing.
  const [state, setState] = useState<'loading' | 'ok' | 'unreachable'>('loading');
  const [attempt, setAttempt] = useState(0);
  // Retry re-runs the probe AND remounts the iframe; it resets to 'loading' here
  // (an event handler, not the effect body) so a fresh url — which remounts the
  // whole component via the parent's key={surface.url} — starts loading anyway.
  const retry = () => { setState('loading'); setAttempt((a) => a + 1); };

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    // no-cors probe: any HTTP answer (200/404/500) resolves opaque → reachable;
    // a refused connection / dead port / mixed-content block rejects. This is
    // what distinguishes "server down" from "page just slow to paint".
    fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' }).catch((e) => {
      if (alive && e?.name !== 'AbortError') setState((s) => (s === 'ok' ? s : 'unreachable'));
    });
    // Backstop: nothing loaded in time (probe inconclusive AND iframe silent).
    const timer = setTimeout(() => { if (alive) setState((s) => (s === 'ok' ? s : 'unreachable')); }, 8000);
    return () => { alive = false; ctrl.abort(); clearTimeout(timer); };
  }, [url, attempt]);

  if (state === 'unreachable') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-neutral-950/40 p-6 text-center">
        <Unplug className="h-7 w-7 text-neutral-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-neutral-200">Output non raggiungibile</p>
          <p className="mx-auto max-w-[26rem] truncate font-mono text-[11px] text-neutral-500" title={url}>{url}</p>
          <p className="text-[11px] text-neutral-500">Il server potrebbe essere spento, o la pagina non è incorporabile.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={retry}
            className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20"
          ><RotateCw className="h-3.5 w-3.5" /> Riprova</button>
          <button
            onClick={() => openExternalOnce(url)}
            className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20"
          ><ExternalLink className="h-3.5 w-3.5" /> Apri nel browser</button>
        </div>
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1">
      {state === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/40">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
        </div>
      )}
      <iframe
        key={attempt}
        src={url}
        title="Output del task"
        sandbox="allow-scripts allow-forms"
        onLoad={() => setState('ok')}
        onError={() => setState('unreachable')}
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
export function MediaStrip({ media, onPreview }: { media?: string[]; onPreview?: (path: string) => void }) {
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

/**
 * One thread message. Only the HUMAN's messages are chat bubbles (right,
 * accent tint); agent and system output is bare text on the left — no card, no
 * author title (for dispatched agents the raw author is the topic name = the
 * task title, so any label would read like a bogus username; it survives only
 * in the tooltip). System notes are dimmed.
 */
/** One session message with its placement timestamp (from /api/history). */
export interface SessionMsg { role: string; content: string; timestamp: string; thinking?: string }

/**
 * A status transition in the timeline: "chi l'ha spostato e quando", rendered
 * as a thin event row between the speech bubbles (content = "from→to",
 * author = the actor — user, agent name, or dispatcher).
 */
export function StatusEventRow({ comment }: { comment: TaskComment }) {
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

/** Live "ci sta mettendo" ticker for the current run (anchored server-side). */
export function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live ticker: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtLive(ms) : '0s'}</>;
}

/**
 * The slice of agent session between two thread comments — the "reasoning"
 * that produced the reply below it. Collapsed to a thin toggle by default
 * (chat-style thinking block); expands inline, read-only, same markdown
 * renderer as the chat. Renders nothing when the interval holds no messages.
 */
export function SessionSlice({ msgs, label, preview }: {
  msgs: SessionMsg[];
  label?: string;
  /** Live tail of what's streaming NOW — shown on the collapsed block so the
   *  session strip itself answers "come sta andando" at a glance. */
  preview?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Only the AGENT's turns are "passaggi". Human/dispatcher turns injected into
  // the session (your steering, the kickoff envelope) are noise here: your side
  // already shows as comment bubbles in the thread — showing it again as a step
  // is pure duplication. Hide it.
  const steps = msgs.filter((m) => m.role !== 'user');
  if (steps.length === 0 && !preview) return null;
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Comprimi' : 'Mostra i passaggi che la sessione ha fatto qui'}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
      >
        <Footprints className="h-3 w-3 shrink-0" />
        <span>{label ?? 'Passaggi'}{steps.length > 0 && <span className="text-neutral-600"> · {steps.length}</span>}</span>
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
          {steps.map((m, i) => (
            <div key={i} className="space-y-1">
              {/* Coherent with the real chat: assistant thinking renders through
                  the SAME ReasoningRow the topic chat uses, then the prose. */}
              {m.thinking?.trim() && (
                <ReasoningRow content={m.thinking} />
              )}
              {m.content.trim() && (
                <div className="flex gap-1.5 text-xs leading-relaxed">
                  <span className="shrink-0 font-semibold text-neutral-500">⏺</span>
                  <div className={`min-w-0 flex-1 text-neutral-300 ${COMPACT_MD_CLS}`}>
                    <ChatMarkdown components={{}}>{m.content}</ChatMarkdown>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentBubble({ comment, onPreview }: { comment: TaskComment; onPreview?: (path: string) => void }) {
  // Machine-authored review evidence (live-preview screenshot from the verifier).
  // Distinct from human/agent speech: it never woke the agent, it just informs.
  if (comment.kind === 'review-note') {
    return (
      <div className="pr-8">
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5">
          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-400/80">
            <Camera size={11} /> Anteprima
          </p>
          <div className="text-sm text-neutral-200"><CommentBody content={comment.content} /></div>
          <MediaStrip media={comment.media} onPreview={onPreview} />
          <p className="mt-0.5 text-[9px] text-neutral-600">{commentTime(comment.createdAt)}</p>
        </div>
      </div>
    );
  }
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
export function CommentBody({ content }: { content: string }) {
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

export function BoardSettingsPanel({ projectId, settings: s, dispatchOn, models, onToggleDispatch, onChanged, onClose, onError }: {
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
  if (!s) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-white/10 bg-neutral-900/60 px-3 py-2.5 text-xs text-neutral-300">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-neutral-200">Auto-dispatch</span>
        <button onClick={onClose} className="rounded p-0.5 text-neutral-400 hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
      </div>

      <label
        className="flex cursor-pointer items-center justify-between gap-3"
        title="Interruttore globale, vale per tutte le board. Il cap di agent in parallelo si imposta dal ▾ accanto al titolo della board."
      >
        <span>Avvia un agent quando un task entra in <b>Todo</b></span>
        <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
      </label>

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
