import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent as ReactTouchEvent } from 'react';
import { useT } from '../../hooks/useT';
import { NightModeCard } from './NightModeCard';
import { ArrowUpRight, Bot, Camera, Check, ChevronDown, ChevronRight, Clock, Download, ExternalLink, Footprints, GitMerge, Globe, Hourglass, Link2, Lock, Maximize2, Minimize2, MoreHorizontal, Paperclip, Plus, Send, ShieldCheck, ShieldX, Sparkles, Square, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ReasoningRow } from '../Chat/ReasoningRow';
import { Menu } from '../Shared/Menu';
import { ShareControl } from '../Share/ShareControl';
import { Spinner } from '../Shared/Spinner';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { getMediaUrl } from '../../lib/api';
import { isImagePath, isPdfPath, isVideoPath } from '../../lib/mediaKind';
import { openExternalOnce } from '../../lib/openExternal';
import { buildTaskLink } from '../../lib/openTaskLink';
import { enqueueProjectBrowserNavigate } from '../../state/pane/adapters';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { boardApi, STATUS_LABEL, TASK_STATUSES, isAgentWorking, parseQuestionBlock, isProjectlessId, boardDrafts, systemDeliveryNote, attemptHasWork, formatAttemptStat, type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch, type BoardProjectRef, type DiffBundle, type DiffNote, type ReviewCheck, type CheckRun, type TaskAttempt } from '../../lib/board';
import { PreviewMedia } from './PreviewMedia';
import { UnifiedDiff } from './UnifiedDiff';
import { collectTaskMediaPaths } from './taskMedia';
import { formatReviewNotes } from './reviewNotes';
import { COMPACT_MD_CLS, PLAN_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, DISPATCH_CHIP, EFFORTS, FANOUT_CHOICES, mediaPaneIdFor, type TaskSurface } from './constants';
import { friendlyModelLabel, fmtModel, commentTime, fmtMs, fmtLive, fmtTok, fmtUpdatedAt, autoGrow } from './format';
import { StatusIcon, DispatchChip } from './atoms';
import { ProjectPickerBody } from './ProjectPicker';
import { addBoardProject, projectNameFromId, useBoardProjects } from '../../lib/boardProjectsStore';
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

/**
 * Esito dei checks pre-review, accanto ai bottoni di decisione.
 *
 * Non disegna niente quando non sono mai girati: "nessun check" NON è un verde, e
 * una spia verde su una board senza comandi dichiarati sarebbe una bugia che
 * rassicura. Verde = una riga (è evidenza, non un rapporto); rosso = comando,
 * exit code e coda dell'output, cioè quello che serve per capire senza aprire un
 * terminale.
 */
/**
 * "Questo non l'ha consegnato l'agent."
 *
 * Il caso da distinguere: il dispatcher porta in review un task il cui turno è
 * finito senza che l'agent lo consegnasse (tentativi esauriti, o modello che si
 * rifiuta). La card e il drawer erano identici a una consegna vera, e il
 * reviewer scopriva solo aprendo il diff che non c'era niente da vedere. Sta
 * SOPRA i bottoni perché cambia la decisione, non a fondo pagina come una nota.
 */
function SystemDeliveryNotice({ task }: { task: BoardTask }) {
  const tr = useT();
  if (task.deliveredBy !== 'system') return null;
  return (
    <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
      <Hourglass className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.movedToReviewBySystem')}</span>{' '}
        {systemDeliveryNote(task.deliveredReason)}
      </span>
    </div>
  );
}

function ChecksSection({ task }: { task: BoardTask }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  if (!task.checksState) return null;

  if (task.checksState === 'running') {
    return (
      <div className="flex items-center gap-1.5 rounded bg-white/5 px-2 py-1.5 text-[11px] text-app-text-heading">
        <Spinner size="sm" tone="current" className="shrink-0 text-app-text-secondary" />
        Checks pre-review in corso…
      </div>
    );
  }

  const runs = task.checks ?? [];
  const failed = runs.find((r) => !r.ok);
  const short = (r: CheckRun) => r.spawnError ? 'non è partito' : r.timedOut ? 'oltre il tempo massimo' : `exit ${r.code}`;
  const when = task.checksAt ? new Date(task.checksAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;

  if (task.checksState === 'pass') {
    return (
      <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
        <Check className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Checks verdi{when ? ` alle ${when}` : ''}{runs.length ? ` — ${runs.map((r) => r.name).join(', ')}` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded bg-rose-500/10 text-[11px] text-rose-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-white/5"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          Checks ROSSI{when ? ` alle ${when}` : ''}{failed ? ` — ${failed.name} (${short(failed)})` : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {runs.map((r, i) => (
            <div key={i}>
              <div className={r.ok ? 'text-emerald-300' : 'text-rose-200'}>
                {r.ok ? '✓' : '✗'} <code className="font-mono">{r.cmd}</code>{r.ok ? '' : ` — ${short(r)}`}
              </div>
              {!r.ok && (r.tail || r.spawnError) && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1.5 font-mono text-[10px] leading-snug text-app-text-heading">
                  {r.spawnError ?? r.tail}
                </pre>
              )}
            </div>
          ))}
          <p className="text-app-text-secondary">
            La strada normale è <b>{tr('board.task.reject')}</b>: l'agent riparte con questo output. Approvare qui significa accettarlo rosso.
          </p>
        </div>
      )}
    </div>
  );
}

/** Collapsible "Modifiche" panel in the task drawer: the unified diff of what
 *  the task's dispatched agent changed in its isolated worktree, so a reviewer
 *  can see the actual changes before approving. Renders NOTHING when there's no
 *  worktree or the diff is empty ("non mostrare modifiche se non ci sono") — it
 *  probes eagerly and owns its own section chrome so an unchanged task shows no
 *  bar at all. */
export function TaskChangesSection({ projectId, taskId, bump, onSent }: {
  projectId: string; taskId: string; bump?: string | number;
  /** Le note sono partite come commento: il thread ha una riga in più. */
  onSent?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiffBundle | 'loading' | 'error' | null>(null);
  const [notes, setNotes] = useState<DiffNote[]>([]);
  const [sendingNotes, setSendingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesLoaded = useRef(false);
  const fetchDiff = useCallback(() => {
    setState('loading');
    boardApi.taskDiff(projectId, taskId).then(setState).catch(() => setState('error'));
  }, [projectId, taskId]);
  // Eager (not lazy): visibility depends on whether the worktree has changes, so
  // we must probe up-front. Re-runs when the task advances (bump) — the agent
  // may have committed more.
  useEffect(() => { fetchDiff(); }, [fetchDiff, bump]);
  // Bozza di revisione dal server: una nota scritta e non ancora spedita è
  // lavoro, e sopravvive a reload e hot-reload come la bozza del commento.
  useEffect(() => {
    notesLoaded.current = false;
    let alive = true;
    boardDrafts.getReviewNotes(taskId).then((n) => {
      if (!alive) return;
      setNotes((cur) => (cur.length ? cur : n));
      notesLoaded.current = true;
      // Con note in sospeso la sezione si apre da sé: altrimenti l'unica traccia
      // di quel lavoro sta dietro una barra chiusa.
      if (n.length) setOpen(true);
    }).catch(() => { notesLoaded.current = true; });
    return () => { alive = false; };
  }, [taskId]);
  useEffect(() => {
    if (notesLoaded.current) boardDrafts.putReviewNotes(taskId, notes);
  }, [notes, taskId]);

  const review = useMemo(() => ({
    notes,
    onAddNote: (n: Omit<DiffNote, 'id'>) =>
      setNotes((cur) => [...cur, { ...n, id: `${Date.now().toString(36)}-${cur.length}` }]),
    onRemoveNote: (id: string) => setNotes((cur) => cur.filter((n) => n.id !== id)),
  }), [notes]);

  // UN commento per tutta la revisione: su un task in review ogni commento fa
  // reject-with-text e risveglia l'agente (server/routes/tasks.ts), quindi una
  // nota per volta sarebbe un turno buttato per nota.
  const sendNotes = async () => {
    if (!notes.length || sendingNotes) return;
    setSendingNotes(true);
    setNotesError(null);
    try {
      await boardApi.comment(projectId, taskId, formatReviewNotes(notes));
      setNotes([]);
      onSent?.();
    } catch (e) {
      // Le note NON si svuotano: sono lavoro scritto a mano, e un invio fallito
      // in silenzio (barra ferma, nessun motivo) è il modo migliore per farle
      // scartare per sfinimento.
      setNotesError(e instanceof Error ? e.message : 'invio fallito');
    } finally { setSendingNotes(false); }
  };

  const bundle = state && typeof state === 'object' ? state : null;
  const fileCount = bundle && bundle.code !== 'no_worktree' ? bundle.stat.length : 0;
  // Nothing to show → nothing at all (no empty bar): still probing, errored, no
  // worktree, or a zero-file diff.
  if (!bundle || bundle.code === 'no_worktree' || fileCount === 0) return null;
  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <button onClick={() => setOpen((s) => !s)} className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Modifiche <span className="normal-case tracking-normal text-app-text-faint">· {fileCount} file</span>
        {notes.length > 0 && (
          <span className="ml-1 rounded bg-indigo-500/20 px-1 text-[9px] normal-case tracking-normal text-indigo-300">
            {notes.length} in sospeso
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="mt-1.5 max-h-[42vh] overflow-y-auto">
            <UnifiedDiff bundle={bundle} defaultOpenFirst review={review} />
          </div>
          {notes.length > 0 && (
            <div className="mt-1.5 flex items-center gap-2 rounded border border-indigo-500/25 bg-indigo-500/5 px-2 py-1.5">
              <span className="min-w-0 flex-1 text-[11px] text-app-text-heading">
                {notesError
                  ? <span className="text-rose-300">Invio fallito: {notesError} — le note sono ancora qui, riprova.</span>
                  : <>{notes.length} {notes.length === 1 ? 'commento' : 'commenti'} sul diff, non ancora inviati</>}
              </span>
              <button
                onClick={() => setNotes([])}
                disabled={sendingNotes}
                className="rounded px-2 py-0.5 text-[11px] text-app-text-secondary hover:text-app-text disabled:opacity-40"
              >
                Scarta
              </button>
              <button
                onClick={sendNotes}
                disabled={sendingNotes}
                className="flex items-center gap-1 rounded bg-indigo-500/25 px-2 py-0.5 text-[11px] text-indigo-100 hover:bg-indigo-500/40 disabled:opacity-40"
              >
                {sendingNotes ? <Spinner size="sm" tone="current" /> : <Send className="h-3 w-3" />}
                Invia all'agente
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Tentativi" — il confronto del fan-out, e il posto dove si sceglie il vincitore.
 *
 * Disegna qualcosa SOLO quando i tentativi sono più di uno: un task dispatchato
 * normalmente non ha righe `task_attempts` e questa sezione non esiste per lui.
 *
 * Niente punteggio e niente ordinamento "per merito": il diffstat sta accanto a
 * ogni tentativo perché è un fatto, non un voto — mettere in cima "il più
 * piccolo" o "il più veloce" darebbe a un numero l'autorità di una scelta che è
 * di merito. Restano in ordine di lancio; la scelta è un click umano, e il modo
 * onesto di farla è aprire i due diff.
 */
export function TaskAttemptsSection({ projectId, taskId, bump, onChanged, onOpenTopic }: {
  projectId: string; taskId: string; bump?: string | number;
  onChanged: () => void;
  onOpenTopic?: (topicId: string) => void;
}) {
  const tr = useT();
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    boardApi.attempts(projectId, taskId)
      .then((a) => { if (alive) setAttempts(a); })
      .catch(() => { /* nessun tentativo, nessuna sezione */ });
    return () => { alive = false; };
  }, [projectId, taskId, bump]);

  const pick = async (attemptId: string) => {
    if (picking) return;
    setPicking(attemptId);
    setError(null);
    try {
      const res = await boardApi.selectAttempt(projectId, taskId, attemptId);
      setAttempts(res.attempts);
      setOpenDiff(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'scelta fallita');
    } finally { setPicking(null); }
  };

  if (attempts.length < 2) return null;
  const decided = attempts.some((a) => a.state === 'selected');
  const running = attempts.filter((a) => a.state === 'running').length;

  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
        Tentativi <span className="normal-case tracking-normal text-app-text-faint">· {attempts.length} in parallelo</span>
        {running > 0 && (
          <span className="ml-1 flex items-center gap-1 rounded bg-amber-500/15 px-1 text-[9px] normal-case tracking-normal text-amber-300">
            <Spinner size="xs" tone="current" /> {running} in corso
          </span>
        )}
      </div>
      {!decided && running === 0 && (
        <p className="mt-1 text-[11px] text-app-text-secondary">
          Scegline uno: il task prende il suo branch, gli altri (worktree e chat) vengono buttati.
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}
      <div className="mt-1.5 space-y-1.5">
        {attempts.map((a) => {
          const won = a.state === 'selected';
          const dead = a.state === 'discarded';
          const work = attemptHasWork(a);
          return (
            <div
              key={a.id}
              data-testid={`task-attempt-${a.idx}`}
              className={`rounded border px-2 py-1.5 ${
                won ? 'border-emerald-500/40 bg-emerald-500/5' : dead ? 'border-app-border-subtle bg-white/[0.02] opacity-50' : 'border-app-border bg-white/[0.03]'
              }`}
            >
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="font-medium text-app-text">Tentativo {a.idx}</span>
                {won && <span className="rounded bg-emerald-500/25 px-1 text-[9px] text-emerald-200">scelto</span>}
                {dead && <span className="rounded bg-white/10 px-1 text-[9px] text-app-text-secondary">scartato</span>}
                <span className="text-app-text-muted">{formatAttemptStat(a)}</span>
                {a.branch && <span className="truncate font-mono text-[10px] text-app-text-faint">{a.branch}</span>}
              </div>
              {a.summary && (
                <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-[11px] leading-snug text-app-text-heading">{a.summary}</p>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                {work && (
                  <button
                    onClick={() => setOpenDiff((cur) => (cur === a.id ? null : a.id))}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-heading hover:bg-white/10"
                  >{openDiff === a.id ? 'Chiudi il diff' : 'Vedi il diff'}</button>
                )}
                {a.topicId && onOpenTopic && !dead && (
                  <button
                    onClick={() => onOpenTopic(a.topicId!)}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-heading hover:bg-white/10"
                  >{tr('board.task.openChat')}</button>
                )}
                {!decided && running === 0 && a.topicId && (
                  <button
                    onClick={() => pick(a.id)}
                    disabled={!!picking}
                    data-testid="task-attempt-pick"
                    title={work ? undefined : "Questo tentativo non ha modificato niente: tenerlo significa consegnare un branch vuoto."}
                    className="ml-auto flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {picking === a.id && <Spinner size="sm" tone="current" />} Scegli questo
                  </button>
                )}
              </div>
              {openDiff === a.id && (
                <AttemptDiff key={`${projectId}:${taskId}:${a.id}`} projectId={projectId} taskId={taskId} attemptId={a.id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Il diff di UN tentativo, caricato solo quando lo si apre (N diff insieme
 *  sarebbero N bundle in memoria per una scelta che se ne guarda uno per volta).
 *  Montato con `key` sul tentativo: cambiare bersaglio RIMONTA, così lo stato
 *  riparte da 'loading' senza un setState dentro l'effetto (che sarebbe un
 *  render a cascata — e il lint lo rifiuta, giustamente). */
function AttemptDiff({ projectId, taskId, attemptId }: { projectId: string; taskId: string; attemptId: string }) {
  const tr = useT();
  const [state, setState] = useState<DiffBundle | 'loading' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    boardApi.taskDiff(projectId, taskId, attemptId)
      .then((b) => { if (alive) setState(b); })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [projectId, taskId, attemptId]);
  if (state === 'loading') return <div className="mt-1.5 flex items-center gap-1 text-[11px] text-app-text-muted"><Spinner size="sm" tone="current" /> {tr('board.task.loadingDiff')}</div>;
  if (state === 'error') return <p className="mt-1.5 text-[11px] text-rose-300">{tr('board.task.diffUnreadable')}</p>;
  if (state.code === 'no_worktree' || state.stat.length === 0) return <p className="mt-1.5 text-[11px] text-app-text-muted">{tr('board.task.noChanges')}</p>;
  return (
    <div className="mt-1.5 max-h-[38vh] overflow-y-auto">
      <UnifiedDiff bundle={state} defaultOpenFirst />
    </div>
  );
}

// ── Detail: drawer by default, expandable review surface ────────────────────

export function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic, focusPaneId }: {
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
  /**
   * Tab del task da mettere davanti all'apertura (`media:<path>`): la chiede
   * chi ha aperto il drawer con un gesto MIRATO — il bottone «apri in una tab»
   * sull'anteprima della card. Senza, si apre sul Thread come sempre.
   */
  focusPaneId?: string;
}) {
  const tr = useT();
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
  //
  // `previewImage` viene PRIMA ed è parte della lista: è l'evidenza principale
  // della consegna e l'agente la imposta con `update_task(previewImage=…)`, non
  // allegandola a un commento — partendo dai soli media dei commenti era quindi
  // l'unico artefatto del task SENZA una sua tab. Stando qui la ottiene gratis,
  // come ogni altro allegato.
  const mediaPaths = useMemo(
    () => collectTaskMediaPaths(task?.previewImage, comments),
    [comments, task?.previewImage],
  );
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
  const decide = async (decision: 'approve' | 'reject', opts?: { force?: boolean }) => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.review(projectId, taskId, decision, undefined, opts); setError(null); await load(); onChanged(); }
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
  const [projBusy, setProjBusy] = useState(false);

  // Eager, not lazy: the chip needs the real path for its favicon (and an
  // accurate label) the moment the drawer opens, not only after the user
  // clicks "Sposta su…" once. Dallo store condiviso: era una quarta fetch
  // dello STESSO indice, con l'icona che arrivava in un momento diverso da
  // quello del composer e delle card.
  const projects = useBoardProjects();
  const openProjMenu = () => setProjMenuOpen(true);
  const currentProject = projects?.find((p) => p.projectId === task?.projectId) ?? null;
  const projectLabel = task && isProjectlessId(task.projectId)
    ? 'Nessun progetto'
    : currentProject?.name ?? (task ? projectNameFromId(task.projectId) : '');
  const moveBlocked = !task ? null
    : task.parentTaskId ? 'I sottotask si spostano col loro task padre.'
    : task.assignedTopicId || isAgentWorking(task.dispatchState)
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
      addBoardProject(created); // entra nell'indice per OGNI superficie, non solo qui
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
  const agentBusy = !!task && isAgentWorking(task.dispatchState);

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
        {comments.length === 0 && !task.assignedTopicId && <p className="text-xs text-app-text-muted">{tr('board.task.noComments')}</p>}
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
                <span className="ml-1.5 text-[11px] text-app-text-secondary">
                  {task.dispatchState === 'queued' ? tr('board.task.dispatch.queued') : task.dispatchState === 'starting' ? tr('board.task.dispatch.starting') : tr('board.task.dispatch.working')}
                  {task.inProgressAt && task.dispatchState === 'working' && (
                    <span className="text-app-text-muted"> <Ticker since={task.inProgressAt} /></span>
                  )}
                </span>
              </div>
              <button
                disabled={busy} onClick={stopAgent}
                title={tr('board.task.stopAgentTitle')}
                className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
              >{busy ? <Spinner size="sm" tone="current" /> : <Square className="h-3 w-3 fill-current" />} {tr('board.task.stopAgent')}</button>
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
  // Apertura mirata. Va riprovata: al primo render i commenti (e quindi i media,
  // e quindi le pane) non sono ancora arrivati, perciò `focusPane` fallisce e
  // basta. Il ref si azzera solo quando la pane c'è davvero ed è stata attivata,
  // così il gesto dell'utente non si perde nel buco tra mount e fetch — e non si
  // ripete più dopo, altrimenti riporterebbe l'anteprima davanti a ogni nuovo
  // commento mentre stai leggendo il thread.
  const pendingFocusRef = useRef<string | null>(focusPaneId ?? null);
  useEffect(() => {
    const wanted = pendingFocusRef.current;
    if (!wanted) return;
    if (browser.focusPane(wanted)) pendingFocusRef.current = null;
  }, [browser]);
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
      className={`glass-surface flex flex-col border-app-border ${swiping ? '' : 'transition-transform duration-200'} absolute inset-0 z-40 w-full lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l ${
        wide ? 'lg:w-[min(64rem,72%)] lg:shadow-2xl' : 'lg:w-96 lg:max-w-[75%]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-3 py-2.5">
        {/* Topbar = slim window-chrome row: the status selector on the left,
            window actions on the right. Everything else — project eyebrow,
            title + dispatch state, and the attribute chips — lives in the
            content block below, laid out exactly like the Kanban card. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <button
          ref={statusBtnRef}
          onClick={() => task && setStatusMenuOpen(true)}
          data-testid="task-status-chip"
          title={tr('board.task.changeStatusTitle')}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-app-text-heading hover:bg-white/10"
        >
          {task ? <StatusIcon status={task.status} /> : <Spinner size="sm" tone="current" />}
          {task ? STATUS_LABEL[task.status] : tr('board.task.loading')}
          <ChevronDown className="h-3 w-3 text-app-text-faint" />
        </button>
        {/* Condividere sta accanto allo STATO, non dentro un menù: è una
            proprietà della scheda come lo stato, e nasconderla in un
            sottomenù avrebbe reso invisibile l'unica cosa che rende utile
            l'identità costruita sotto. */}
        {task && <ShareControl resourceType="task" resourceId={task.id} />}
        <Menu open={statusMenuOpen} anchorRef={statusBtnRef} onClose={() => setStatusMenuOpen(false)} minWidth={170} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.moveTo')}</p>
          {TASK_STATUSES.map((s) => (
            <button
              key={s} role="option" aria-selected={s === task?.status}
              disabled={busy}
              onClick={() => changeStatus(s)}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
            >
              <StatusIcon status={s} />
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
              title={tr('board.task.optionsTitle')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            ><MoreHorizontal className="h-4 w-4" /></button>
          )}
          {task && (
            <Menu open={optionsMenuOpen} anchorRef={optionsBtnRef} onClose={() => setOptionsMenuOpen(false)} align="right" minWidth={240}>
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.options')}</p>
              <button
                role="menuitem" disabled={busy} onClick={togglePlanFirst}
                title="L'agent consegna un piano da approvare PRIMA di implementare"
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                <span className="min-w-0 flex-1">{tr('board.task.planFirst')}</span>
                {task.planFirst && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); openBlockerMenu(); }}
                className={POPOVER_ITEM}
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{blockerTask ? tr('board.task.blockedByText', { text: blockerTask.text }) : tr('board.task.blockedBy')}</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />
              </button>
              {task.blockedByTaskId && (
                <button
                  role="menuitem" disabled={busy} onClick={toggleReuseContext}
                  title={tr('board.task.reuseBlockerTitle')}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                  <span className="min-w-0 flex-1">{tr('board.task.reuseBlockerContext')}</span>
                  {task.reuseBlockerContext && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              )}
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); setSubtasksOpen(true); setSubtaskComposerOpen(true); }}
                className={POPOVER_ITEM}
              ><Plus className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" /> {tr('board.task.addSubtask')}</button>
            </Menu>
          )}
          {task && (
            <button
              onClick={copyLink}
              data-testid="task-copy-link"
              title={copied ? 'Link copiato' : 'Copia il link al task (deep-link apribile, per debug/condivisione)'}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            >{copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Link2 className="h-4 w-4" />}</button>
          )}
          {task?.assignedTopicId && onOpenTopic && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              data-testid="task-open-session-tab"
              title={tr('board.task.openSessionTabTitle')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            ><ArrowUpRight className="h-4 w-4" /></button>
          )}
          {task?.outputUrl && (
            <button
              onClick={openInWorkspace}
              data-testid="task-open-in-workspace"
              title={tr('board.task.openResultWorkspaceTitle')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            ><Globe className="h-4 w-4" /></button>
          )}
          {/* Espandi/riduci ha senso solo sul side-panel desktop: su mobile il
              drawer è già full-screen, quindi il toggle è nascosto (<lg). */}
          <button
            onClick={toggleWide}
            title={wide ? 'Riduci il drawer (vedi la board)' : 'Allarga il drawer (più spazio per il tiling)'}
            className="hidden rounded p-1.5 text-app-text-secondary hover:bg-white/10 lg:block"
          >{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          <button aria-label={tr('board.task.closeDetail')} onClick={onClose} className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          <span>{error}</span>
          <button aria-label={tr('board.task.closeError')} onClick={() => setError(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* Verdetto dell'audit di landing: un task chiuso il cui lavoro non è su
          main. Sta QUI, in cima al drawer, e non solo come commento nel thread —
          il commento si perde, la banda no. */}
      {task?.status === 'done' && task.landingState === 'unlanded' && (
        <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          ⚠️ Chiuso ma <strong>{tr('board.task.notOnMain')}</strong>: il commit consegnato
          {task.deliveryCommit ? <> <code className="rounded bg-black/30 px-1">{task.deliveryCommit.slice(0, 8)}</code></> : null}
          {task.deliveryBranch ? <> (branch <code className="rounded bg-black/30 px-1">{task.deliveryBranch}</code>)</> : null}
          {' '}non risulta nel contenuto di main. Landa il branch, o recupera il commit prima che venga potato.
        </div>
      )}
      {!task ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="md" tone="current" className="text-app-text-muted" />
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
          <div className="border-b border-app-border px-3 py-3">
            {task?.parentTaskId && onOpenTask && (
              <button
                onClick={() => onOpenTask(task.parentTaskId!)}
                className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
              >⤴ {tr('board.task.parentTask')}</button>
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
                  title={tr('board.task.projectChipTitle', { label: projectLabel })}
                  className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-app-text-secondary hover:text-app-text"
                >
                  <ProjectFavicon path={currentProject?.path ?? ''} size={14} className="shrink-0" fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />} />
                  <span className="min-w-0 truncate font-medium">{projectLabel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
                </button>
                {(task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
                  <DispatchChip state={task.dispatchState} error={task.dispatchError} />
                ) : (!task.dispatchState && task.dispatchError) ? (
                  <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300" title={task.dispatchError}>{tr('board.task.stopped')}</span>
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
                listLabel={tr('board.task.moveProjectTo')}
                headerNote={moveBlocked ? <p className="px-2.5 pb-1 text-[10px] leading-snug text-amber-300/90">{moveBlocked}</p> : undefined}
              />
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem" disabled={!currentProject}
                onClick={doOpenProject}
                title={currentProject ? tr('board.task.openProjectWindow', { name: currentProject.name }) : tr('board.task.projectUnresolvable')}
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              ><ArrowUpRight className="h-3.5 w-3.5" /> {tr('board.task.openProject')}</button>
            </Menu>
            {/* Title — FULL width (the dispatch state moved up to the project
                eyebrow row, so nothing competes with it here). */}
            {editingTitle ? (
              <textarea
                autoFocus value={titleDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setTitleDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveTitle}
                onKeyDown={(e) => { cancelKey(e); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTitle(); } }}
                className="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded bg-white/5 px-1.5 py-1 text-sm leading-5 text-app-text outline-none"
              />
            ) : (
              <p
                onClick={() => { if (task) { setTitleDraft(task.text); setEditingTitle(true); } }}
                title={tr('board.task.editTitleTitle')}
                className="-mx-1.5 cursor-text rounded px-1.5 py-1 text-sm leading-5 text-app-text hover:bg-white/5"
              >{task?.text}</p>
            )}
            {/* Meta row — compact chips that wrap, card-style: priorità,
                modello · ⏱ effort (UN chip, come la card), piano-prima,
                blocked-by + reuse. Editable selectors keep their portaled Menus. */}
            {task && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className="flex items-center gap-1 text-[11px] text-app-text-muted"
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
                    !task.priorityAuto && task.priority >= 3 ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
                  {task.priorityAuto ? tr('board.task.priorityAuto') : PRIORITY_LABEL[task.priority] ?? 'Media'}
                  <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
                </button>
                <Menu open={prioMenuOpen} anchorRef={prioBtnRef} onClose={() => setPrioMenuOpen(false)} minWidth={160} role="listbox">
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.priority')}</p>
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
                  className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/20"
                >
                  <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
                  <span className="truncate">{task.model ? fmtModel(task.model) : 'Auto'}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}`}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
                </button>
                <Menu open={modelMenuOpen} anchorRef={modelBtnRef} onClose={() => setModelMenuOpen(false)} minWidth={200} role="listbox">
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.agentModel')}</p>
                  <button
                    role="option" aria-selected={!task?.model} disabled={busy}
                    onClick={() => changeModel(null)}
                    className={`${POPOVER_ITEM} disabled:opacity-40`}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                    <span className="min-w-0 flex-1">Auto <span className="text-app-text-muted">(opus-first)</span></span>
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
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.blockedBy')}</p>
                  <button
                    role="option" aria-selected={!task.blockedByTaskId}
                    onClick={() => pickBlocker(null)}
                    className={POPOVER_ITEM}
                  >
                    <span className="min-w-0 flex-1">{tr('common.none')}</span>
                    {!task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                  </button>
                  <div className="max-h-52 overflow-y-auto">
                    {boardTasks === null ? (
                      <div className="flex items-center justify-center py-3"><Spinner size="md" tone="current" className="text-app-text-muted" /></div>
                    ) : blockerCandidates.length === 0 ? (
                      <p className="px-2.5 py-2 text-xs text-app-text-muted">{tr('board.task.noOtherTasks')}</p>
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
          <div className="shrink-0 border-b border-app-border px-3 py-2">
            {editingDesc ? (
              <textarea
                autoFocus value={descDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setDescDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveDesc}
                onKeyDown={cancelKey}
                placeholder={tr('board.task.descPlaceholder')}
                className="block w-full resize-none overflow-hidden rounded bg-white/5 px-1.5 py-0.5 text-sm leading-5 text-app-text-heading outline-none"
              />
            ) : task?.description ? (
              <>
                <button
                  onClick={toggleDescOpen}
                  className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
                >
                  {descOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {tr('board.task.descLabel')}
                </button>
                {descOpen && (
                  <div
                    onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
                    title={tr('board.task.editDescTitle')}
                    className={`mt-1.5 cursor-text rounded px-1.5 py-0.5 text-sm leading-5 text-app-text-heading hover:bg-white/5 ${COMPACT_MD_CLS}`}
                  ><ChatMarkdown components={{}}>{task.description}</ChatMarkdown></div>
                )}
              </>
            ) : (
              <button
                onClick={() => { setDescDraft(''); setEditingDesc(true); }}
                className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-faint hover:text-app-text-secondary"
              >{tr('board.task.addDesc')}</button>
            )}
            {/* Anteprima della consegna anche nel drawer (non solo sulla card):
                intera, object-contain — il reviewer deve poter vedere TUTTO lo
                screenshot.

                È lo STESSO componente della card (`PreviewMedia`), non più un
                <img> scritto a mano: da qui il click apre il lightbox dentro
                l'app — prima usciva in una finestra esterna, perdendo il thread
                (e dentro il WKWebView di Tauri spesso non apriva niente) — e un
                video è un <video> coi controlli invece di un'icona rotta.

                In hover, il bottone «apri in una tab» porta l'anteprima
                accanto a Thread: il lightbox serve a guardare, la tab a
                lavorarci mentre leggi il resto. La tab esiste perché
                `previewImage` sta in `mediaPaths`. */}
            {task?.previewImage && (
              <PreviewMedia
                path={task.previewImage}
                variant="drawer"
                onOpenTab={() => browser.focusPane(mediaPaneIdFor(task.previewImage!))}
              />
            )}
            {/* File consegnati: ogni artefatto (screenshot/video/PDF) è
                polimorfo — click sul nome lo apre come TAB nel workspace del
                task, l'icona lo SCARICA. Rimpiazza l'idea di "output" a parte:
                il risultato è tab + lista scaricabili. */}
            {mediaPaths.length > 0 && (
              <div className="mt-3" data-testid="task-downloads">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-faint">{tr('board.task.deliveredFiles')}</div>
                <ul className="flex flex-col gap-1">
                  {mediaPaths.map((p) => {
                    const name = p.split('/').pop() || p;
                    return (
                      <li key={p} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-xs text-app-text-heading">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                        <button
                          type="button"
                          onClick={() => browser.focusPane(mediaPaneIdFor(p))}
                          title={tr('board.task.openAsTabTitle')}
                          className="min-w-0 flex-1 truncate text-left hover:text-white"
                        >{name}</button>
                        <a
                          href={getMediaUrl(p)}
                          download={name}
                          title={tr('board.task.downloadFileTitle')}
                          className="shrink-0 rounded p-1 text-app-text-secondary hover:bg-white/10 hover:text-white"
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
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-app-border px-3 py-2 scrollbar-topbar" data-testid="task-browser-previews">
              {browser.parkedTabs.map((t) => {
                const label = t.title || hostLabel(t.url) || tr('board.task.newTab');
                return (
                  <div
                    key={t.contextId}
                    className="group/prev flex shrink-0 items-center rounded-md border border-app-border bg-white/[0.02] text-xs text-app-text-muted"
                  >
                    <button
                      onClick={() => browser.reopenTab(t.contextId)}
                      title={tr('board.task.reopenTabTitle')}
                      className="flex items-center gap-1.5 px-2 py-1"
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{label}</span>
                      <span className="text-[9px] uppercase tracking-wide text-app-text-faint">{tr('board.task.closedTab')}</span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); browser.removeTab(t.contextId); }}
                      title={tr('board.task.removeTabTitle')}
                      className="mr-1 rounded p-0.5 text-app-text-muted opacity-0 hover:bg-white/10 hover:text-app-text group-hover/prev:opacity-100"
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
          <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-app-border px-3 py-2" data-testid="task-detail-subtasks">
            <button
              onClick={toggleSubtasksOpen}
              className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
            >
              {subtasksOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {tr('board.task.subtasksLabel')}{children.length > 0 ? ` · ${doneCount}/${children.length}` : ''}
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
                    placeholder={tr('board.task.addSubtaskPlaceholder')}
                    className="w-full rounded bg-white/5 px-2 py-1 text-xs text-app-text outline-none placeholder:text-app-placeholder disabled:opacity-60"
                  />
                  {addingSub && <Spinner size="sm" tone="current" className="absolute right-1.5 top-1.5 text-app-text-secondary" />}
                </div>
              </div>
            )}
          </div>
          )}
          {/* "Modifiche" (worktree diff) lives HERE — above the body, OUT of the
              chat composer area ("sopra la chat era fastidioso"). It renders
              NOTHING when there's no worktree / an empty diff (owns its own
              section chrome), so an unchanged task shows no "Modifiche" bar. */}
          {/* "Tentativi" sta SOPRA "Modifiche" perché finché il vincitore non è
              scelto il diff del task è quello del tentativo 1 — che può non
              essere quello che si tiene. Prima si sceglie, poi si revisiona. */}
          <TaskAttemptsSection projectId={projectId} taskId={taskId} bump={bump} onChanged={onChanged} onOpenTopic={onOpenTopic} />
          {task.assignedTopicId && <TaskChangesSection projectId={projectId} taskId={taskId} bump={bump} onSent={onChanged} />}
          {/* "Spazio di lavoro" — the task's ONE GroupLayout (Thread + browser
              tabs + Piano + media, the app's real PaneTabBar). Collapsible like
              the other sections: the tab bar sits UNDER this label. Default open;
              when collapsed the panes hide and a flex spacer keeps the composer
              pinned to the bottom. */}
          <div className={`flex min-w-0 flex-col ${workspaceOpen ? 'min-h-0 flex-1' : 'shrink-0'}`}>
            <button
              onClick={toggleWorkspaceOpen}
              className="flex w-full shrink-0 items-center gap-1 border-b border-app-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
            >
              {workspaceOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {tr('board.task.workspaceLabel')}
            </button>
            {workspaceOpen && (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
                <GroupLayout {...browser.groupLayoutProps} />
              </div>
            )}
          </div>
          {!workspaceOpen && <div className="flex-1" />}
          <div className="border-t border-app-border p-2">
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
                        className="rounded bg-white/10 px-2 py-1 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                      >{opt}</button>
                    ))}
                  </div>
                )}
                {/* L'evidenza sta ATTACCATA alla decisione: il gate rifiuta un
                    approve coi checks rossi, e scoprirlo da un 409 dopo il click
                    sarebbe farsi spiegare da un errore quello che si poteva vedere. */}
                <SystemDeliveryNotice task={task} />
                <ChecksSection task={task} />
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={busy} onClick={() => decide('approve', { force: task.checksState === 'fail' })}
                    title={task.checksState === 'fail'
                      ? tr('board.task.approveFailTitle')
                      : tr('board.task.approveTitle')}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                      task.checksState === 'fail'
                        ? 'bg-amber-600/80 hover:bg-amber-600'
                        : 'bg-emerald-500/80 hover:bg-emerald-500'
                    }`}
                  >{busy ? <Spinner size="sm" tone="current" /> : <ShieldCheck className="h-3.5 w-3.5" />} {task.checksState === 'fail' ? tr('board.task.approveAnyway') : tr('board.task.approve')}</button>
                  <button
                    disabled={busy} onClick={() => decide('reject')}
                    title={isAgentReview ? tr('board.task.rejectTitle') : tr('board.task.reject')}
                    className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                  ><ShieldX className="h-3.5 w-3.5" /> {tr('board.task.reject')}</button>
                </div>
                {/* Explicit landing — accept + merge the branch on main (local, no
                    push, build server-side). Separate from Approva by design: the
                    merge no longer rides "da sotto" on an approve. */}
                {isAgentReview && (
                  <button
                    disabled={busy} onClick={doLand}
                    title={tr('board.task.landTitle')}
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-sky-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  ><GitMerge className="h-3.5 w-3.5" /> {tr('board.task.landOnMain')}</button>
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
                      <span className="flex max-w-[10rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-app-text-heading">
                        <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.name}</span>
                      </span>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                      title={tr('board.task.removeAttachmentTitle')}
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-elevated p-0.5 text-app-text group-hover/att:block"
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
                title={tr('board.task.attachFileTitle')}
                className="rounded p-1.5 text-app-text-secondary hover:bg-white/10 disabled:opacity-40"
              >{uploading ? <Spinner size="md" tone="current" /> : <Paperclip className="h-4 w-4" />}</button>
              <textarea
                ref={commentRef}
                value={draft} onChange={(e) => { setDraft(e.target.value); saveCommentCursor(); }} rows={1}
                onSelect={saveCommentCursor} onKeyUp={saveCommentCursor} onClick={saveCommentCursor}
                onFocus={() => markActiveComposer(commentCursorKey)}
                placeholder={isAgentReview ? tr('board.task.replyPlaceholder') : agentBusy ? tr('board.task.steerPlaceholder') : tr('board.task.commentPlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                onPaste={(e) => {
                  const imgs = Array.from(e.clipboardData?.items ?? [])
                    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                    .map((i) => i.getAsFile()).filter((f): f is File => !!f);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-app-text outline-none"
              />
              <button
                onClick={send} disabled={sending || (!draft.trim() && attachments.length === 0)}
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : agentBusy ? "Invia all'agent — lo riceve al prossimo turno (come Claude Code)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview || agentBusy ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Spinner size="md" tone="current" /> : <Send className="h-4 w-4" />}</button>
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
  const tr = useT();
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
          <button onClick={toggle} className="shrink-0 text-app-text-muted hover:text-app-text-heading" title={open ? 'Chiudi' : 'Espandi'}>
            <ChevronRight className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
        <span title={STATUS_LABEL[node.status]} className="flex shrink-0">
          <StatusIcon status={node.status} />
        </span>
        {openable ? (
          <button
            onClick={() => onOpenTask?.(node.id)}
            title={tr('board.task.openSubtaskTitle')}
            className={`min-w-0 flex-1 truncate text-left text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-secondary'}`}>{node.text}</span>
        )}
        {hasKids && <span className="shrink-0 text-[10px] text-app-text-muted">↳ {node.subtaskDoneCount}/{node.subtaskCount}</span>}
      </div>
      {open && kids?.map((k) => (
        <SubtaskNode key={k.id} projectId={projectId} node={k} depth={depth + 1} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

/**
 * Renders one LIGHT task surface full-height (media viewer / plan). The browser
 * group is NOT handled here — it renders through the app's real GroupLayout
 * engine (see useTaskBrowserGroupLayout), placed directly by TaskDetail. The
 * caller places this inside a flex-col so flex-1 children fill.
 */
export function SurfaceContent({ surface, taskId }: { surface: TaskSurface; taskId?: string }) {
  const tr = useT();
  void taskId;
  if (surface.kind === 'media') return <MediaViewer key={surface.url} url={surface.url} path={surface.path} />;
  if (surface.kind === 'browser') return null; // handled by GroupLayout in TaskDetail
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 px-4 py-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">{tr('board.task.proposedPlan')}</p>
        <div className={`text-sm text-app-text ${PLAN_MD_CLS}`}>
          <ChatMarkdown components={{}}>{surface.content}</ChatMarkdown>
        </div>
      </div>
    </div>
  );
}

/**
 * Viewer for OUR /api/media files (allowlisted attachments): image inline,
 * PDF in a NON-sandboxed frame — the sandbox blocks WKWebView's native PDF
 * viewer (blank white pane). These are static files this server serves, not
 * agent-controlled web pages: the URL-sandbox rationale doesn't apply.
 */
export function MediaViewer({ url, path }: { url: string; path: string }) {
  const tr = useT();
  const isImg = isImagePath(path);
  const isPdf = isPdfPath(path);
  // Una clip di review è un artefatto di prima classe come lo screenshot: prima
  // cadeva nel ramo «Nessuna anteprima per questo tipo di file» e per guardarla
  // dovevi uscire dall'app. Controlli sì (si scorre), niente autoplay: la tab
  // l'hai aperta tu, parte quando vuoi tu.
  if (isVideoPath(path)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-app-inset p-3">
        <video src={url} controls playsInline preload="metadata" className="max-h-full max-w-full rounded" />
      </div>
    );
  }
  if (isImg) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-app-inset p-3">
        <img src={url} alt="" className="mx-auto max-w-full rounded" />
      </div>
    );
  }
  if (isPdf) {
    return <iframe src={url} title={tr('board.task.pdfPreviewTitle')} className="min-h-0 w-full flex-1 border-0 bg-white" />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm text-app-text-secondary">{tr('board.task.noPreviewForType')}</p>
      <button
        onClick={() => openExternalOnce(url)}
        className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20"
      ><ExternalLink className="h-3.5 w-3.5" /> {tr('board.task.openInBrowser')}</button>
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
          className="flex max-w-[14rem] items-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-xs text-app-text hover:bg-white/20"
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
      className="flex items-center gap-1.5 px-1 text-[11px] text-app-text-muted"
      title={`${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} /> : <span className="h-1 w-1 shrink-0 rounded-full bg-app-text-faint" />}
      <span className="min-w-0 truncate">
        <span className="text-app-text-secondary">{comment.author}</span> → {valid ? STATUS_LABEL[to] : comment.content}
      </span>
      <span className="ml-auto shrink-0 text-app-text-faint">{at.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
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
  const tr = useT();
  const [open, setOpen] = useState(false);
  // Only the AGENT's turns are "passaggi". Human/dispatcher turns injected into
  // the session (your steering, the kickoff envelope) are noise here: your side
  // already shows as comment bubbles in the thread — showing it again as a step
  // is pure duplication. Hide it.
  const steps = msgs.filter((m) => m.role !== 'user');
  if (steps.length === 0 && !preview) return null;
  return (
    <div className="rounded-md border border-app-border-subtle bg-white/[0.02]">
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? tr('board.task.collapse') : tr('board.task.showSteps')}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-app-text-muted hover:text-app-text-heading"
      >
        <Footprints className="h-3 w-3 shrink-0" />
        <span>{label ?? tr('board.task.steps')}{steps.length > 0 && <span className="text-app-text-faint"> · {steps.length}</span>}</span>
        <ChevronDown className={`ml-auto h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {!open && preview && (
        <p
          data-testid="task-stream-preview"
          title={tr('board.task.streamPreviewTitle')}
          className="line-clamp-2 border-t border-app-border-subtle px-2.5 py-1.5 text-[11px] italic leading-snug text-app-text-muted"
        >…{preview}</p>
      )}
      {open && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t border-app-border-subtle bg-black/20 px-2.5 py-2">
          {steps.map((m, i) => (
            <div key={i} className="space-y-1">
              {/* Coherent with the real chat: assistant thinking renders through
                  the SAME ReasoningRow the topic chat uses, then the prose. */}
              {m.thinking?.trim() && (
                <ReasoningRow content={m.thinking} />
              )}
              {m.content.trim() && (
                <div className="flex gap-1.5 text-xs leading-relaxed">
                  <span className="shrink-0 font-semibold text-app-text-muted">⏺</span>
                  <div className={`min-w-0 flex-1 text-app-text-heading ${COMPACT_MD_CLS}`}>
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
  const tr = useT();
  // Machine-authored review evidence (live-preview screenshot from the verifier).
  // Distinct from human/agent speech: it never woke the agent, it just informs.
  if (comment.kind === 'review-note') {
    return (
      <div className="pr-8">
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5">
          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-400/80">
            <Camera size={11} /> {tr('board.task.reviewPreview')}
          </p>
          <div className="text-sm text-app-text"><CommentBody content={comment.content} /></div>
          <MediaStrip media={comment.media} onPreview={onPreview} />
          <p className="mt-0.5 text-[9px] text-app-text-faint">{commentTime(comment.createdAt)}</p>
        </div>
      </div>
    );
  }
  if (comment.author !== 'user') {
    const system = comment.author === 'system';
    return (
      <div className="pr-8" title={comment.author}>
        <div className={`text-sm ${system ? 'text-app-text-muted' : 'text-app-text'}`}>
          <CommentBody content={comment.content} />
        </div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-[9px] text-app-text-faint">{commentTime(comment.createdAt)}</p>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-sm">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-right text-[9px] text-app-text-muted">{commentTime(comment.createdAt)}</p>
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
  if (!q) return <div className={`mt-0.5 text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{content}</ChatMarkdown></div>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <div className={`text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{outside}</ChatMarkdown></div>}
      <div className="rounded border border-rose-500/25 bg-rose-500/5 px-2 py-1.5">
        <p className="text-[13px] leading-snug text-app-text">{q.question}</p>
        {q.options.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {q.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-app-text">
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
  const tr = useT();
  const patch = async (p: BoardSettingsPatch) => {
    try { onChanged(await boardApi.updateSettings(projectId, p)); }
    catch (e) { onError(e instanceof Error ? e.message : 'settings save failed'); }
  };
  if (!s) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-app-border bg-app-inset px-3 py-2.5 text-xs text-app-text-heading">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-app-text">{tr('board.settings.autoDispatch')}</span>
        <button aria-label={tr('board.settings.close')} onClick={onClose} className="rounded p-0.5 text-app-text-secondary hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
      </div>

      <label
        className="flex cursor-pointer items-center justify-between gap-3"
        title={tr('board.settings.dispatchOnTitle')}
      >
        <span>{tr('board.settings.dispatchOnPre')} <b>Todo</b></span>
        <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
      </label>

      <div className="flex items-center justify-between gap-2">
        <span>{tr('board.settings.effort')}</span>
        <div className="flex gap-0.5">
          {EFFORTS.map((ef) => (
            <button
              key={ef} onClick={() => patch({ dispatchEffort: ef })}
              className={`rounded px-1.5 py-0.5 ${s.dispatchEffort === ef ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{ef}</button>
          ))}
        </div>
      </div>

      <label className="flex items-center justify-between gap-2" title={tr('board.settings.modelTitle')}>
        <span>{tr('board.settings.model')}</span>
        <select
          value={s.dispatchModel || 'auto'}
          onChange={(e) => patch({ dispatchModel: e.target.value })}
          className="max-w-[55%] rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-app-text outline-none"
        >
          <option value="auto">{tr('board.settings.modelAuto')}</option>
          {models.map((m) => (
            <option key={m} value={m}>{friendlyModelLabel(m)}</option>
          ))}
        </select>
      </label>

      {/* Gemella della tendina in Impostazioni → Aspetto, e per «gemella» si
          intende lo stesso VALORE EFFETTIVO: «Come le Impostazioni» non copia
          la scelta globale, la EREDITA (il ripiego lo fa il server, in un punto
          solo). Copiare il valore vorrebbe dire che cambiare la preferenza
          globale non muove le board che l'avevano già letta. */}
      <label
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.responseLanguageTitle')}
      >
        <span>{tr('board.settings.responseLanguage')}</span>
        <select
          value={s.language || 'inherit'}
          onChange={(e) => patch({ language: e.target.value })}
          className="max-w-[55%] rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-app-text outline-none"
          data-testid="board-language"
        >
          <option value="inherit">{tr('board.settings.langInherit')}</option>
          <option value="it">Italiano</option>
          <option value="en">English</option>
        </select>
      </label>

      <label className="flex cursor-pointer items-center justify-between">
        <span>{tr('board.settings.isolateWorktree')}</span>
        <input type="checkbox" checked={s.dispatchUseWorktree} onChange={(e) => patch({ dispatchUseWorktree: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      <label
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.fanoutTitle')}
      >
        <span>{tr('board.settings.fanout')} <span className="text-app-text-muted">(fan-out)</span></span>
        <div className="flex gap-0.5">
          {FANOUT_CHOICES.map((n) => (
            <button
              key={n}
              disabled={!s.dispatchUseWorktree}
              onClick={() => patch({ dispatchFanOut: n })}
              className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${
                (s.dispatchFanOut || 1) === n ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary enabled:hover:bg-white/10'
              }`}
            >{n}</button>
          ))}
        </div>
      </label>
      {s.dispatchUseWorktree && (s.dispatchFanOut || 1) > 1 && (
        <p className="text-[11px] text-amber-300/80">
          {tr('board.settings.fanoutWarn', { n: s.dispatchFanOut ?? 1 })}
        </p>
      )}

      {/* La condizione del BOARD, detta dove si accende l'impostazione invece
          che scoperta a ogni task. Prima ogni dispatch moriva con «worktree
          richiesto ma il progetto non è un repo git registrato»: il messaggio
          era corretto e arrivava alla persona sbagliata. */}
      {s.dispatchUseWorktree && (s as { worktreeReady?: boolean }).worktreeReady === false && (
        <p className="text-[11px] leading-snug text-amber-300/90">
          {tr('board.settings.notRepoWarn')}
        </p>
      )}

      {/* La modalità notturna ha una CARD sua, non una casella in mezzo alle
          altre: l'interruttore è la parte piccola, la parte utile è lo stato —
          sta dispacciando o è in attesa, e per quale motivo. Vedi
          `NightModeCard.tsx`. */}
      <NightModeCard
        projectId={projectId}
        enabled={!!s.nightMode}
        until={s.nightModeUntil || '10:00'}
        onChange={patch}
      />

      <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.autoMergeTitle')}>
        <span>{tr('board.settings.autoMerge')}</span>
        <input type="checkbox" checked={s.dispatchAutoMerge} disabled={!s.dispatchUseWorktree} onChange={(e) => patch({ dispatchAutoMerge: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500 disabled:opacity-40" />
      </label>

      <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.fullMcpTitle')}>
        <span>{tr('board.settings.fullMcp')}</span>
        <input type="checkbox" checked={s.dispatchMcp === 'inherit'} onChange={(e) => patch({ dispatchMcp: e.target.checked ? 'inherit' : 'bridge-only' })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      <ReviewChecksField checks={s.reviewChecks} onSave={(reviewChecks) => patch({ reviewChecks })} />

      {dispatchOn && (
        <p className="text-[11px] text-amber-300/80">{tr('board.settings.dispatchOnActive')}</p>
      )}
    </div>
  );
}

/**
 * I comandi del gate pre-review, uno per riga. Testo libero e non una lista di
 * checkbox su script noti: i comandi buoni sono composti (`bun run typecheck &&
 * bun test`), cambiano da board a board, e un menu di scelte fisse costringerebbe
 * a scegliere quello sbagliato.
 *
 * Si salva su blur / ⌘↵ e non a ogni tasto: un PATCH per carattere farebbe partire
 * un salvataggio a metà comando.
 */
function ReviewChecksField({ checks, onSave }: { checks: ReviewCheck[]; onSave: (c: ReviewCheck[]) => void }) {
  const tr = useT();
  const asText = (list: ReviewCheck[]) => list.map((c) => c.cmd).join('\n');
  const saved = asText(checks);
  // `null` = allineato al server, e il testo mostrato È quello salvato. Niente
  // copia locale da tenere in sync con un effect: se le impostazioni cambiano da
  // un'altra finestra (o il parser normalizza quello che ho scritto) il campo
  // segue da solo, ma solo finché non ho modifiche non salvate sotto le dita.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  const dirty = draft !== null;

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const next = text.split('\n').map((l) => l.trim()).filter(Boolean).map((cmd) => ({ name: cmd, cmd }));
    if (asText(next) === saved) return;
    onSave(next);
  };

  return (
    <div className="space-y-1">
      <label
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.checksTitle')}
      >
        <span>{tr('board.settings.checks')} <span className="text-app-text-muted">(un comando per riga)</span></span>
        {checks.length > 0 && <span className="text-[10px] text-app-text-muted">{checks.length}/5</span>}
      </label>
      <textarea
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
        rows={Math.min(5, Math.max(2, text.split('\n').length))}
        spellCheck={false}
        placeholder={'bun run typecheck\nbun test'}
        className="w-full resize-none rounded bg-white/5 px-1.5 py-1 font-mono text-[11px] text-app-text outline-none placeholder:text-app-placeholder focus:bg-white/10"
      />
      {dirty && <p className="text-[10px] text-app-text-muted">Salva uscendo dal campo (o ⌘↵).</p>}
    </div>
  );
}
