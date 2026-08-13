import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent as ReactTouchEvent } from 'react';
import { useT, useLocale } from '../../hooks/useT';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { NightModeCard } from './NightModeCard';
import {
  GlobalSettingsSection,
  SettingsPanelHead,
  SETTINGS_PANEL_SHELL,
} from './BoardSettingsSections';
import { AlertTriangle, ArrowUpRight, Bot, Camera, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, Footprints, GitMerge, Globe, Hourglass, Link2, Lock, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Paperclip, Plus, Send, ShieldCheck, ShieldX, Sparkles, Square, Tag, UserRound, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ReasoningRow } from '../Chat/ReasoningRow';
import { Menu } from '../Shared/Menu';
import { Select } from '../Shared/Select';
import { ShareControl } from '../Share/ShareControl';
import { Spinner } from '../Shared/Spinner';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { getMediaUrl } from '../../lib/api';
import { isImagePath, isPdfPath, isVideoPath } from '../../lib/mediaKind';
import { isSupersededPreviewNote } from '../../../../shared/preview-retirement';
import { ThreadRuns } from './ThreadRuns';
import { copyText } from '../../lib/clipboard';
import { openExternalOnce } from '../../lib/openExternal';
import { buildTaskLink } from '../../lib/openTaskLink';
import { canOpenTaskSession, shouldExplainMissingSession, type TaskSessionState } from '../../lib/taskSession';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { enqueueProjectBrowserNavigate, isProjectWindowMounted } from '../../state/pane/adapters';
import { useTaskBrowserTabs, liveTabs, workspaceTwinContextId } from '../../state/taskBrowserTabs';
import { noteAutoOpenedPreview, releaseAutoOpenedPreview } from '../../state/taskWorkspacePreviews';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { boardApi, commentAuthorLabel, diffTotals, hasCodeQuestion, showsLandingDebt, STATUS_LABEL, TASK_STATUSES, isAgentWorking, isThreadSpeech, parseQuestionBlock, parseStatusEvent, hasPlanApproveOption, isProjectlessId, boardDrafts, systemDeliveryNote, blockedByChip, subtaskWorkChip, reopenedChip, attemptHasWork, CLOSER_LABELS, KIND_LABELS, type TaskLabel, type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch, type BoardProjectRef, type DiffBundle, type DiffNote, type ReviewCheck, type CheckRun, type TaskAttempt, type LandingTicket } from '../../lib/board';
import { PreviewMedia } from './PreviewMedia';
import { UnifiedDiff } from './UnifiedDiff';
import { collectTaskMediaPaths } from './taskMedia';
import { TaskChoiceRow } from './TaskChoiceRow';
import { usableQuestionOptions } from './taskChoices';
import { acceptWord, drawerSurfaceLabels, sendBackWord as sendBackWordFor, taskActionWord } from './taskActionWords';
import { manualStatusTarget } from '../../lib/boardOrder';
import { formatReviewNotes } from './reviewNotes';
import { COMPACT_MD_CLS, PLAN_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, DISPATCH_CHIP, EFFORTS, FANOUT_CHOICES, mediaPaneIdFor, type TaskSurface } from './constants';
import { friendlyModelLabel, fmtModel, commentTime, fmtMs, fmtLive, fmtTok, fmtUpdatedAt, autoGrow, attemptStat, taskCopyText, descSummary, fmtCount } from './format';
import { StatusIcon, DispatchChip, QueueReasonChip } from './atoms';
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
        {tr('board.task.checks.running')}
      </div>
    );
  }

  const runs = task.checks ?? [];
  const failed = runs.find((r) => !r.ok);
  const short = (r: CheckRun) =>
    r.spawnError ? tr('board.task.checks.notStarted')
      : r.timedOut ? tr('board.task.checks.timedOut')
        : `exit ${r.code}`;
  // L'ora resta in formato italiano perché `2-digit`/`2-digit` la rende `14:05`
  // in ogni lingua che questa app parla: nessun testo, nessun 12h/24h da
  // decidere. Il giorno in cui il drawer avrà date vere, il formato diventa una
  // scelta di locale e va fatta in un posto solo (`format.ts`), non qui.
  const when = task.checksAt ? new Date(task.checksAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
  const at = when ? ` ${tr('board.task.checks.at', { t: when })}` : '';

  if (task.checksState === 'pass') {
    return (
      <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
        <Check className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {tr('board.task.checks.pass')}{at}{runs.length ? `: ${runs.map((r) => r.name).join(', ')}` : ''}
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
          {tr('board.task.checks.fail')}{at}{failed ? `: ${failed.name} (${short(failed)})` : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {runs.map((r, i) => (
            <div key={i}>
              <div className={r.ok ? 'text-emerald-300' : 'text-rose-200'}>
                {r.ok ? '✓' : '✗'} <code className="font-mono">{r.cmd}</code>{r.ok ? '' : `: ${short(r)}`}
              </div>
              {!r.ok && (r.tail || r.spawnError) && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1.5 font-mono text-[10px] leading-snug text-app-text-heading">
                  {r.spawnError ?? r.tail}
                </pre>
              )}
            </div>
          ))}
          <p className="text-app-text-secondary">
            {tr('board.task.checks.hintLead')} <b>{taskActionWord('send-back', tr).label}</b>{tr('board.task.checks.hintTail')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Il pannello «Modifiche» del drawer: cosa ha cambiato QUESTA card.
 *
 * Si disegna sempre, per una card di cui la domanda ha senso (`hasCodeQuestion`),
 * e questo è il cambio di contratto rispetto a prima: finché il pannello spariva
 * quando non c'erano file, «la card non ha prodotto codice» e «non ho potuto
 * guardare» erano lo stesso vuoto — su una consegna in review sono due verdetti
 * opposti. Ora il perché arriva dal server in `code` e sta scritto in chiaro.
 *
 * Il diff che disegna è quello dei commit PROPRI della card, e dopo il land
 * arriva dal merge su main: sopravvive alla potatura del worktree, che è
 * esattamente quando un reviewer vuole ancora poterlo leggere.
 */
export function TaskChangesSection({ projectId, taskId, bump, onSent }: {
  projectId: string; taskId: string; bump?: string | number;
  /** Le note sono partite come commento: il thread ha una riga in più. */
  onSent?: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DiffBundle | 'error' | null>(null);
  const [notes, setNotes] = useState<DiffNote[]>([]);
  const [sendingNotes, setSendingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesLoaded = useRef(false);
  const fetchDiff = useCallback(() => {
    // Il bundle precedente NON si azzera mentre si ricarica: `bump` scatta a ogni
    // aggiornamento del task, e svuotare qui faceva sparire e riapparire il
    // pannello sotto le mani di chi stava leggendo.
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
      setNotesError(e instanceof Error ? e.message : tr('board.task.changes.sendFailed'));
    } finally { setSendingNotes(false); }
  };

  const bundle = state && typeof state === 'object' ? state : null;
  const totals = bundle ? diffTotals(bundle.stat) : null;
  // Il primo giro non ha ancora una risposta: una barra che compare e sparisce
  // dice meno di niente. Da lì in poi si disegna sempre.
  if (!state) return null;
  const label = tr('board.task.changes');
  if (!bundle || !totals || totals.files === 0) {
    // Le tre risposte del server, più il caso in cui è saltata la richiesta.
    const why = state === 'error'
      ? tr('board.task.diffUnreadable')
      : bundle?.code === 'not_dispatched' ? tr('board.task.changes.notDispatched')
      : bundle?.code === 'unreadable' ? tr('board.task.changes.unreadable')
      : tr('board.task.changes.empty');
    return (
      <div className="shrink-0 border-b border-app-border px-3 py-2">
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">{label}</span>
          <span className="min-w-0 flex-1 text-[11px] text-app-text-secondary">{why}</span>
        </div>
      </div>
    );
  }
  const fileCount = totals.files;
  const from = bundle.source === 'landed-merge' ? tr('board.task.changes.fromMerge')
    : bundle.source === 'delivery-commit' ? tr('board.task.changes.fromDelivery')
    : null;
  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <button onClick={() => setOpen((s) => !s)} className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label} <span className="normal-case tracking-normal text-app-text-faint">· {tr(fileCount === 1 ? 'board.task.changes.files.one' : 'board.task.changes.files.many', { n: fileCount })}</span>
        {/* Il totale sta in TESTA perché è la prima domanda di chi rivede
            («quanto è grosso?») e perché è l'unico numero completo: la lista si
            può troncare, questo no. */}
        <span className="font-mono normal-case tracking-normal tabular-nums">
          <span className="text-emerald-400">+{totals.additions}</span> <span className="text-red-400">−{totals.deletions}</span>
        </span>
        {from && (
          <span className="truncate rounded bg-white/5 px-1 text-[9px] normal-case tracking-normal text-app-text-faint">{from}</span>
        )}
        {notes.length > 0 && (
          <span className="ml-1 rounded bg-indigo-500/20 px-1 text-[9px] normal-case tracking-normal text-indigo-300">
            {tr('board.task.changes.pending', { n: notes.length })}
          </span>
        )}
      </button>
      {open && (
        <>
          {/* Accordion puro: il `max-h-[42vh] overflow-y-auto` era uno scroll
              dentro lo scroll che non c'era. Adesso scorre il brief. */}
          <div className="mt-1.5">
            <UnifiedDiff bundle={bundle} defaultOpenFirst review={review} />
          </div>
          {notes.length > 0 && (
            <div className="mt-1.5 flex items-center gap-2 rounded border border-indigo-500/25 bg-indigo-500/5 px-2 py-1.5">
              <span className="min-w-0 flex-1 text-[11px] text-app-text-heading">
                {notesError
                  ? <span className="text-rose-300">{tr('board.task.changes.sendFailedInline', { msg: notesError })}</span>
                  : tr(notes.length === 1 ? 'board.task.changes.notes.one' : 'board.task.changes.notes.many', { n: notes.length })}
              </span>
              <button
                onClick={() => setNotes([])}
                disabled={sendingNotes}
                className="rounded px-2 py-0.5 text-[11px] text-app-text-secondary hover:text-app-text disabled:opacity-40"
              >
                {tr('board.task.changes.discard')}
              </button>
              <button
                onClick={sendNotes}
                disabled={sendingNotes}
                className="flex items-center gap-1 rounded bg-indigo-500/25 px-2 py-0.5 text-[11px] text-indigo-100 hover:bg-indigo-500/40 disabled:opacity-40"
              >
                {sendingNotes ? <Spinner size="sm" tone="current" /> : <Send className="h-3 w-3" />}
                {tr('board.task.changes.send')}
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
  // Ogni tentativo ha la SUA sessione, quindi qui il risolutore serve per riga
  // e non basta lo `sessionState` del task. Una sola istanza in tutto il drawer:
  // nessuna lista memoizzata da svegliare.
  const resolveSession = useTaskSessionResolver();
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
      setError(e instanceof Error ? e.message : tr('board.task.attempts.pickFailed'));
    } finally { setPicking(null); }
  };

  if (attempts.length < 2) return null;
  const decided = attempts.some((a) => a.state === 'selected');
  const running = attempts.filter((a) => a.state === 'running').length;

  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.task.attempts')} <span className="normal-case tracking-normal text-app-text-faint">· {tr('board.task.attempts.parallel', { n: attempts.length })}</span>
        {running > 0 && (
          <span className="ml-1 flex items-center gap-1 rounded bg-amber-500/15 px-1 text-[9px] normal-case tracking-normal text-amber-300">
            <Spinner size="xs" tone="current" /> {tr('board.task.attempts.running', { n: running })}
          </span>
        )}
      </div>
      {!decided && running === 0 && (
        <p className="mt-1 text-[11px] text-app-text-secondary">
          {tr('board.task.attempts.pickHint')}
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
                <span className="font-medium text-app-text">{tr('board.task.attempt.n', { n: a.idx })}</span>
                {won && <span className="rounded bg-emerald-500/25 px-1 text-[9px] text-emerald-200">{tr('board.task.attempt.selected')}</span>}
                {dead && <span className="rounded bg-white/10 px-1 text-[9px] text-app-text-secondary">{tr('board.task.attempt.discarded')}</span>}
                <span className="text-app-text-muted">{attemptStat(a, tr)}</span>
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
                  >{tr(openDiff === a.id ? 'board.task.attempt.closeDiff' : 'board.task.attempt.openDiff')}</button>
                )}
                {/* «Apri la chat» diceva meno di quel che fa: è la SESSIONE di
                    QUESTO tentativo, e come ogni sessione può non esserci più. */}
                {a.topicId && onOpenTopic && !dead && canOpenTaskSession(resolveSession(a.topicId)) && (
                  <button
                    onClick={() => onOpenTopic(a.topicId!)}
                    title={tr('board.task.openSessionTitle')}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-heading hover:bg-white/10"
                  >{tr('board.task.openSession')}</button>
                )}
                {a.topicId && !dead && shouldExplainMissingSession(resolveSession(a.topicId)) && (
                  <span
                    title={tr('board.task.sessionGoneTitle')}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-faint"
                  >{tr('board.task.sessionGone')}</span>
                )}
                {!decided && running === 0 && a.topicId && (
                  <button
                    onClick={() => pick(a.id)}
                    disabled={!!picking}
                    data-testid="task-attempt-pick"
                    title={work ? undefined : tr('board.task.attempt.emptyTitle')}
                    className="ml-auto flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {picking === a.id && <Spinner size="sm" tone="current" />} {tr('board.task.attempt.pick')}
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
  // Un tentativo si legge SOLO dal suo worktree (i riferimenti durevoli parlano
  // del vincitore), quindi qui i codici sono due: «non ha prodotto niente» e
  // «non ricostruibile» — e restano distinti anche in una riga sola.
  if (state.stat.length === 0) {
    const why = state.code === 'no_changes' || !state.code
      ? tr('board.task.changes.empty')
      : tr('board.task.changes.unreadable');
    return <p className="mt-1.5 text-[11px] text-app-text-muted">{why}</p>;
  }
  return (
    // Accordion puro (vedi TaskChangesSection): il tetto in vh era il surrogato
    // dello scroll che il drawer non aveva.
    <div className="mt-1.5">
      <UnifiedDiff bundle={state} defaultOpenFirst />
    </div>
  );
}

// ── Detail: drawer by default, expandable review surface ────────────────────

export function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic, sessionState = 'unknown', focusPaneId, autoOpenInWorkspace = false }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
  /**
   * Change signal (the task's updatedAt from the board's live list): any WS
   * task:updated — a step flipping, a new comment — re-fetches the open detail,
   * so the drawer follows the agent in real time instead of freezing at mount.
   */
  bump?: string;
  /** Navigate the drawer to another task (subtask ↔ parent). */
  onOpenTask?: (taskId: string) => void;
  /** Apre la SESSIONE dell'agente (la sua chat), che non è questa scheda. */
  onOpenTopic?: (topicId: string) => void;
  /**
   * La sessione dell'agente esiste ancora? Il drawer è la SCHEDA e vive per
   * conto suo; il gesto verso la sessione va offerto solo se c'è qualcosa da
   * aprire, e quando non c'è più va DETTO. Vedi `lib/taskSession.ts`.
   */
  sessionState?: TaskSessionState;
  /**
   * Tab del task da mettere davanti all'apertura (`media:<path>`): la chiede
   * chi ha aperto il drawer con un gesto MIRATO — il bottone «apri in una tab»
   * sull'anteprima della card. Senza, si apre sul Thread come sempre.
   */
  focusPaneId?: string;
  /**
   * Aprire da sé il risultato del task come pane del workspace del progetto,
   * all'apertura del task e senza click.
   *
   * Lo decide CHI OSPITA la board, non la board: acceso quando il drawer e il
   * workspace sono due superfici distinte (la board globale accanto a una
   * finestra di progetto), spento quando la board È una pane DENTRO quella
   * finestra — lì l'apertura automatica si prenderebbe lo spazio del drawer che
   * stai leggendo, e a ogni card cliccata rifarebbe lo split.
   *
   * Vale comunque solo se la finestra del progetto è già montata: nessuna
   * apertura forzata. E ciò che si è aperto da solo si richiude da solo quando
   * esci dal task (`state/taskWorkspacePreviews.ts`) — quello che apri A MANO
   * col bottone resta.
   */
  autoOpenInWorkspace?: boolean;
}) {
  const tr = useT();
  const locale = useLocale();
  // The three actions the drawer draws with buttons of ITS OWN, bigger, instead
  // of leaving them to the choice row. The words are the card's, from the same
  // table: one action, one word, wherever you press it.
  //
  // `approveWord` and `sendBackWord` are computed further down, where the task
  // is loaded: both change with the card's state (red checks rename Approva,
  // a review with no agent has no agent to send anything back to) and a word
  // that changes on screen has to change in the table, or the de-duplicator
  // subtracts the wrong one.
  const landWord = taskActionWord('land', tr);
  // The drawer has its own «Ferma» too, next to the working agent's dots: same
  // action as the card's context menu and the choice row, therefore the same
  // word and the same tooltip (which names Backlog, where the task ends up).
  const stopWord = taskActionWord('stop', tr);
  // Le tab del task, lette QUI e non dalla `browser` più in basso: il manifesto
  // serve a callback definiti molto prima di quel hook.
  const taskTabsState = useTaskBrowserTabs(taskId);
  const liveTaskTabs = useMemo(() => liveTabs(taskTabsState), [taskTabsState]);
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
  /**
   * A move that did NOT land where it was aimed. The board's own band, one
   * level in: nothing failed, so it is not an error, and the sentence is the
   * same one the column drag shows, from the same key.
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** La ricevuta del land chiesto da QUESTO client, finché non si chiude. */
  const [landing, setLanding] = useState<LandingTicket | null>(null);
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
  // L'anteprima ha una sezione SUA, che si chiude da sola. Prima era sorella
  // della descrizione dentro lo stesso riquadro ma FUORI dal ramo `descOpen`:
  // chiudere la descrizione non la nascondeva, e nessuna maniglia la nascondeva.
  // Non era un bug — mancava lo slot per «la consegna», che è la cosa per cui
  // il drawer si apre.
  const [previewOpen, setPreviewOpen] = useState(() => { try { return localStorage.getItem('board:taskPreviewOpen') !== '0'; } catch { return true; } });
  const togglePreviewOpen = () => setPreviewOpen((o) => { const n = !o; try { localStorage.setItem('board:taskPreviewOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  const toggleDescOpen = () => setDescOpen((o) => { const n = !o; try { localStorage.setItem('board:taskDescOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  const toggleSubtasksOpen = () => setSubtasksOpen((o) => { const n = !o; try { localStorage.setItem('board:taskSubtasksOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  // The workspace (the task's GroupLayout: thread + browser + piano + media) is
  // itself an accordion, coherent with the others — the tab bar sits UNDER a
  // "Spazio di lavoro" label. Default open.
  const [workspaceOpen, setWorkspaceOpen] = useState(() => { try { return localStorage.getItem('board:taskWorkspaceOpen') !== '0'; } catch { return true; } });
  const toggleWorkspaceOpen = () => setWorkspaceOpen((o) => { const n = !o; try { localStorage.setItem('board:taskWorkspaceOpen', n ? '1' : '0'); } catch { /* private mode */ } return n; });
  // DUE COLONNE — «a sinistra la sessione stretta col task, a destra la tab
  // aperta con quello che devo vedere». Serve spazio VERO: a sinistra 22rem di
  // brief+sessione, a destra il tiling. Il drawer in modo largo misura
  // `min(64rem, 72%)`, quindi la seconda colonna ha senso solo da ~1280px in su
  // (lì la destra resta sopra i 550px); a 1024 il drawer sarebbe 737px e le due
  // colonne uscirebbero 352+385, cioè due strisce. Sotto la soglia il drawer
  // resta a UNA colonna, esattamente come prima.
  //
  // Media query e non classe `xl:`: la seconda colonna non deve essere NASCOSTA,
  // deve non esistere — il thread ci si trasferisce dentro, e due copie montate
  // sarebbero due sottoscrizioni allo stesso stream.
  const viewportWide = useMediaQuery('(min-width: 1280px)');
  const twoCol = wide && viewportWide;
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
  /**
   * Il thread senza le note che ha già smentito la card.
   *
   * «⚠️ Anteprima RITIRATA…» è uno stato scritto come messaggio: su 3 card
   * l'anteprima è tornata e la nota continuava a dire il contrario. La riga
   * NON si cancella dal DB — è la storia di cosa è successo — semplicemente il
   * thread smette di mostrarla quando non vale più. Il fatto, finché vale, si
   * vede nello slot della consegna qui sopra (`task-preview-retired`).
   */
  const threadComments = useMemo(
    () => (task ? comments.filter((c) => !isSupersededPreviewNote(c, task)) : comments),
    [comments, task],
  );
  const isAgentReview = !!task && task.status === 'review' && !!task.assignedTopicId;
  // The two words that depend on the card. `acceptWord` renames itself when the
  // pre-review checks are red; `sendBackWord` keeps the word and swaps the
  // tooltip when there is no agent to go back TO — a review a human filed by
  // hand has no tab that "restarts", and the tooltip that promised one was
  // naming a destination that does not exist.
  const approveWord = acceptWord(task?.checksState === 'fail', tr);
  const sendBackWord = sendBackWordFor(isAgentReview, tr);
  // Pending question = the agent's last word is a question block: its options
  // render as quick-reply buttons right above the composer (same zone as the
  // review actions), mirroring the card.
  // `isThreadSpeech` drops the two kinds that are never "the agent's last word":
  // 'status' (transition history) and 'service' (the dispatcher's bookkeeping).
  // Same predicate as the card and as `pendingQuestion`, deliberately - the
  // drawer showing no buttons while the card shows two is the shape this bug
  // takes when the three drift.
  const speech = comments.filter(isThreadSpeech);
  const lastThreadComment = speech[speech.length - 1] ?? null;
  const pending = isAgentReview && lastThreadComment ? parseQuestionBlock(lastThreadComment.content) : null;
  // Same trap as on the card, one size bigger: the drawer draws its own approve
  // / send-back / land buttons, so a quick reply carrying one of those labels
  // sits beside a button that does something else entirely.
  //
  // The choice row hides those actions precisely BECAUSE the drawer renders
  // them itself, so `exclude` would hide the collision instead of catching it.
  // What the de-duplicator needs is the opposite: the words this surface draws
  // ON ITS OWN, which is what `surfaceLabels` carries. Without it a question
  // block offering «Approva» drew a twin of the real Approva that REJECTED the
  // card (comment 2eff6a44).
  //
  // The list is not written out here: `drawerSurfaceLabels` computes it from
  // the same table and the same card state the buttons below render from. Spelt
  // out by hand it went stale the moment a button changed word — with red
  // checks the button says «Approva comunque» while this list still said
  // «Approva», so the twin came back.
  const replyOptions = useMemo(
    () => (pending && task
      ? usableQuestionOptions(task, pending.options, { t: tr, surfaceLabels: drawerSurfaceLabels(task, tr) })
      : []),
    [pending, task, tr],
  );
  // QUALE commento è il piano. Il task lo PUNTA (`planCommentId`, scritto dal
  // server quando il piano arriva secondo protocollo): non è più «l'ultimo
  // commento non-utente», euristica che su 13 task piano-prima sbagliava 13
  // volte su 13 — bastava una rettifica dopo il piano per prenderne il posto.
  //
  // La ricaduta serve ai task nati PRIMA del puntatore: stessa regola, applicata
  // a posteriori — l'ultimo commento dell'agente le cui opzioni offrono
  // l'approvazione del piano. Se nessuno la offre, non c'è nessun piano da
  // mostrare (meglio nessuna tab che la tab sbagliata).
  const planComment = useMemo(() => {
    if (!task?.planFirst) return null;
    if (task.planCommentId) {
      const byId = speech.find((c) => c.id === task.planCommentId);
      if (byId) return byId;
    }
    return [...speech].reverse().find((c) => (
      c.author !== 'user' && c.author !== 'system'
      && hasPlanApproveOption(parseQuestionBlock(c.content)?.options ?? [])
    )) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `speech` is derived from `comments` each render
  }, [comments, task?.planFirst, task?.planCommentId]);


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
  //
  // Il server risponde `202`: il land è ACCODATO. La ricevuta va TENUTA e
  // seguita, perché è la sola cosa che distingue «sta per succedere» da «è
  // successo» — e senza quella distinzione una raffica di land sembra riuscita
  // mentre non lo è.
  const doLand = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await boardApi.land(projectId, taskId);
      setLanding(res.landing ?? null);
      setError(null); await load(); onChanged();
    }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Il ticket si SEGUE finché non si chiude. Senza qualcuno che chieda «e poi?»,
  // il 202 sarebbe l'onestà del server sprecata: la richiesta è andata a buon
  // fine e l'esito non arriva comunque mai a chi l'ha chiesto.
  useEffect(() => {
    if (!landing || (landing.phase !== 'queued' && landing.phase !== 'running')) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const res = await boardApi.landStatus(projectId, taskId);
        if (!alive) return;
        // Stesso oggetto quando niente è cambiato: altrimenti ogni giro
        // rimonterebbe questo effetto e riazzererebbe l'intervallo.
        setLanding((prev) =>
          prev && prev.phase === res.landing.phase && prev.ahead === res.landing.ahead ? prev : res.landing);
        if (res.landing.phase === 'settled' || res.landing.phase === 'failed') { await load(); onChanged(); }
      } catch {
        // Il ticket è caduto fuori dalla finestra interrogabile (o la board non
        // risponde): la banda sparisce invece di mentire.
        if (alive) setLanding(null);
      }
    }, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [landing, projectId, taskId, load, onChanged]);

  // Ricattura evidenza: rifà l'anteprima di QUESTA card senza svegliare l'agent
  // (il server risponde sul canale review-note, non su quello dei commenti) e
  // senza muoverla dalla colonna. Ha il suo `busy` perché è lenta — boot del
  // server + screenshot — e non deve disabilitare Approva/Rimanda indietro nel frattempo.
  const [recapturing, setRecapturing] = useState(false);
  const recapturePreview = async () => {
    if (recapturing) return;
    setRecapturing(true);
    try { await boardApi.recapturePreview(projectId, taskId); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setRecapturing(false); }
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

  // Status selector (header chip): the drawer can move the task directly, with
  // the same server guards as the drag (open_subtasks…) AND the same client
  // rule about In Progress (`manualStatusTarget`).
  //
  // The rule was not here before, and this menu lists every status, so it was
  // the widest of the three doors into the black hole: one click from the
  // drawer put a card with no agent into a column nothing collects. The drag
  // was fixed alone, which is how the comment that used to sit here ("same
  // PATCH the column drag uses") became false without anything failing.
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const changeStatus = async (s: TaskStatus) => {
    setStatusMenuOpen(false);
    if (!task || s === task.status || busy) return;
    const aim = manualStatusTarget(s, task);
    if (aim.status === task.status) {
      // Already there: nothing to write, and the human still asked for
      // something that did not happen the way they asked.
      setNotice(aim.redirectedFrom ? tr('board.drop.inProgressRedirected') : null);
      return;
    }
    setBusy(true);
    try {
      await boardApi.update(projectId, taskId, { status: aim.status });
      setNotice(aim.redirectedFrom ? tr('board.drop.inProgressRedirected') : null);
      setError(null); await load(); onChanged();
    }
    catch (e) { setNotice(null); showError(e); }
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
  // Le etichette del drawer: toggle, e una sola visibilita' per volta (accendere
  // `invisibile` spegne `visibile`, che e' cio' che fa `normalizeLabels` anche
  // lato server — qui si evita solo il viaggio con una richiesta contraddittoria).
  const labelBtnRef = useRef<HTMLButtonElement>(null);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const toggleLabel = async (l: TaskLabel) => {
    if (!task || busy) return;
    const on = task.labels.some((x) => x.label === l);
    const isCloser = l === 'visibile' || l === 'decisione' || l === 'invisibile';
    const next = task.labels
      .map((x) => x.label)
      .filter((x) => (on ? x !== l : !(isCloser && (x === 'visibile' || x === 'decisione' || x === 'invisibile'))));
    if (!on) next.push(l);
    setBusy(true);
    try { await boardApi.setLabels(projectId, taskId, next); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

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
  // browser.
  //
  // Apre il MANIFESTO, non una pagina: il risultato di un task sono le sue TAB,
  // e un task dispatchato può averne più d'una (`open_browser_pane({url, name})`).
  // Senza tab vive resta `output_url`, che è solo il seme della prima — così il
  // flusso manuale non perde niente.
  //
  // Ogni tab va nella sua pane, sotto il GEMELLO del suo contextId (`<ctx>_ws`,
  // vedi shared/task-tab-context.ts): due viste della stessa consegna, ma con
  // due webview native, perché una sola non può avere due genitori. Il gemello
  // resta riconducibile alla tab, quindi eredita il suo login salvato.
  //
  // `topics:open-project` parte SOLO se la finestra non c'è già. Prima veniva
  // sparato a ogni click: rialzava (o riapriva) la finestra del progetto anche
  // quando eri dentro, e lasciava parcheggiata una navigazione che poteva
  // ripresentarsi a un mount successivo. Il registro delle finestre montate è
  // esattamente la consapevolezza che mancava.
  const promoteToWorkspace = useCallback((entries: Array<{ url: string; contextId: string }>): string[] => {
    const projectPath = currentProject?.path;
    if (!projectPath) return [];
    const opened = entries.filter((e) => !!e.url);
    if (opened.length === 0) return [];
    const mounted = isProjectWindowMounted(projectPath);
    for (const { url, contextId } of opened) {
      // Il parcheggio serve solo alla finestra ancora da montare: con la
      // finestra viva l'evento basta, e una copia parcheggiata riaprirebbe la
      // pane a un remount futuro che nessuno ha chiesto.
      if (!mounted) enqueueProjectBrowserNavigate(projectPath, { url, contextId });
      window.dispatchEvent(new CustomEvent('browser:open-and-navigate', { detail: { projectPath, url, topicId: task?.assignedTopicId, contextId } }));
    }
    if (!mounted) window.dispatchEvent(new CustomEvent('topics:open-project', { detail: { projectPath } }));
    return opened.map((e) => e.contextId);
  }, [currentProject?.path, task?.assignedTopicId]);

  // Le tab del task tradotte in pane del workspace. Senza tab vive: il seme.
  // Le tab si leggono dallo store (non dalla `browser` più in basso) perché
  // questo callback nasce prima di quella, e leggerla via ref darebbe il
  // manifesto del render PRECEDENTE — cioè vuoto al primo click.
  const workspaceManifest = useMemo(() => {
    if (liveTaskTabs.length > 0) {
      return liveTaskTabs
        .filter((t) => !!t.url)
        .map((t) => ({ url: t.url, contextId: workspaceTwinContextId(t.contextId) }));
    }
    const seed = task?.outputUrl;
    return seed ? [{ url: seed, contextId: task?.assignedTopicId || `task-${task?.id}` }] : [];
  }, [liveTaskTabs, task?.outputUrl, task?.assignedTopicId, task?.id]);

  const openInWorkspace = useCallback(() => { promoteToWorkspace(workspaceManifest); }, [promoteToWorkspace, workspaceManifest]);

  // Chiude una pane del workspace passando dalla porta normale: `browser:request-close`
  // è la stessa richiesta che usa una pagina che fa `window.close()`, la raccoglie
  // la finestra che POSSIEDE quella pane (e nessun'altra), e passa per la chiusura
  // vera — animata, annullabile con ⌘Z. Niente scorciatoie distruttive.
  const closeWorkspacePanes = useCallback((contextIds: string[]) => {
    for (const contextId of contextIds) {
      window.dispatchEvent(new CustomEvent('browser:request-close', { detail: { contextId } }));
    }
  }, []);

  // AUTO-OPEN. Il risultato del task compare nel workspace all'APERTURA del
  // task, senza click — ma solo dove ha senso: chi ospita la board lo consente
  // (`autoOpenInWorkspace`) e la finestra del progetto è GIÀ montata. Se non
  // c'è, non si apre niente: aprire una finestra a ogni card cliccata era
  // esattamente il gesto invadente da evitare.
  //
  // Ri-parte quando cambia il manifesto (l'agente apre una tab nuova mentre
  // guardi): `ensureBrowserPaneAndNavigate` riusa la pane dello stesso
  // contextId, quindi ri-navigare non moltiplica niente.
  // Chiave SERIALIZZATA, non concatenata a mano: un separatore scelto a occhio
  // o compare dentro un URL — e allora due manifesti diversi danno la stessa
  // chiave e l'auto-open non riparte — oppure e' un byte di controllo, e qui lo
  // era (NUL + SOH): un file con un NUL dentro sparisce da `grep -r`.
  const manifestKey = useMemo(
    () => JSON.stringify(workspaceManifest),
    [workspaceManifest],
  );
  const promoteRef = useRef(promoteToWorkspace);
  promoteRef.current = promoteToWorkspace;
  const closeRef = useRef(closeWorkspacePanes);
  closeRef.current = closeWorkspacePanes;
  const manifestRef = useRef(workspaceManifest);
  manifestRef.current = workspaceManifest;
  const projectPath = currentProject?.path;
  useEffect(() => {
    if (!autoOpenInWorkspace || !projectPath || !manifestKey) return;
    if (!isProjectWindowMounted(projectPath)) return;
    const opened = promoteRef.current(manifestRef.current);
    if (opened.length === 0) return;
    // Il tetto: registrare un task in più sfratta il più vecchio, così due
    // board aperte (o una finestra chiusa di colpo) non lasciano preview
    // automatiche a vita.
    closeRef.current(noteAutoOpenedPreview(taskId, projectPath, opened));
  }, [autoOpenInWorkspace, projectPath, taskId, manifestKey]);

  // ...e quando esci dal task, ciò che si era aperto DA SOLO si richiude da
  // solo. Effetto separato, con `taskId` come sola dipendenza: se la cleanup
  // stesse sull'effetto di sopra, ogni cambio di manifesto chiuderebbe le pane
  // per riaprirle subito dopo. Quello che hai aperto A MANO col bottone non è
  // mai stato registrato, quindi resta dov'è.
  useEffect(() => () => { closeRef.current(releaseAutoOpenedPreview(taskId)); }, [taskId]);
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
  // Il picker si àncora a CHI l'ha aperto: il chip in riga quando c'è, il ⋯
  // quando il task non è bloccato (e il chip quindi non è disegnato).
  const blockerChipRef = useRef<HTMLButtonElement>(null);
  const blockerAnchorRef = useRef<HTMLElement | null>(null);
  const openBlockerMenu = (anchor?: HTMLElement | null) => {
    blockerAnchorRef.current = anchor ?? optionsBtnRef.current;
    setBlockerMenuOpen(true);
    if (boardTasks === null && task) boardApi.list(task.projectId).then(setBoardTasks).catch(() => setBoardTasks([]));
  };
  const blockerCandidates = useMemo(
    () => (boardTasks ?? []).filter((t) => !t.parentTaskId && t.id !== taskId),
    [boardTasks, taskId],
  );
  // Il bloccante lo risolve il SERVER (`task.blockedBy`): la lista della board
  // arriva solo quando si apre il picker, e cercarlo lì dentro voleva dire un
  // chip muto (o un «Bloccato da…» generico) su un task che un bloccante ce
  // l'aveva — e per un bloccante archiviato o di un altro taglio, per sempre.
  const blockedChip = task ? blockedByChip(task) : null;
  // Chi lavora un sottotask che non ha un agente suo: il server lo risolve
  // risalendo i padri, qui si sceglie solo come dirlo.
  const workChip = task ? subtaskWorkChip(task) : null;
  const workAncestorId = task?.subtaskWork?.kind === 'parent-turn' ? task.subtaskWork.ancestor.id : null;

  // Aveva consegnato e non è più lì: stessa lettura del chip sulla card, qui in
  // forma di banda (chi e quando). Vive finché la card non torna a consegnare.
  const reopened = task ? reopenedChip(task) : null;

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

  // Copia link / copia task: l'icona diventa una spunta per un attimo, e SOLO
  // se la copia è avvenuta davvero (`copyText` risponde `false` fuori da un
  // secure context, dove la clipboard non c'è proprio — v. lib/clipboard.ts).
  // Un solo stato per due bottoni: la spunta appartiene a quello premuto.
  const [copied, setCopied] = useState<'link' | 'task' | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCopied = (which: 'link' | 'task') => {
    setCopied(which);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1400);
  };
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copyLink = async () => {
    if (!task) return;
    if (await copyText(buildTaskLink(task.id))) flashCopied('link');
  };
  /** Il CONTENUTO del task (titolo + descrizione) negli appunti: quello che
   *  serve per incollarlo in una chat o in un'altra board. Il link, accanto,
   *  copre il caso opposto — ritrovare il task, non leggerlo. */
  const copyTask = async () => {
    if (!task) return;
    if (await copyText(taskCopyText(task))) flashCopied('task');
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

  /**
   * A run of dispatcher bookkeeping is CUT wherever the agent spoke in the gap
   * before a row. Session steps render between comments (`SessionSlice`), and a
   * fold that swallowed those would hide the very speech the fold exists to
   * surface, so the wall breaks there and the words stay outside it.
   */
  const threadBreaksRun = useCallback((c: TaskComment, i: number) => (
    sliceBetween(threadComments[i - 1]?.createdAt ?? null, c.createdAt).some((m) => m.role !== 'user')
  ), [threadComments, sliceBetween]);

  // ── Drawer body = ONE task-scoped GroupLayout ─────────────────────────────
  // Thread, live browser tabs, Piano and each media attachment are all PANES of
  // the app's REAL PaneTabBar (a single tab bar; native split/resize/drag). The
  // hook owns identity + tiling; the derived (thread/plan/media) pane bodies
  // render through `renderSurface`. Defined here (after the thread deps:
  // sliceBetween/agentBusy/streamPreview…) so every dep array is in scope.
  const browserRef = useRef<TaskBrowserGroupLayout | null>(null);
  const renderThread = useCallback((): React.ReactNode => {
    if (!task) return null;
    // One row, at its index in `threadComments` (the index is what finds the
    // session steps that belong in the gap above it). Same markup folded or not.
    const row = (c: TaskComment, i: number) => (
      <div key={c.id} className="space-y-2">
        {task.assignedTopicId && (
          <SessionSlice msgs={sliceBetween(threadComments[i - 1]?.createdAt ?? null, c.createdAt)} />
        )}
        {c.kind === 'status' ? <StatusEventRow comment={c} /> : <CommentBubble comment={c} onPreview={(p) => browserRef.current?.focusPane(`media:${p}`)} />}
      </div>
    );
    return (
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {threadComments.length === 0 && !task.assignedTopicId && <p className="text-xs text-app-text-muted">{tr('board.task.noComments')}</p>}
        <ThreadRuns comments={threadComments} breaksRun={threadBreaksRun} renderRow={row} />
        {task.assignedTopicId && (
          <SessionSlice
            msgs={sliceBetween(threadComments[threadComments.length - 1]?.createdAt ?? null, null)}
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
                title={stopWord.title}
                className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
              >{busy ? <Spinner size="sm" tone="current" /> : <Square className="h-3 w-3 fill-current" />} {stopWord.label}</button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopAgent/bottomRef are stable enough; the meaningful inputs are listed
  }, [task, threadComments, threadBreaksRun, sliceBetween, agentBusy, streamPreview, busy, tr, stopWord.label, stopWord.title]);

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
  const browser = useTaskBrowserGroupLayout(taskId, { planActive: !!planComment, mediaPaths, renderSurface, threadInline: twoCol });
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
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); openBlockerMenu(blockerChipRef.current); }}
                className={POPOVER_ITEM}
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{
                  task.blockedBy ? tr('board.task.blockedByText', { text: task.blockedBy.text })
                    : task.blockedByTaskId ? tr('board.task.blockedByUnknown')
                      : tr('board.task.blockedBy')
                }</span>
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
          {/* Due copie diverse, una accanto all'altra: il TESTO del task (per
              incollarlo altrove) e il LINK (per ritrovarlo). Stanno in riga e
              non nel menù ⋯ perché sono gesti di un click, non impostazioni. */}
          {task && (
            <button
              onClick={copyTask}
              data-testid="task-copy-text"
              title={copied === 'task' ? tr('board.task.copyTextDone') : tr('board.task.copyTextTitle')}
              aria-label={tr('board.task.copyText')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            >{copied === 'task' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}</button>
          )}
          {task && (
            <button
              onClick={copyLink}
              data-testid="task-copy-link"
              title={copied === 'link' ? tr('board.task.copyLinkDone') : tr('board.task.copyLinkTitle')}
              aria-label={tr('board.task.copyLink')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            >{copied === 'link' ? <Check className="h-4 w-4 text-emerald-400" /> : <Link2 className="h-4 w-4" />}</button>
          )}
          {/* Dalla SCHEDA alla SESSIONE. Il drawer non è la chat dell'agente: è
              la superficie dove si decide, e questo è l'unico gesto che porta
              dall'una all'altra. Quando la sessione non c'è più il bottone non
              sparisce — resta, spento, con la ragione: sparendo lascerebbe
              credere che quel task non sia mai stato lavorato. */}
          {onOpenTopic && canOpenTaskSession(sessionState) && task?.assignedTopicId && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              data-testid="task-open-session-tab"
              title={tr('board.task.openSessionTitle')}
              aria-label={tr('board.task.openSession')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"
            ><MessageSquare className="h-4 w-4" /></button>
          )}
          {shouldExplainMissingSession(sessionState) && (
            <span
              data-testid="task-session-gone"
              title={tr('board.task.sessionGoneTitle')}
              aria-label={tr('board.task.sessionGone')}
              className="rounded p-1.5 text-app-text-faint"
            ><MessageSquare className="h-4 w-4" /></span>
          )}
          {/* Le TAB vincono su `outputUrl`: su un task DISPATCHATO il risultato
              sono le tab che l'agente ha aperto con open_browser_pane — anche
              più d'una, col suo nome — e `outputUrl` (quando c'è) è solo il seme
              della prima. Senza tab vive resta il seme, così il flusso manuale
              non perde nulla. Il bottone le promuove TUTTE. */}
          {workspaceManifest.length > 0 && (
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
      {notice && (
        <div
          data-testid="task-detail-notice"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-300"
        >
          <span>{notice}</span>
          <button aria-label={tr('board.task.closeError')} onClick={() => setNotice(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* Land ACCODATO, non ancora avvenuto. Sta sopra la banda «non su main»
          perché in questa finestra quella banda dice il vero ma non dice tutto:
          il codice non è su main E qualcuno ci sta già lavorando. */}
      {landing && (landing.phase === 'queued' || landing.phase === 'running') && (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          {landing.ahead > 0
            ? <>Land <strong>in coda</strong>: {landing.ahead} {landing.ahead === 1 ? 'fusione' : 'fusioni'} davanti su questa board (toccano tutte main nello stesso checkout).</>
            : <>Land <strong>in corso</strong>: la fusione su main sta girando adesso. L'esito arriva nel thread.</>}
        </div>
      )}
      {landing?.phase === 'failed' && (
        <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          ⚠️ Land <strong>fallito</strong>: {landing.error ?? 'errore sconosciuto'}
        </div>
      )}
      {/* Verdetto dell'audit di landing: un task chiuso il cui lavoro non è su
          main. Sta QUI, in cima al drawer, e non solo come commento nel thread —
          il commento si perde, la banda no.
          E porta la SUA azione. Prima diceva «landa il branch» e non c'era
          niente da premere: il bottone «Landa su main» viveva solo nella zona
          review, cioè in uno stato che il task si è già lasciato alle spalle.
          Una banda che nomina un rimedio irraggiungibile assegna un compito
          invece di offrire una via d'uscita, ed è il motivo per cui otto card
          sono rimaste così per settimane. */}
      {task && showsLandingDebt(task) && (
        <div data-testid="task-not-landed-banner" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          <span className="min-w-0">
            ⚠️ Chiuso ma <strong>{tr('board.task.notOnMain')}</strong>: il commit consegnato
            {task.deliveryCommit ? <> <code className="rounded bg-black/30 px-1">{task.deliveryCommit.slice(0, 8)}</code></> : null}
            {task.deliveryBranch ? <> (branch <code className="rounded bg-black/30 px-1">{task.deliveryBranch}</code>)</> : null}
            {' '}non risulta nel contenuto di main.
          </span>
          <button
            data-testid="task-not-landed-land"
            disabled={busy} onClick={doLand}
            title={landWord.title}
            // Nessun colore di testo proprio: eredita il `text-rose-300` della
            // banda, che è la coppia già provata su questo velo nei due temi.
            // Con un `text-rose-100` il bottone spariva sul tema chiaro, biancore
            // su rosa: l'affordance la fanno il bordo e il fondo, non un testo
            // più chiaro del fondo su cui sta.
            className="flex shrink-0 items-center gap-1 rounded border border-rose-400/40 bg-rose-500/20 px-2 py-0.5 font-medium hover:bg-rose-500/30 disabled:opacity-50"
          ><GitMerge className="h-3 w-3" /> {landWord.label}</button>
        </div>
      )}
      {/* Aveva consegnato e non è più lì: la banda lo dice appena apri la card,
          con chi e quando. Il MOTIVO sta sotto, nel thread, ma il fatto non deve
          più dipendere dal fatto che qualcuno scorra i commenti. */}
      {reopened && (
        <div
          data-testid="task-reopened-notice"
          className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200"
        >
          ↩︎ <strong>Riaperta</strong> {reopened.detail}. Aveva consegnato, e il motivo è nel thread qui sotto.
        </div>
      )}
      {/* IL GUSCIO — chi possiede l'altezza, e dove sta il solo scroll.
          ═══════════════════════════════════════════════════════════════════
          Prima era una pila di sezioni in cui NESSUNO possedeva l'altezza:
          niente `overflow-y` in tutta la catena, quindi ogni sezione si metteva
          un tetto addosso (`max-h-[40%]` sui sottotask, `[38vh]` su Tentativi,
          `[42vh]` su Modifiche, `[50vh]` sull'anteprima) come surrogato dello
          scroll che mancava. Quando i tetti non bastavano la colonna debordava e
          l'`overflow-hidden` della board tagliava — e il primo pezzo tagliato è
          l'ULTIMO figlio: Approva / Rimanda indietro / Landa. I bottoni della decisione
          uscivano dallo schermo.

          Adesso: UN contenitore di scroll (il brief), e fuori da lui solo cose
          che possiedono la propria altezza — lo Spazio di lavoro e la zona di
          decisione+composer, che è `shrink-0` e quindi non esce mai dal viewport
          a nessuna altezza di finestra. Le sezioni tornano accordion puri:
          niente scroll dentro lo scroll.

          TRAPPOLA, non toccare: il GroupLayout deve restare FUORI dallo scroll.
          Dentro un contenitore scrollabile perde l'altezza definita e le sue
          pane collassano a 0. Per costruzione, non per fortuna. */}
      {!task ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="md" tone="current" className="text-app-text-muted" />
        </div>
      ) : (
      <div className={`flex min-h-0 flex-1 ${twoCol ? 'flex-row' : 'flex-col'}`}>
        {/* La colonna del BRIEF. In modo largo è la colonna stretta di sinistra
            (brief + sessione + composer) e il tiling si prende la destra; in modo
            stretto è l'unica colonna e si prende tutto. */}
        <div className={`flex min-h-0 min-w-0 flex-col ${twoCol ? 'w-[22rem] shrink-0 border-r border-app-border' : 'flex-1'}`}>
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="task-brief-scroll">
          {/* L'ANTEPRIMA È LA CONSEGNA, e sta in cima: è la cosa per cui il
              drawer si apre. Sezione sua, maniglia sua — prima viveva appesa
              alla descrizione ma fuori dal suo ramo aperto/chiuso, quindi
              nessun gesto la nascondeva. */}
          {task?.previewImage && (
            <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-preview">
              <button
                onClick={togglePreviewOpen}
                className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
              >
                {previewOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {tr('board.task.deliveryLabel')}
              </button>
              {previewOpen && (
                <PreviewMedia
                  path={task.previewImage}
                  variant="drawer"
                  onOpenTab={() => browser.focusPane(mediaPaneIdFor(task.previewImage!))}
                />
              )}
            </div>
          )}
          {/* L'anteprima MANCA, e c'è un motivo: lo slot della consegna lo dice
              qui, dove si guarderebbe l'immagine. È uno STATO letto dalla card
              (`previewRetiredAt`), non una nota nel thread — quindi sparisce da
              solo appena qualcuno allega un'anteprima nuova, invece di restare
              a dire il contrario come faceva la nota della bonifica. */}
          {!task?.previewImage && task?.previewRetiredAt && (
            <div className="border-b border-app-border px-3 py-2" data-testid="task-preview-retired">
              <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
                {tr('board.task.deliveryLabel')}
              </div>
              <div className="mt-1.5 flex items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200/90">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p className="min-w-0">
                  <span className="font-medium">{tr('board.task.previewRetired')}</span>
                  {task.previewRetiredReason && <span className="text-amber-200/70">: {task.previewRetiredReason}</span>}
                </p>
              </div>
            </div>
          )}
          <div className="border-b border-app-border px-3 py-3">
            {task?.parentTaskId && onOpenTask && (
              <button
                onClick={() => onOpenTask(task.parentTaskId!)}
                title={tr('board.task.openParentCardTitle')}
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
                {/* Stessa precedenza della card: la ragione della coda batte il
                    chip di stato, e le due superfici restano in passo. */}
                {task.queueReason ? (
                  <QueueReasonChip reason={task.queueReason} />
                ) : (task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
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
                {/* Etichette — la correzione a mano di un umano. Qui `invisibile`
                    si puo' scrivere (l'agente non puo': il server lo rifiuta), e
                    una volta scritta a mano la derivazione non la sovrascrive
                    piu' alla consegna successiva. */}
                <button
                  ref={labelBtnRef}
                  onClick={() => setLabelMenuOpen(true)}
                  data-testid="task-labels-chip"
                  title={task.labels.some((l) => l.label === 'invisibile')
                    ? 'Invisibile: non tocca client/src. Con la barra verde la puo\' chiudere il conduttore.'
                    : task.labels.some((l) => l.label === 'visibile')
                      ? 'Visibile: tocca una superficie che si vede. Resta in review finche\' non la guarda un umano.'
                      : task.labels.some((l) => l.label === 'decisione')
                        ? 'Decisione: un piano, una ricerca, un documento. La decide un umano, sempre.'
                        : 'Nessuna etichetta di chiusura: la chiude un umano'}
                  className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/20"
                >
                  <Tag className="h-3 w-3 shrink-0 text-app-text-muted" />
                  <span className="truncate">{task.labels.length ? task.labels.map((l) => l.label).join(', ') : 'etichette'}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
                </button>
                <Menu open={labelMenuOpen} anchorRef={labelBtnRef} onClose={() => setLabelMenuOpen(false)} minWidth={220} role="listbox">
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">Chi la chiude</p>
                  {CLOSER_LABELS.map((l) => (
                    <button
                      key={l} role="option" aria-selected={task.labels.some((x) => x.label === l)}
                      disabled={busy} onClick={() => toggleLabel(l)}
                      className={`${POPOVER_ITEM} disabled:opacity-40`}
                    >
                      <span className="min-w-0 flex-1">{l}</span>
                      {task.labels.some((x) => x.label === l) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                    </button>
                  ))}
                  <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">Genere</p>
                  {KIND_LABELS.map((l) => (
                    <button
                      key={l} role="option" aria-selected={task.labels.some((x) => x.label === l)}
                      disabled={busy} onClick={() => toggleLabel(l)}
                      className={`${POPOVER_ITEM} disabled:opacity-40`}
                    >
                      <span className="min-w-0 flex-1">{l}</span>
                      {task.labels.some((x) => x.label === l) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                    </button>
                  ))}
                </Menu>
                <button
                  ref={modelBtnRef}
                  onClick={() => setModelMenuOpen(true)}
                  data-testid="task-model-chip"
                  title={(task.agentMs > 0 || task.agentTokens > 0)
                    ? `Modello ${task.model ? fmtModel(task.model) : 'Auto'}${task.effort ? ` · sforzo ${task.effort}` : ''} · tempo ${fmtMs(task.agentMs)}${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''} · clicca per cambiare modello`
                    : "Modello dell'agent. Auto = il classificatore opus-first sceglie per task."}
                  className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/20"
                >
                  <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
                  <span className="truncate">{task.model ? fmtModel(task.model) : 'Auto'}{task.effort ? ` · ${task.effort}` : ''}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}`}</span>
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
                {/* «In attesa di…» sta IN RIGA, non dentro il ⋯: è uno stato che
                    cambia la lettura del task (non parte finché l'altro non
                    chiude), e uno stato dentro un menu è uno stato che nessuno
                    vede. Cliccarlo apre lo stesso picker della voce nel ⋯. */}
                {blockedChip && (
                  <button
                    ref={blockerChipRef}
                    onClick={() => openBlockerMenu(blockerChipRef.current)}
                    data-testid="task-blocked-by-chip"
                    title={`${blockedChip.title} · clicca per cambiare il bloccante`}
                    className="flex min-w-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/25"
                  >
                    <Lock className="h-3 w-3 shrink-0" />
                    <span className="max-w-[14rem] truncate">{blockedChip.label}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-amber-300/70" />
                  </button>
                )}
                {/* «Chi la lavora» sta in riga accanto al bloccante, e per lo
                    stesso motivo: su una card in corso senza topic né chip è lo
                    stato che decide se c'è da intervenire. Quando la tiene un
                    antenato il chip ci porta — la domanda successiva è sempre
                    «e chi sarebbe?». */}
                {workChip && (workAncestorId && onOpenTask ? (
                  <button
                    onClick={() => onOpenTask(workAncestorId)}
                    data-testid="task-subtask-work-chip"
                    data-kind="parent-turn"
                    title={`${workChip.title}: clicca per aprire la sua scheda`}
                    className="flex min-w-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-muted hover:bg-white/20"
                  >
                    <UserRound className="h-3 w-3 shrink-0" />
                    <span className="max-w-[14rem] truncate">{workChip.label}</span>
                  </button>
                ) : (
                  <span
                    data-testid="task-subtask-work-chip"
                    data-kind={workChip.kind}
                    title={workChip.title}
                    className={workChip.kind === 'unattended'
                      ? 'flex min-w-0 items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[11px] text-rose-300'
                      : 'flex min-w-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-muted'}
                  >
                    {workChip.kind === 'unattended'
                      ? <AlertTriangle className="h-3 w-3 shrink-0" />
                      : <UserRound className="h-3 w-3 shrink-0" />}
                    <span className="max-w-[14rem] truncate">{workChip.label}</span>
                  </span>
                ))}
                {/* Plan-first / reuse-context vivono nel ⋯ header menu. Il PICKER
                    del bloccante resta qui — portaled, ancorato a chi l'ha
                    aperto (il chip qui sopra, o il ⋯ quando il chip non c'è). */}
                <Menu open={blockerMenuOpen} anchorRef={blockerAnchorRef} onClose={() => setBlockerMenuOpen(false)} align="right" minWidth={220} role="listbox" unmanagedFocus testId="task-blocker-picker">
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
                {/* CHIUSO ≠ VUOTO. La scelta di chiudere è ricordata in
                    localStorage e vale per OGNI card: chiusa una volta, una
                    descrizione da 2.578 caratteri si legge come «non c'è una
                    descrizione utile» (il rilievo su `d4fcce17`). Il chevron non
                    è evidenza di contenuto, quindi da chiuso la maniglia porta
                    con sé la MISURA (quanto testo c'è) e la prima riga vera. */}
                <button
                  onClick={toggleDescOpen}
                  className="flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
                >
                  {descOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {tr('board.task.descLabel')}
                </button>
                {/* La misura sta FUORI dal bottone di proposito: il nome
                    accessibile della maniglia resta «Descrizione» esatto, che è
                    come la cercano le spec e chi naviga a voce. Qui dentro
                    invece serve il numero, perché è il numero a dire che sotto
                    c'è un piano e non due righe. */}
                {!descOpen && (
                  <p
                    onClick={toggleDescOpen}
                    title={tr('board.task.descExpandTitle')}
                    className="mt-1 cursor-pointer truncate text-xs leading-5 text-app-text-secondary hover:text-app-text-heading"
                    data-testid="task-desc-summary"
                  >
                    <span className="text-app-text-faint">{tr('board.task.descChars', { n: fmtCount(task.description.length, locale) })}</span>
                    {descSummary(task.description) && <> · {descSummary(task.description)}</>}
                  </p>
                )}
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
            {/* (L'anteprima stava QUI, sorella della descrizione ma fuori dal
                suo ramo `descOpen`: chiudere la descrizione non la nascondeva.
                Ora ha la sua sezione in cima al brief — «la consegna» è uno slot,
                non un dettaglio della descrizione.) */}
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
              sono") — added on demand from the ⋯ menu (subtaskComposerOpen).
              Accordion puro: il `max-h-[40%] overflow-y-auto` che stava qui era
              il surrogato dello scroll mancante — un elenco di sottotask dentro
              la sua finestrella, dentro un drawer che non scorreva. Adesso scorre
              il brief. */}
          {(children.length > 0 || subtaskComposerOpen) && (
          <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-subtasks">
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
          {hasCodeQuestion(task) && <TaskChangesSection projectId={projectId} taskId={taskId} bump={bump} onSent={onChanged} />}
        </div>
        {/* ── fine del solo scroll verticale ─────────────────────────────── */}
          {/* LA SESSIONE, in modo largo: sta a SINISTRA col task, stretta, dove
              si legge e si decide — non è più una tab che compete con quello che
              devi guardare. Il suo scroll è il suo, fratello del brief: nessuno
              dei due è dentro l'altro. In modo stretto la sessione resta una pane
              del gruppo (`thread:`), come prima. */}
          {twoCol && (
            <div className="flex min-h-0 flex-1 flex-col border-t border-app-border" data-testid="task-session-column">
              {renderThread()}
            </div>
          )}
          {/* "Spazio di lavoro" — the task's ONE GroupLayout (Thread + browser
              tabs + Piano + media, the app's real PaneTabBar). Collapsible like
              the other sections: the tab bar sits UNDER this label. Default open;
              when collapsed the panes hide and a flex spacer keeps the composer
              pinned to the bottom. In modo largo NON è qui: è la colonna di
              destra, a piena altezza (sotto). */}
          {!twoCol && (
          <div className={`flex min-w-0 flex-col ${workspaceOpen ? 'min-h-0 flex-1' : 'shrink-0'}`}>
            <button
              onClick={toggleWorkspaceOpen}
              className="flex w-full shrink-0 items-center gap-1 border-y border-app-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted hover:text-app-text-heading"
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
          )}
          {/* La zona di DECISIONE: `shrink-0`, fuori dallo scroll, ultima della
              colonna. È l'invariante che il guscio esiste per garantire —
              Approva/Rimanda indietro/Landa dentro il viewport a qualunque altezza di
              finestra e con qualunque combinazione di sezioni aperte. */}
          <div className="shrink-0 border-t border-app-border p-2">
            {/* Fuori dalla review le scelte della card ci sono lo stesso — è la
                stessa riga della kanban (`taskChoices`), qui sopra il composer:
                un task in corso si ferma o si fa consegnare, uno bloccato esce
                dall'attesa, senza dover scrivere una frase. */}
            {task.status !== 'review' && (
              <TaskChoiceRow
                task={task} disabled={busy} className="mb-2"
                onDone={() => { void load(); onChanged(); }}
                onError={setError} onNeedText={() => commentRef.current?.focus()}
              />
            )}
            {/* Review zone — decisions live HERE, where the agent's questions
                land (end of the thread), not up in the header. ("Modifiche" moved
                up above the body, out of this composer area.) */}
            {task.status === 'review' && (
              <div className="mb-2 space-y-1.5">
                {replyOptions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {replyOptions.map((opt, i) => (
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
                  {/* Word AND tooltip come from `acceptWord`, which already
                      knows about the red checks: the button cannot say one
                      thing while the de-duplicator subtracts another. */}
                  <button
                    disabled={busy} onClick={() => decide('approve', { force: task.checksState === 'fail' })}
                    title={approveWord.title}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                      task.checksState === 'fail'
                        ? 'bg-amber-600/80 hover:bg-amber-600'
                        : 'bg-emerald-500/80 hover:bg-emerald-500'
                    }`}
                  >{busy ? <Spinner size="sm" tone="current" /> : <ShieldCheck className="h-3.5 w-3.5" />} {approveWord.label}</button>
                  <button
                    disabled={busy} onClick={() => decide('reject')}
                    title={sendBackWord.title}
                    className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                  ><ShieldX className="h-3.5 w-3.5" /> {sendBackWord.label}</button>
                </div>
                {/* Explicit landing — accept + merge the branch on main (local, no
                    push, build server-side). Separate from Approva by design: the
                    merge no longer rides "da sotto" on an approve. */}
                {isAgentReview && (
                  <button
                    disabled={busy} onClick={doLand}
                    title={landWord.title}
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-sky-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  ><GitMerge className="h-3.5 w-3.5" /> {landWord.label}</button>
                )}
                {/* Le uscite che i tre bottoni qui sopra NON hanno: prendersi il
                    task («Serve a me») o archiviarlo. Approva/Rimanda indietro/Landa sono
                    già lì sopra per esteso, quindi si escludono — un doppione
                    non è una scelta in più. */}
                <TaskChoiceRow
                  task={task} disabled={busy} exclude={['land', 'send-back', 'accept', 'redo']}
                  onDone={() => { void load(); onChanged(); }}
                  onError={setError} onNeedText={() => commentRef.current?.focus()}
                />
                {/* Ricattura evidenza: rifà l'anteprima di una card che è GIÀ
                    qui. Prima l'unico modo era rimandarla all'agent e farla
                    rientrare in review — un turno d'agente per una foto. Sta
                    sotto le decisioni, in tono neutro: è un'azione di SERVIZIO
                    sull'evidenza, non una terza decisione. */}
                {isAgentReview && (
                  <button
                    disabled={recapturing} onClick={recapturePreview}
                    title={tr('board.task.recapturePreviewTitle')}
                    data-testid="task-recapture-preview"
                    className="flex w-full items-center justify-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                  >{recapturing ? <Spinner size="sm" tone="current" /> : <Camera className="h-3.5 w-3.5" />} {tr('board.task.recapturePreview')}</button>
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
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : agentBusy ? "Invia all'agent. Lo riceve al prossimo turno (come Claude Code)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview || agentBusy ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Spinner size="md" tone="current" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
        {/* COLONNA DESTRA (solo in modo largo): «quello che devo vedere», a
            piena altezza. Il GroupLayout è figlio diretto — fuori da ogni
            contenitore scrollabile, per la stessa ragione di sempre.

            LO STATO VUOTO NON È DECORAZIONE. Portando la sessione a sinistra, la
            pane `thread:` esce dal gruppo: su un task che non ha nient'altro
            (nessuna tab, nessun piano, nessun allegato) il gruppo resta senza
            pane e la colonna sarebbe un rettangolo vuoto senza spiegazione — il
            modo esatto in cui questa struttura si rompe per prima. Quindi lo si
            dice, con il gesto per riempirla. */}
        {twoCol && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="task-drawer-right">
            {browser.groupLayoutProps.panes.length > 0 ? (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
                <GroupLayout {...browser.groupLayoutProps} />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-xs text-app-text-muted">{tr('board.task.noWorkspaceTabs')}</p>
                <button
                  onClick={browser.addBrowserTab}
                  className="rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20"
                >{tr('board.task.openTab')}</button>
              </div>
            )}
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
  // Questa riga è dove il triage guarda davvero: le colonne mostrano solo le
  // radici (`rootsOnly`), quindi uno step non è MAI una card — l'albero del
  // padre è l'unico posto in cui si vede senza averlo cercato per id.
  //
  // Asimmetrico di proposito. `unattended` è raro e va notato: marcatore rosso.
  // `parent-turn` è la norma (243 step chiusi così in un giorno): un chip su
  // ognuno sarebbe rumore su tutta la checklist, e per giunta ridondante — il
  // padre che la lavora è il drawer che stai guardando. Resta come icona muta,
  // che risponde al passaggio del mouse.
  const work = subtaskWorkChip(node);
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
            data-testid={`subtask-open-${node.id}`}
            title={tr('board.task.openSubtaskCardTitle')}
            className={`min-w-0 flex-1 truncate text-left text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-secondary'}`}>{node.text}</span>
        )}
        {work && (work.kind === 'unattended' ? (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="unattended"
            title={work.title}
            className="flex shrink-0 items-center gap-1 rounded bg-rose-500/20 px-1 py-0.5 text-[10px] text-rose-300"
          ><AlertTriangle className="h-2.5 w-2.5 shrink-0" /> {work.label}</span>
        ) : (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="parent-turn"
            title={work.title}
            className="flex shrink-0 text-app-text-muted"
          ><UserRound className="h-2.5 w-2.5" /></span>
        ))}
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
  // La fence NON è il piano. Il thread la scarta e la card la scarta; questa
  // tab era l'unica delle tre superfici che la rendeva grezza — cioè come un
  // `<pre>` che non va a capo, dove il piano si leggeva scorrendo di lato e
  // «allegata» compariva tagliata a «legata». Stesso trattamento delle altre
  // due: il corpo è markdown, le opzioni sono un elenco.
  const q = parseQuestionBlock(surface.content);
  const outside = q ? surface.content.replace(/```question[\s\S]*?```/, '').trim() : '';
  const body = q ? [outside, q.question].filter(Boolean).join('\n\n') : surface.content;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="min-w-0 rounded-lg border border-violet-500/25 bg-violet-500/5 px-4 py-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">{tr('board.task.proposedPlan')}</p>
        <div className={`min-w-0 break-words text-sm text-app-text ${PLAN_MD_CLS}`} data-testid="plan-surface-body">
          <ChatMarkdown components={{}}>{body}</ChatMarkdown>
        </div>
        {q && q.options.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-violet-500/20 pt-3" data-testid="plan-surface-options">
            {q.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-app-text">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-300/70" />
                <span className="min-w-0 break-words">{opt}</span>
              </li>
            ))}
          </ul>
        )}
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
 * author = the actor — user, agent id, or dispatcher).
 */
export function StatusEventRow({ comment }: { comment: TaskComment }) {
  // Lo stesso parser del server: la destinazione si legge fino al separatore,
  // altrimenti una transizione con la sua ragione (`done→in_progress · il land
  // ha fatto conflitto`) perde l'icona e si stampa cruda.
  const ev = parseStatusEvent(comment.content);
  const to = ev?.to as TaskStatus | undefined;
  const valid = !!to && TASK_STATUSES.includes(to);
  const at = new Date(comment.createdAt);
  // The actor is an id, not a label. Printed raw it was 42 characters of uuid
  // in a row that truncates, so the timestamp on the right won every time.
  const who = commentAuthorLabel(comment.author);
  return (
    <div
      className="flex items-center gap-1.5 px-1 text-[11px] text-app-text-muted"
      title={`${who.agentId ?? who.label} · ${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} /> : <span className="h-1 w-1 shrink-0 rounded-full bg-app-text-faint" />}
      <span className="min-w-0 truncate">
        <span className="text-app-text-secondary">{who.label}</span> → {valid ? STATUS_LABEL[to] : comment.content}
        {/* La ragione: perché la card si è mossa, sulla riga che la muove. */}
        {valid && ev?.reason && <span className="text-app-text-faint"> · {ev.reason}</span>}
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
  const who = commentAuthorLabel(comment.author);
  if (who.kind !== 'user') {
    const system = who.kind === 'system';
    // The tooltip is the only place the speaker appears in this bubble, so it
    // gets the derived label, not the stored author.
    return (
      <div className="pr-8" title={who.label}>
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
    <div className={SETTINGS_PANEL_SHELL} data-testid="board-settings-panel">
      <SettingsPanelHead onClose={onClose} />

      {/* PRIMA sezione, e la sola che NON è di questa board: l'interruttore e il
          tetto sono quelli globali, gli stessi del ▾ in testata. Senza il titolo
          sopra, la prima riga di una lista piatta si leggeva come «auto-dispatch
          di questo progetto» — cioè come un'impostazione che qui non esiste.
          Le righe stanno in `BoardSettingsSections.tsx` perché il pannello della
          board generale monta le STESSE: un blocco, due pannelli. */}
      <SettingsSection label={tr('board.settings.sec.global')} first>
        <GlobalSettingsSection dispatchOn={dispatchOn} onToggleDispatch={onToggleDispatch} />
        {dispatchOn && (
          <p className="text-[11px] text-amber-300/80">{tr('board.settings.dispatchOnActive')}</p>
        )}
      </SettingsSection>

      <SettingsSection label={tr('board.settings.sec.agent')}>
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

      {/* `<label>` → `<div>`: da quando il controllo è il `Select` dell'app e
          non un elemento di modulo nativo non c'è più niente da associare, e
          una `<label>` intorno a un bottone renderebbe cliccabile — cioè
          apribile — anche il testo della riga. */}
      <div className="flex items-center justify-between gap-2" title={tr('board.settings.modelTitle')}>
        <span>{tr('board.settings.model')}</span>
        <Select
          value={s.dispatchModel || 'auto'}
          onChange={(v) => patch({ dispatchModel: v })}
          ariaLabel={tr('board.settings.model')}
          align="right"
          className="max-w-[55%]"
          options={[
            { value: 'auto', label: tr('board.settings.modelAuto') },
            ...models.map((m) => ({ value: m, label: friendlyModelLabel(m) })),
          ]}
        />
      </div>

      {/* Gemella della tendina in Impostazioni → Aspetto, e per «gemella» si
          intende lo stesso VALORE EFFETTIVO: «Come le Impostazioni» non copia
          la scelta globale, la EREDITA (il ripiego lo fa il server, in un punto
          solo). Copiare il valore vorrebbe dire che cambiare la preferenza
          globale non muove le board che l'avevano già letta. */}
      <div
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.responseLanguageTitle')}
      >
        <span>{tr('board.settings.responseLanguage')}</span>
        <Select
          value={s.language || 'inherit'}
          onChange={(v) => patch({ language: v })}
          ariaLabel={tr('board.settings.responseLanguage')}
          align="right"
          className="max-w-[55%]"
          testId="board-language"
          options={[
            { value: 'inherit', label: tr('board.settings.langInherit') },
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
        />
      </div>

      <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.fullMcpTitle')}>
        <span>{tr('board.settings.fullMcp')}</span>
        <input type="checkbox" checked={s.dispatchMcp === 'inherit'} onChange={(e) => patch({ dispatchMcp: e.target.checked ? 'inherit' : 'bridge-only' })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>
      </SettingsSection>

      <SettingsSection label={tr('board.settings.sec.where')}>
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
      </SettingsSection>

      {/* La modalità notturna ha una CARD sua, non una casella in mezzo alle
          altre: l'interruttore è la parte piccola, la parte utile è lo stato —
          sta dispacciando o è in attesa, e per quale motivo. Vedi
          `NightModeCard.tsx`. */}
      <SettingsSection label={tr('board.settings.sec.when')}>
        <NightModeCard
          projectId={projectId}
          enabled={!!s.nightMode}
          until={s.nightModeUntil || '10:00'}
          onChange={patch}
        />
      </SettingsSection>

      {/* Auto-merge e checks stanno insieme perché parlano dello stesso momento:
          l'agent ha consegnato. Uno decide se quel lavoro entra in main da solo,
          l'altro cosa deve passare prima che entri in review. Erano separati da
          una riga sulla MCP, che è di un altro discorso. */}
      <SettingsSection label={tr('board.settings.sec.delivery')}>
        <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.autoMergeTitle')}>
          <span>{tr('board.settings.autoMerge')}</span>
          <input type="checkbox" checked={s.dispatchAutoMerge} disabled={!s.dispatchUseWorktree} onChange={(e) => patch({ dispatchAutoMerge: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500 disabled:opacity-40" />
        </label>
        <ReviewChecksField checks={s.reviewChecks} onSave={(reviewChecks) => patch({ reviewChecks })} />
      </SettingsSection>
    </div>
  );
}

/**
 * UNA SEZIONE DEL PANNELLO — un titolo e le sue righe.
 *
 * Il pannello era dieci righe di seguito, tutte con lo stesso peso: effort,
 * modello, lingua, worktree, fan-out, notturna, auto-merge, MCP, checks. Senza
 * gerarchia non si legge, si scandisce — e soprattutto la prima riga era
 * l'interruttore GLOBALE, che in cima a una lista piatta si legge come
 * un'impostazione di questa board («le impostazioni della board non mi sembrano
 * ben fatte», Attilio 13/08).
 *
 * Il titolo non è decorazione: è la risposta alla domanda che ogni riga
 * poneva da sola — «questo vale per chi?». Il filetto sopra separa i gruppi
 * SENZA aggiungere una seconda scatola: il pannello è già dentro un bordo, e un
 * riquadro dentro un riquadro renderebbe ogni gruppo un oggetto a sé.
 */
function SettingsSection({ label, first, children }: { label: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div className={first ? 'space-y-2' : 'space-y-2 border-t border-app-border-subtle pt-2'}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{label}</p>
      {children}
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
