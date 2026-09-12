import { pickPlanComment } from './planPanel';
import { reconcileAcknowledgedComments } from './acknowledgedComments';
import type { TaskCommentAcknowledgement } from '../../../../shared/task-comment-ack';
import { memo, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore, type TouchEvent as ReactTouchEvent } from 'react';
import { useT, useLocale } from '../../hooks/useT';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useOwnerName } from '../../hooks/useOwnerName';
import { actionOriginDisplay, authorDisplay } from '../../lib/authorDisplay';
import { AlertTriangle, ArrowUp, ArrowUpRight, Bot, Camera, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, GitCompare, GitMerge, Globe, Hourglass, Lock, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Paperclip, Plus, Rocket, Send, Server, ShieldCheck, Sparkles, Square, StickyNote, Tag, TriangleAlert, UserRound, WifiOff, X } from 'lucide-react';
import { SectionHeader, useSectionOpen } from './sectionAccordion';
import { ChatMarkdown } from '../ChatMarkdown';
import { PlanSurface } from './PlanSurface';
import { Menu } from '../Shared/Menu';
import { MorphText } from '../Shared/MorphText';
import { ShareControl } from '../Share/ShareControl';
import { Spinner } from '../Shared/Spinner';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { getMediaUrl } from '../../lib/api';
import { dragCarriesFiles, filesFromDrop, imagesFromClipboard, uploadAttachment, MAX_ATTACHMENTS, type StagedAttachment } from '../../lib/attachments';
import { isImagePath, isPdfPath, isVideoPath } from '../../lib/mediaKind';
import { isSupersededPreviewNote } from '../../../../shared/preview-retirement';
import { isResolvedParkedQuestion } from '../../../../shared/parked-question';
import { isDoneThreadService, isFreshSessionNote, isServiceComment } from '../../../../shared/task-comment-service';
import { questionToProse } from '../../../../shared/question-prose';
import { pendingQuestionComment } from '../../../../shared/board';
import { ThreadRuns } from './ThreadRuns';
import { copyText } from '../../lib/clipboard';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { buildTaskLink } from '../../lib/openTaskLink';
import { canOpenTaskSession, shouldExplainMissingSession, type TaskSessionState } from '../../lib/taskSession';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { enqueueProjectBrowserNavigate, isProjectWindowMounted } from '../../state/pane/adapters';
import { useTaskBrowserTabs, liveTabs, workspaceTwinContextId } from '../../state/taskBrowserTabs';
import { paneIdToContextId } from '../../state/taskBrowserLayout';
import { useTaskModelCatalog } from '../../hooks/useTaskModelCatalog';
import { TaskModelMenuOptions } from './TaskModelMenuOptions';
import { machineLabel, nodesOf, useMachines } from '../../state/machinesStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { DictationButton } from '../Shared/DictationButton';
import { emptyThreadKey } from './emptyThread';
import { LandingNotice } from './LandingNotice';
import { landingBand } from './landingBand';
import { useLandingTicket } from './useLandingTicket';
import { boardApi, commentAuthorLabel, diffTotals, hasCodeQuestion, showsLandingDebt, showsDeployProposal, STATUS_LABEL, TASK_STATUSES, isAgentWorking, isThreadSpeech, parseQuestionBlock, parseStatusEvent, isProjectlessId, boardDrafts, systemDeliveryNote, blockedByChip, subtaskWorkChip, subtaskQueueChip, subtaskOpenable, reopenedChip, attemptHasWork, priorityAwaitingAgent, CLOSER_LABELS, KIND_LABELS, type TaskLabel, type BoardTask, type TaskStatus, type TaskComment, type BoardProjectRef, type DiffBundle, type DiffNote, type CheckRun, type TaskAttempt } from '../../lib/board';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { UnifiedDiff } from './UnifiedDiff';
import { collectTaskMediaPaths, hasConversationMedia } from './taskMedia';
import { TaskChoiceRow } from './TaskChoiceRow';
import { taskActionErrorMessage } from './taskActionError';
import { usableQuestionOptions } from './taskChoices';
import { showsStoppedChip } from './stoppedChip';
import { drawerSurfaceLabels, reviewDecisionButtons, taskActionWord } from './taskActionWords';
import { TASK_ACTION_ICON } from './taskActionIcons';
import { manualStatusTarget } from '../../lib/boardOrder';
import { formatReviewNotes } from './reviewNotes';
import { COMPACT_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, DISPATCH_CHIP, mediaPaneIdFor, type TaskSurface } from './constants';
import { fmtModel, commentTime, fmtMs, fmtTok, fmtUpdatedAt, autoGrow, attemptStat, taskCopyText, descSummary, fmtCount } from './format';
import { StatusIcon, DispatchChip, QueueReasonChip } from './atoms';
import { getSessionMessagesFromStore, subscribeSession } from '../../state/messageStore';
import { MessageContent } from '../MessageContent';
import { taskSessionSegments } from './taskSessionPresentation';
import { taskSessionRuns, type TaskSessionRunItem } from './taskSessionRuns';
import { TaskWorkAccordion } from '../Chat/TaskWorkAccordion';
import { COMPOSER_CARD, COMPOSER_TEXTAREA } from '../Chat/composerStyles';
import type { ChatMessage, WSMessage } from '../../types';
import { holdTopic } from '../../state/topicSubscriptions';

/** One shared empty array: a new one per read would loop `useSyncExternalStore`. */
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
import { SessionLiveRow } from './SessionLiveRow';
import { mergeTaskTimeline, type TimelineItem } from './taskTimeline';
import { commentChip, commentChipTestId } from './chipKey';
import { deliveryNotesToFold } from './taskDeliveryNotes';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { DispatchEnvelopeRow } from '../Chat/DispatchEnvelopeRow';
import { usePaneAlive } from '../../state/paneLiveness';
import { ProjectPickerBody } from './ProjectPicker';
import { addBoardProject, projectNameFromId, useBoardProjects, UNKNOWN_PROJECT_NAME } from '../../lib/boardProjectsStore';
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
/**
 * Badge sull'esito della sonda sull'output_url.
 *
 * Tre stati, tre comportamenti:
 *   live    - silenzio (il link funziona, non serve avvertire)
 *   dead    - avviso rosso; il link NON compare (vedere useEffect sotto)
 *   unknown - silenzio (mai sondata, non sappiamo se funziona)
 *
 * Render solo in review e solo se c'è un output_url.
 */
function OutputUrlProbeNotice({ task }: { task: BoardTask }) {
  const tr = useT();
  if (!task.outputUrl || task.urlProbeStatus !== 'dead') return null;
  return (
    <div className="flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1.5 text-mini text-red-300">
      <WifiOff className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.previewUnreachable')}</span>{' '}
        {tr('board.task.previewUnreachableDetail', { url: task.outputUrl })}
      </span>
    </div>
  );
}

function SystemDeliveryNotice({ task }: { task: BoardTask }) {
  const tr = useT();
  if (task.deliveredBy !== 'system') return null;
  return (
    <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-mini text-amber-200">
      <Hourglass className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.movedToReviewBySystem')}</span>{' '}
        {systemDeliveryNote(task.deliveredReason, tr)}
      </span>
    </div>
  );
}

/**
 * La ZONA DI DECISIONE del drawer: Approva, Rimanda indietro, Landa.
 *
 * Il verde è una raccomandazione, e su una card che nessuno ha consegnato era
 * la raccomandazione sbagliata: «Approva» chiudeva un task senza guardare che
 * sotto non c'era niente (misurato il 13/08 su c0849d9d). Lì il verde passa a
 * «Rimandalo avanti», che è la sola uscita che fa avanzare il lavoro, e le
 * altre due restano dove sono, neutre e col nome dell'eccezione che sono.
 *
 * Chi è il verde e come si chiamano NON si decide qui: viene da
 * `reviewDecisionButtons`, la stessa funzione che alimenta il de-duplicatore
 * delle risposte rapide. Scritte due volte, le due liste divergono, e il
 * gemello che RIGETTA torna accanto al bottone vero (commento 2eff6a44).
 */
function ReviewDecisionRow({ task, busy, onAccept, onSendBack, onLand }: {
  task: BoardTask;
  busy: boolean;
  onAccept: () => void;
  onSendBack?: () => void;
  onLand: () => void;
}) {
  const tr = useT();
  const d = reviewDecisionButtons(task, tr);
  // Un solo verde, e il rosso dei checks lo tinge d'ambra solo quando il verde
  // È «Approva»: su «Rimandalo avanti» l'ambra prometterebbe un'eccezione che
  // quel bottone non fa.
  const primaryCls = task.checksState === 'fail' && d.primary === 'accept'
    ? 'bg-amber-700 hover:bg-amber-800 text-white'
    : 'bg-emerald-700 hover:bg-emerald-800 text-white';
  const neutralCls = 'bg-white/10 text-app-text hover:bg-white/20';
  // I GLIFI VENGONO DALLA TABELLA UNICA, non da qui. Erano `ShieldCheck` e
  // `ShieldX`, cioè gli scudi dei CHECKS: sulla stessa schermata lo scudo verde
  // è già il chip «checks verdi», quindi il bottone che chiude la card portava
  // il segno di un'altra affermazione. Adesso la spunta è «chiudi» e la freccia
  // è «torna indietro», le stesse identiche della riga di scelte sulla card.
  const AcceptIcon = TASK_ACTION_ICON['accept'];
  const SendBackIcon = TASK_ACTION_ICON['send-back'];
  const buttons = [
    {
      id: 'accept' as const, word: d.accept, testId: 'task-approve',
      icon: <AcceptIcon className="h-3.5 w-3.5" />, onClick: onAccept,
    },
    {
      id: 'send-back' as const, word: d.sendBack, testId: 'task-send-back',
      icon: <SendBackIcon className="h-3.5 w-3.5" />, onClick: onSendBack,
    },
  ];
  // Il verde va per primo: è il posto dove il pollice arriva da solo, ed è
  // proprio quel posto che sulla card non consegnata portava ad approvare.
  const ordered = d.primary === 'send-back' ? [buttons[1], buttons[0]] : buttons;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {ordered.filter((b) => b.id !== 'send-back' || onSendBack).map((b) => {
          const isPrimary = b.id === d.primary;
          return (
            <button
              key={b.id}
              data-testid={b.testId}
              disabled={busy} onClick={b.onClick}
              title={b.word.title}
              className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-compact leading-4 disabled:opacity-50 ${
                isPrimary ? `font-medium ${primaryCls}` : neutralCls
              }`}
            >{busy && isPrimary ? <Spinner size="sm" tone="current" /> : b.icon} {b.word.label}</button>
          );
        })}
      </div>
      {/* Explicit landing — accept + merge the branch on main (local, no push,
          build server-side). Separate from Approva by design: the merge no
          longer rides "da sotto" on an approve. Azzurro finché è una consegna:
          su una card che nessuno ha consegnato scende a neutro come Approva. */}
      {d.land && (
        <button
          disabled={busy} onClick={onLand}
          data-testid="task-land"
          title={d.land.title}
          className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-compact leading-4 disabled:opacity-50 ${
            d.primary === 'accept' ? 'bg-sky-700 font-medium text-white hover:bg-sky-800' : neutralCls
          }`}
        ><GitMerge className="h-3.5 w-3.5" /> {d.land.label}</button>
      )}
    </>
  );
}

function ChecksSection({ task }: { task: BoardTask }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  if (!task.checksState) return null;

  if (task.checksState === 'running') {
    const progress = task.checksProgress;
    return (
      <div className="flex items-center gap-1.5 rounded bg-white/5 px-2 py-1.5 text-mini text-app-text-heading">
        <Spinner size="sm" tone="current" className="shrink-0 text-app-text-secondary" />
        {progress
          ? tr('board.task.checks.runningProgress', { done: progress.done, total: progress.total })
          : tr('board.task.checks.running')}
      </div>
    );
  }

  const runs = task.checks ?? [];
  const failed = runs.find((r) => !r.ok);
  const failedIndex = failed ? runs.indexOf(failed) : -1;
  const failedLabel = failed
    ? failed.name !== failed.cmd && failed.name.length <= 64
      ? failed.name
      : tr('board.task.checks.numbered', { n: failedIndex + 1 })
    : null;
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
      <div className="flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1.5 text-mini text-emerald-200">
        <Check className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {tr('board.task.checks.pass')}{at}{runs.length ? `: ${runs.map((r) => r.name).join(', ')}` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded bg-rose-500/10 text-mini text-rose-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-white/5"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          {tr('board.task.checks.fail')}{at}{failed ? `: ${failedLabel} (${short(failed)})` : ''}
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2">
          {runs.map((r, i) => (
            <div key={i}>
              <div className={r.ok ? 'text-emerald-300' : 'text-rose-200'}>
                {r.ok ? <Check size={14} className="inline-block text-emerald-300" aria-hidden="true" /> : <X size={14} className="inline-block text-rose-300" aria-hidden="true" />} <code className="font-mono">{r.cmd}</code>{r.ok ? '' : `: ${short(r)}`}
              </div>
              {!r.ok && (r.tail || r.spawnError) && (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1.5 font-mono text-micro leading-snug text-app-text-heading">
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  // VINCE L'ULTIMA RICHIESTA, non l'ultima risposta.
  //
  // `bump` scatta a ogni aggiornamento del task e arriva a raffica mentre un
  // agente lavora; il diff di un worktree grosso non e' istantaneo. Due
  // `taskDiff` in volo insieme sono normali, e senza questo contatore il
  // pannello «Modifiche» mostrava quella che tornava per SECONDA — cioe' poteva
  // restare su un diff piu' vecchio di quello che il server aveva appena
  // calcolato, finche' un altro bump non lo salvava per caso.
  //
  // Un contatore e non il solito `alive`: `alive` copre lo smontaggio, non il
  // sorpasso fra due richieste vive.
  const diffReq = useRef(0);
  const fetchDiff = useCallback(() => {
    // Il bundle precedente NON si azzera mentre si ricarica: `bump` scatta a ogni
    // aggiornamento del task, e svuotare qui faceva sparire e riapparire il
    // pannello sotto le mani di chi stava leggendo.
    const mio = ++diffReq.current;
    boardApi.taskDiff(projectId, taskId)
      .then((b) => { if (mio === diffReq.current) setState(b); })
      .catch(() => { if (mio === diffReq.current) setState('error'); });
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
      await boardApi.comment(projectId, taskId, formatReviewNotes(notes, tr));
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
    // Niente da guardare: UNA riga spenta, non una maniglia che si apre sul
    // vuoto. Resta però scritta — «la card non ha prodotto codice» e «non ho
    // potuto guardare» sono due verdetti opposti, e su una consegna in review
    // il silenzio li confonderebbe.
    return (
      <div className="shrink-0 border-b border-app-border px-3 py-2">
        <span
          data-testid="task-changes-empty"
          // Il motivo può essere più largo del chip: tagliato a vista, intero
          // qui sotto. Un chip che tronca senza tooltip è un'informazione che
          // esiste e non si può leggere.
          title={`${label} · ${why}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-mini text-app-text-muted"
        >
          <GitCompare className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate text-app-text-faint">· {why}</span>
        </span>
      </div>
    );
  }
  const fileCount = totals.files;
  const from = bundle.source === 'landed-merge' ? tr('board.task.changes.fromMerge')
    : bundle.source === 'delivery-commit' ? tr('board.task.changes.fromDelivery')
    : null;
  /**
   * UN TASTINO, E IL DIFF IN UNA TENDINA.
   *
   * Era un accordion nel flusso del brief: aperto, un diff da trenta file
   * spingeva sotto l'orizzonte tutto ciò che veniva dopo — la sessione, i
   * bottoni della decisione — e per tornare a decidere bisognava richiuderlo.
   * Un diff non è una sezione della scheda: è una cosa che si CONSULTA mentre
   * si decide, e quindi va aperta sopra, non dentro.
   *
   * Il chip porta i numeri anche da chiuso: quanti file, quanto grosso, e se
   * hai note in sospeso. Quelli sono la risposta alla domanda che si fa prima
   * di aprire, e con la tendina chiusa restano l'unica traccia del lavoro
   * scritto a mano.
   */
  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <button
        ref={triggerRef}
        onClick={() => setOpen((s) => !s)}
        data-testid="task-changes-trigger"
        title={tr('board.task.changes.openTitle')}
        className="flex max-w-full items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/10"
      >
        <GitCompare className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{label}</span>
        <span className="shrink-0 text-app-text-faint">· {tr(fileCount === 1 ? 'board.task.changes.files.one' : 'board.task.changes.files.many', { n: fileCount })}</span>
        {/* Il totale sta in TESTA perché è la prima domanda di chi rivede
            («quanto è grosso?») e perché è l'unico numero completo: la lista si
            può troncare, questo no. */}
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-emerald-400">+{totals.additions}</span> <span className="text-red-400">−{totals.deletions}</span>
        </span>
        {from && (
          <span className="min-w-0 truncate rounded bg-white/5 px-1 text-nano text-app-text-faint">{from}</span>
        )}
        {notes.length > 0 && (
          <span className="shrink-0 rounded bg-indigo-500/20 px-1 text-nano text-indigo-300">
            {tr('board.task.changes.pending', { n: notes.length })}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
      </button>
      {/* `unmanagedFocus`: dentro c'è un diff con le sue maniglie per file e il
          composer delle note — la navigazione a frecce di un menu di comandi
          qui litigherebbe con lo scroll. */}
      <Menu
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        minWidth={520}
        unmanagedFocus
        testId="task-changes-panel"
        ariaLabel={label}
        className="w-[min(46rem,92vw)] max-h-[70vh] overflow-y-auto p-2"
      >
        <UnifiedDiff bundle={bundle} defaultOpenFirst review={review} />
        {notes.length > 0 && (
          <div className="mt-1.5 flex items-center gap-2 rounded border border-indigo-500/25 bg-indigo-500/5 px-2 py-1.5">
            <span className="min-w-0 flex-1 text-mini text-app-text-heading">
              {notesError
                ? <span className="text-rose-300">{tr('board.task.changes.sendFailedInline', { msg: notesError })}</span>
                : tr(notes.length === 1 ? 'board.task.changes.notes.one' : 'board.task.changes.notes.many', { n: notes.length })}
            </span>
            <button
              onClick={() => setNotes([])}
              disabled={sendingNotes}
              className="rounded px-2 py-0.5 text-mini text-app-text-secondary hover:text-app-text disabled:opacity-40"
            >
              {tr('board.task.changes.discard')}
            </button>
            <button
              onClick={sendNotes}
              disabled={sendingNotes}
              className="flex items-center gap-1 rounded bg-indigo-500/25 px-2 py-0.5 text-mini text-indigo-100 hover:bg-indigo-500/40 disabled:opacity-40"
            >
              {sendingNotes ? <Spinner size="sm" tone="current" /> : <Send className="h-3 w-3" />}
              {tr('board.task.changes.send')}
            </button>
          </div>
        )}
      </Menu>
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
      <div className="flex items-center gap-1 text-mini font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.task.attempts')} <span className="normal-case tracking-normal text-app-text-faint">· {tr('board.task.attempts.parallel', { n: attempts.length })}</span>
        {running > 0 && (
          <span className="ml-1 flex items-center gap-1 rounded bg-amber-500/15 px-1 text-nano normal-case tracking-normal text-amber-300">
            <Spinner size="xs" tone="current" /> {tr('board.task.attempts.running', { n: running })}
          </span>
        )}
      </div>
      {!decided && running === 0 && (
        <p className="mt-1 text-mini text-app-text-secondary">
          {tr('board.task.attempts.pickHint')}
        </p>
      )}
      {error && <p className="mt-1 text-mini text-rose-300">{error}</p>}
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
              <div className="flex items-center gap-1.5 text-mini">
                <span className="font-medium text-app-text">{tr('board.task.attempt.n', { n: a.idx })}</span>
                {won && <span className="rounded bg-emerald-500/25 px-1 text-nano text-emerald-200">{tr('board.task.attempt.selected')}</span>}
                {dead && <span className="rounded bg-white/10 px-1 text-nano text-app-text-secondary">{tr('board.task.attempt.discarded')}</span>}
                <span className="text-app-text-muted">{attemptStat(a, tr)}</span>
                {a.branch && <span className="truncate font-mono text-micro text-app-text-faint">{a.branch}</span>}
              </div>
              {a.summary && (
                <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-mini leading-snug text-app-text-heading">{a.summary}</p>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                {work && (
                  <button
                    onClick={() => setOpenDiff((cur) => (cur === a.id ? null : a.id))}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-mini text-app-text-heading hover:bg-white/10"
                  >{tr(openDiff === a.id ? 'board.task.attempt.closeDiff' : 'board.task.attempt.openDiff')}</button>
                )}
                {/* «Apri la chat» diceva meno di quel che fa: è la SESSIONE di
                    QUESTO tentativo, e come ogni sessione può non esserci più. */}
                {a.topicId && onOpenTopic && !dead && canOpenTaskSession(resolveSession(a.topicId)) && (
                  <button
                    onClick={() => onOpenTopic(a.topicId!)}
                    title={tr('board.task.openSessionTitle')}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-mini text-app-text-heading hover:bg-white/10"
                  >{tr('board.task.openSession')}</button>
                )}
                {a.topicId && !dead && shouldExplainMissingSession(resolveSession(a.topicId)) && (
                  <span
                    title={tr('board.task.sessionGoneTitle')}
                    className="rounded bg-white/5 px-1.5 py-0.5 text-mini text-app-text-faint"
                  >{tr('board.task.sessionGone')}</span>
                )}
                {!decided && running === 0 && a.topicId && (
                  <button
                    onClick={() => pick(a.id)}
                    disabled={!!picking}
                    data-testid="task-attempt-pick"
                    title={work ? undefined : tr('board.task.attempt.emptyTitle')}
                    className="ml-auto flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-mini font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
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
  if (state === 'loading') return <div className="mt-1.5 flex items-center gap-1 text-mini text-app-text-muted"><Spinner size="sm" tone="current" /> {tr('board.task.loadingDiff')}</div>;
  if (state === 'error') return <p className="mt-1.5 text-mini text-rose-300">{tr('board.task.diffUnreadable')}</p>;
  // Un tentativo si legge SOLO dal suo worktree (i riferimenti durevoli parlano
  // del vincitore), quindi qui i codici sono due: «non ha prodotto niente» e
  // «non ricostruibile» — e restano distinti anche in una riga sola.
  if (state.stat.length === 0) {
    const why = state.code === 'no_changes' || !state.code
      ? tr('board.task.changes.empty')
      : tr('board.task.changes.unreadable');
    return <p className="mt-1.5 text-mini text-app-text-muted">{why}</p>;
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

export function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic, onMessage, loadHistory, sessionState = 'unknown', focusPaneId }: {
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
   * The live wire, as the host window hands it out. The drawer listens for one
   * frame only: the `stream:end` of its own session, which is when the stored
   * blocks and tool rows become readable.
   */
  onMessage?: (handler: (msg: unknown) => void) => () => void;
  /** Reads a session's history into the chat store (`hooks/useChat.ts`). */
  loadHistory?: (sessionKey: string) => Promise<boolean>;
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
}) {
  const tr = useT();
  const locale = useLocale();
  // Come si chiama chi usa l'app. Il thread firmava le TUE righe «user» pur
  // sapendolo: qui il nome entra una volta e scende a chi disegna chi ha parlato.
  const ownerName = useOwnerName();
  // La parola di «Landa su main» per la BANDA del lavoro non landato, che è
  // un'altra superficie: parla di una card già chiusa, dove non c'è nessuna
  // eccezione da segnalare. I tre bottoni della zona di decisione prendono le
  // loro parole da `reviewDecisionButtons` (in `ReviewDecisionRow`), perché lì
  // cambiano con lo stato della card e devono restare uguali a quelle che il
  // de-duplicatore delle risposte rapide sottrae.
  const landWord = taskActionWord('land', tr);
  // Le tab del task, lette QUI e non dalla `browser` più in basso: il manifesto
  // serve a callback definiti molto prima di quel hook.
  const taskTabsState = useTaskBrowserTabs(taskId);
  const liveTaskTabs = useMemo(() => liveTabs(taskTabsState), [taskTabsState]);
  const [task, setTask] = useState<BoardTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const acknowledgedComments = useRef(new Map<string, TaskComment>());
  const [commentReceipt, setCommentReceipt] = useState<{ id: string; delivery: TaskCommentAcknowledgement['delivery'] | 'saved' } | null>(null);
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
  //
  // E si disegnano in fondo, nella zona di DECISIONE, non in testa al drawer:
  // Approva sta là sotto, fuori dallo scroll, e con un thread lungo una banda
  // in cima al drawer è a schermate di distanza da chi l'ha appena premuto.
  const [error, setError] = useState<string | null>(null);
  /**
   * A move that did NOT land where it was aimed. The board's own band, one
   * level in: nothing failed, so it is not an error, and the sentence is the
   * same one the column drag shows, from the same key.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const showError = (e: unknown) => setError(taskActionErrorMessage(e, tr));
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
  // The drawer's remembered sections, the sixth included. The shape lives in
  // `sectionAccordion.tsx`: these were five hand-written copies of the same
  // useState + localStorage + button, which is exactly why the sixth ("File
  // consegnati") had no handle at all.
  const [descOpen, toggleDescOpen] = useSectionOpen('Desc');
  const [subtasksOpen, toggleSubtasksOpen, setSubtasksOpen] = useSectionOpen('Subtasks');
  const [downloadsOpen, toggleDownloadsOpen] = useSectionOpen('Downloads');
  // Presentation is local to this opening, never persisted into shared tabs.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [workspaceOpen, setWorkspaceOpen] = useState(!!focusPaneId);
  const toggleWorkspaceOpen = () => setWorkspaceOpen((open) => !open);
  useEffect(() => {
    setDetailsOpen(false);
    setDeliveryOpen(false);
    setWorkspaceOpen(!!focusPaneId);
  }, [taskId, focusPaneId]);
  /**
   * A REVIEW DRAFT DOES NOT STAY HIDDEN BEHIND A TAB.
   *
   * `TaskChangesSection` opens itself when there are unsent notes — "otherwise
   * the only trace of that work sits behind a closed bar". But since the diff
   * moved into the DELIVERY band that component is not even mounted while the
   * band is collapsed, so after a reload the written-and-unsent work vanished
   * from view and its own effect could never run. Same question, one level up:
   * the band opens, then the section opens itself as before.
   *
   * Runs after the reset above (declaration order), so it is not undone by it.
   */
  useEffect(() => {
    let alive = true;
    boardDrafts.getReviewNotes(taskId)
      .then((n) => { if (alive && n.length) setDeliveryOpen(true); })
      .catch(() => { /* no draft, or no store: the band stays as it was */ });
    return () => { alive = false; };
  }, [taskId]);
  // Only an explicitly opened workspace may share the wide drawer.
  const viewportWide = useMediaQuery('(min-width: 1280px)');
  const twoCol = wide && viewportWide && workspaceOpen;
  // The conversation owns the main column; external surfaces are optional.
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * FOLLOW THE AGENT, BUT ONLY IF THE READER IS ALREADY AT THE BOTTOM.
   *
   * The conversation used to jump to the end on every change of
   * `comments.length`, through a `scrollIntoView` on a sentinel: that scrolls
   * every ANCESTOR too, and now that the agent's steps stream into this same
   * list a new row arrives several times a second. Scrolling up to re-read what
   * the agent said two minutes ago must not be undone by the next token.
   * `scrollTop` on the one scroller, and an 80px grace band for "at the bottom".
   */
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const detailsScrollRequested = useRef(false);
  useLayoutEffect(() => {
    if (detailsScrollRequested.current && (detailsOpen || deliveryOpen) && !workspaceOpen && threadScrollRef.current) {
      threadScrollRef.current.scrollTop = 0;
      detailsScrollRequested.current = false;
    }
  }, [detailsOpen, deliveryOpen, workspaceOpen]);

  // Match ChatPane: measure the floating composer instead of guessing a footer height.
  const composerAreaRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const el = composerAreaRef.current;
    if (!el) return;
    let previousWidth = -1;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width !== previousWidth) { previousWidth = width; autoGrow(commentRef.current); }
      setComposerHeight(el.getBoundingClientRect().height);
      const scroll = threadScrollRef.current;
      if (scroll && stickRef.current) scroll.scrollTop = scroll.scrollHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [task?.id, workspaceOpen, twoCol]);

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

  /**
   * The read that FAILED, kept instead of swallowed.
   *
   * Two different sentences come out of one state, and which one depends on
   * whether we ever had the row. With no `task` the drawer used to sit on a
   * full-height spinner forever: the spinner promised the row was coming, so
   * nobody had a reason to close and reopen, which was the only way out. With a
   * `task` already on screen the drawer is showing data from BEFORE the failed
   * refresh, and this is the tail of every mutation (`decide`, `doLand`, `send`,
   * `saveTitle`, `changeStatus`, `toggleLabel`): the action landed on the
   * server and the drawer would keep the old row without saying so.
   */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const { task, comments, children } = await boardApi.get(projectId, taskId);
      if (generation !== loadGeneration.current) return;
      setTask(task); setComments(reconcileAcknowledgedComments(comments, acknowledgedComments.current)); setChildren(children ?? []);
      // After revalidation, queued/delivered follows the task and session
      // envelopes again; a transient receipt cannot outlive that evidence.
      setCommentReceipt((receipt) => receipt?.delivery === 'queued' ? null : receipt);
      setLoadFailed(null);
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      // The RAW message goes in, translated at render: putting `tr` in these
      // deps would rebuild `load` when the English catalogue lands, and `load`
      // is a dependency of the fetch-on-mount effect below.
      setLoadFailed(e instanceof Error ? e.message : String(e ?? ''));
    }
  }, [projectId, taskId]);
  useEffect(() => () => { loadGeneration.current++; }, [taskId]);
  const loadFailedMessage = useMemo(
    () => (loadFailed === null ? null : taskActionErrorMessage(loadFailed, tr, tr('board.task.loadFailedReason'))),
    [loadFailed, tr],
  );
  // fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { load(); }, [load, bump]);
  /**
   * La ricevuta del land chiesto da QUESTO client, seguita finché non si
   * chiude. Il come sta in `useLandingTicket`, che è lo stesso della card: due
   * superfici che seguono lo stesso ticket in due modi diversi è esattamente
   * come la card è finita per non seguirlo affatto.
   */
  const afterLanding = useCallback(() => { void load(); onChanged(); }, [load, onChanged]);
  const { landing, setLanding } = useLandingTicket(projectId, taskId, afterLanding);
  const landingBanda = landingBand(landing);
  // Wake-up refresh (same rationale as the board's): an open drawer coming back
  // from sleep would keep yesterday's chip/ticker until some WS event lands.
  //
  // It also catches the session up (see `sessionCatchUp` further down, where
  // the session reader exists): the two refreshes have to land TOGETHER, or a
  // task row from now next to a session tail from before the sleep reads as an
  // agent that stopped talking.
  const sessionCatchUp = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      load();
      sessionCatchUp.current?.();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [load]);

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
  // The empty composer can still resume without a new instruction.
  // Le parole dei tre bottoni di decisione stanno in `ReviewDecisionRow`, che le
  // chiede a `reviewDecisionButtons`: cambiano tutte con lo stato della card (i
  // checks rossi rinominano Approva, una card che nessuno ha consegnato
  // rinomina anche Landa e sposta il verde), e una parola che cambia sullo
  // schermo deve cambiare nella stessa funzione che la sottrae qui sotto.
  // Recover only an unanswered question from this same assistant message.
  const speech = comments.filter((c) => isThreadSpeech(c) && !isResolvedParkedQuestion(c, children));
  const lastThreadComment = pendingQuestionComment(speech);
  // Closed tasks keep their questions as history.
  const pending = lastThreadComment && task && task.status !== 'done'
    ? parseQuestionBlock(lastThreadComment.content)
    : null;
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
  // Quale commento è il piano, e quando NON c'è nessun piano: la regola sta in
  // `planPanel.ts`, che è puro e ha i suoi test — qui resta solo il legame.
  const planComment = useMemo(
    () => pickPlanComment(task, speech),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `speech` is derived from `comments` each render
    [comments, task?.planFirst, task?.planCommentId, task?.status],
  );


  /**
   * `quiet` = la nota RESTA QUI. Il gesto rumoroso rimanda il task all'agent
   * (reject + resume, la card torna In Progress) ed è quello che il composer
   * faceva sempre, senza dirlo; quello quieto salva e basta.
   *
   * Gli ALLEGATI passano dallo stesso `quiet`: la via con i media è sempre
   * `boardApi.comment`, che di suo sveglia l'agent. Senza propagare il flag,
   * «Nota» con una foto attaccata avrebbe rimandato indietro la card.
   */
  const deliverAnswer = async (v: string, media?: string[], opts?: { quiet?: boolean }): Promise<boolean> => {
    const quiet = opts?.quiet === true;
    try {
      // The comments route owns notes, answers and review continuations. Its
      // acknowledgement is the saved row, independent of a later detail GET.
      const saved = await boardApi.comment(projectId, taskId, v || '(allegato)', { media, quiet });
      if (saved?.id && saved.taskId === taskId) {
        loadGeneration.current++;
        acknowledgedComments.current.set(saved.id, saved);
        setComments((previous) => previous.some((comment) => comment.id === saved.id) ? previous : [...previous, saved]);
        setCommentReceipt({ id: saved.id, delivery: saved.delivery ?? 'saved' });
        stickRef.current = true;
        setWorkspaceOpen(false);
      }
      setError(null);
      void load(); onChanged();
      return true;
    } catch (e) { showError(e); return false; }
  };
  const send = async (opts?: { quiet?: boolean }) => {
    const v = draft.trim(); if ((!v && attachments.length === 0) || sending || busy || uploading) return;
    setSending(true);
    const ok = await deliverAnswer(v, attachments.map((a) => a.path), opts);
    if (ok) { setDraft(''); setAttachments([]); } // cleared on success only
    setSending(false);
  };

  // Attachments: same pipeline as the native chat — POST /api/upload (multipart)
  // → absolute path, rendered via /api/media. Staged here until send. The
  // upload itself lives in `lib/attachments`, shared with the composer that
  // creates a task: same gesture on both surfaces, one implementation.
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, MAX_ATTACHMENTS - attachments.length)) {
        const staged = await uploadAttachment(file);
        setAttachments((prev) => [...prev, staged]);
      }
      setError(null);
    } catch (e) { showError(e); }
    finally { setUploading(false); }
  };
  const answerOption = async (opt: string) => {
    if (sending || busy || uploading) return;
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

  // One send-back action: carry the correction and attachments, or resume
  // without an instruction when the composer is empty. Clear only on success.
  const sendBack = async () => {
    if (busy || sending) return;
    if (draft.trim() || attachments.length > 0) { await send(); return; }
    await decide('reject');
  };

  // Land = merge the branch on main (local, no push) AND THEN accept the card,
  // in quest'ordine. Explicit, separate from Approva (which only accepts the
  // task). The merge/build runs server-side and surfaces its outcome as system
  // comments in the thread.
  //
  // La card resta in review finché il merge non è confermato su main: se il land
  // fallisce (o non parte) la si ritrova qui, col motivo nel thread e questo
  // stesso bottone per riprovare. Chiuderla prima era il difetto del 13/08 —
  // tre card in `done` coi rami mai atterrati.
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

  // "Deploya ora": the human confirms a deploy the server only PROPOSED at
  // approve (board setting `deployCommand`). Fire-and-forget on this side too —
  // the server answers 202 and the outcome lands as a system comment; `load()`
  // after the click just picks up the `running` state right away.
  const [deploying, setDeploying] = useState(false);
  const doDeploy = async () => {
    if (deploying) return;
    setDeploying(true);
    try { await boardApi.deploy(projectId, taskId); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setDeploying(false); }
  };


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
  // "auto" selects across compatible connected providers; an explicit id pins it.
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const models = useTaskModelCatalog();
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
    if (!task || task.assignedTopicId || (task.model ?? null) === model || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { model }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Node selector (header chip): WHICH MACHINE the card runs on (KANBAN-76).
  // `null` = this machine; the local row (`baseUrl === null`) is never a choice.
  const nodeBtnRef = useRef<HTMLButtonElement>(null);
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false);
  const machines = useMachines();
  const nodes = nodesOf(machines);
  // A card already `in_progress` is running SOMEWHERE: repointing it would
  // change the label and move nothing, which is a promise the dispatcher does
  // not keep. The picker is disabled instead of lying.
  const nodePickerLocked = task?.status === 'in_progress';
  const changeNode = async (machineId: string | null) => {
    setNodeMenuOpen(false);
    if (!task || (task.machineId ?? null) === machineId || busy || nodePickerLocked) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { machineId }); setError(null); await load(); onChanged(); }
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
    // `?? UNKNOWN_PROJECT_NAME`: da un id che non ha un nome dentro (un UUID)
    // `projectNameFromId` torna `null`, e a schermo va la frase, non il codice.
    : currentProject?.name ?? (task ? projectNameFromId(task.projectId) ?? UNKNOWN_PROJECT_NAME : '');
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
    // Non usare un output_url morto come seme del workspace: stessa logica dell'useEffect.
    const seed = task?.outputUrl && task?.urlProbeStatus !== 'dead' ? task.outputUrl : null;
    return seed ? [{ url: seed, contextId: task?.assignedTopicId || `task-${task?.id}` }] : [];
  }, [liveTaskTabs, task?.outputUrl, task?.urlProbeStatus, task?.assignedTopicId, task?.id]);

  const openInWorkspace = useCallback(() => { promoteToWorkspace(workspaceManifest); }, [promoteToWorkspace, workspaceManifest]);

  /**
   * UNA scheda sola nel workspace del progetto, dal suo tasto destro.
   *
   * Il gesto grande («apri il task») porta di là tutte le tab insieme, ed è
   * giusto quando quello che vuoi è il task. Ma le tab di una card sono anche
   * cinque, e spesso ne serve una: quella si chiede alla tab, non a un'icona
   * nella testata che le prende tutte e non dice quali.
   */
  const openPaneInProject = useCallback((paneId: string) => {
    const contextId = paneIdToContextId(paneId);
    const tab = liveTaskTabs.find((t) => t.contextId === contextId);
    if (!tab?.url) return;
    promoteToWorkspace([{ url: tab.url, contextId: workspaceTwinContextId(tab.contextId) }]);
  }, [liveTaskTabs, promoteToWorkspace]);

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
  const blockedChip = task ? blockedByChip(task, tr) : null;
  // Chi lavora un sottotask che non ha un agente suo: il server lo risolve
  // risalendo i padri, qui si sceglie solo come dirlo.
  const workChip = task ? subtaskWorkChip(task, tr) : null;
  const workAncestorId = task?.subtaskWork?.kind === 'parent-turn' ? task.subtaskWork.ancestor.id : null;

  // Aveva consegnato e non è più lì: stessa lettura del chip sulla card, qui in
  // forma di banda (chi e quando). Vive finché la card non torna a consegnare.
  const reopened = task ? reopenedChip(task, tr, locale) : null;

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
    editingTitle || editingDesc || statusMenuOpen || prioMenuOpen || projMenuOpen || blockerMenuOpen || modelMenuOpen || nodeMenuOpen || optionsMenuOpen;
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
  /** Il CONTENUTO del task (titolo + descrizione) negli appunti: quello che
   *  serve per incollarlo in una chat o in un'altra board. Il LINK — ritrovare
   *  il task invece di leggerlo — non è più un gemello qui accanto: vive dentro
   *  il pannello di condivisione, che è l'unico posto dove si chiede un link. */
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

  /**
   * THE AGENT'S SESSION, FROM THE SAME STORE THE CHAT READS.
   *
   * It used to be a history read of 200 rows every 3 seconds while a turn ran:
   * two hundred rows over the wire, ten times a minute, to notice a token. Now
   * the drawer reads `state/messageStore.ts` — the very array `useChat` reduces
   * every frame into — and wakes up only for its own session.
   *
   * THE CATCH the first draft missed: the store is not fed for free. Per-token
   * deltas are routed on the topics this window DECLARED (`subscribe`, see
   * `state/topicSubscriptions.ts`), and a drawer is not a pane, so without
   * asking it would receive `stream:start` / `message:new` / `stream:end` and
   * nothing in between. Hence the hold.
   *
   * Both the hold and the subscription are gated on `usePaneAlive()`: a drawer
   * parked behind another pane keeps its effects mounted (`PaneKeepAlive`
   * freezes RENDERS, not effects), and it has no business holding a topic open
   * on the wire while nobody can see it.
   */
  const sessionKey = task?.assignedTopicId ? `topic:${task.assignedTopicId.slice(0, 8)}` : null;
  const paneAlive = usePaneAlive();
  const assignedTopicId = task?.assignedTopicId ?? null;
  useEffect(
    () => (paneAlive && assignedTopicId ? holdTopic(assignedTopicId) : undefined),
    [paneAlive, assignedTopicId],
  );
  const storeMessages = useSyncExternalStore(
    useCallback(
      (cb: () => void) => (paneAlive && sessionKey ? subscribeSession(sessionKey, cb) : () => {}),
      [paneAlive, sessionKey],
    ),
    useCallback(
      () => (paneAlive && sessionKey ? getSessionMessagesFromStore(sessionKey) : EMPTY_CHAT_MESSAGES),
      [paneAlive, sessionKey],
    ),
  );

  /**
   * The three moments the wire cannot cover, and only those: mount (or a
   * change of session), waking up, and the end of a turn. The last one is not
   * belt-and-braces — `message:new` carries the text, while the persisted
   * `blocks` and tool rows exist only in the stored history.
   */
  const refreshSession = useCallback(() => {
    if (!paneAlive || !sessionKey || !loadHistory) return;
    void loadHistory(sessionKey);
  }, [paneAlive, sessionKey, loadHistory]);
  useEffect(() => { refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; sessionKey?: string };
      if (m.type === 'stream:end' && m.sessionKey === sessionKey) refreshSession();
    });
  }, [onMessage, sessionKey, refreshSession]);

  // Live agent state (needed below): typing indicator + stream preview + stop.
  const agentBusy = !!task && isAgentWorking(task.dispatchState);

  /**
   * THE COMPOSER NAMES THE VERB OF THE STATE IT SITS IN.
   *
   * One box, three destinations: on a delivered card the main send button
   * carries the correction, on a working card it reaches the agent mid-turn, on a
   * closed one it stays a note. Only the words say which, and a placeholder that
   * says «Commenta» over a box that wakes an agent is the difference between a
   * note and a turn.
   *
   * The fourth case is the one that was missing: the agent asked and is waiting.
   * Then the box is not a steer, it is the answer the turn restarts from.
   */
  const steerable = !!task && (task.status === 'in_progress' || agentBusy);
  const composerPlaceholder = isAgentReview
    ? tr('board.task.replyPlaceholder')
    : steerable
      ? (pending ? tr('board.task.answerPlaceholder') : tr('board.task.steerPlaceholder'))
      : tr('board.task.commentPlaceholder');
  const composerSendTitle = steerable
    ? (pending ? tr('task.comment.answer') : tr('task.comment.toAgent'))
    : tr('task.comment');

  // Coming back from hidden, the store may have missed frames the socket
  // dropped while the tab slept. The wake-up listener up at `onWake` calls this
  // through the ref, so there is ONE `visibilitychange` listener for both
  // refreshes and the two land together: a task row from now next to a session
  // tail from before the sleep reads as an agent that stopped talking.
  useEffect(() => {
    sessionCatchUp.current = refreshSession;
    return () => { sessionCatchUp.current = null; };
  }, [refreshSession]);

  /**
   * THE CARD'S CONVERSATION, as one list.
   *
   * The thread and the session were two lists of the same turn, side by side,
   * and the reader did the join by hand across two scrollers. `mergeTaskTimeline`
   * does it here, purely (see `taskTimeline.ts` and KANBAN-73): the envelopes
   * the dispatcher wrote fold out of the way, a mirrored `comment_task` tool row
   * disappears only where the comment it produced is already on screen, and a
   * comment anchored to a message sits right under it whatever the two clocks
   * say. `timelineRef` carries the previous result in, so an unchanged row comes
   * back as the same object: the memo cannot read its own output.
   */
  const deliveryWord = useMemo(
    () => [...threadComments].reverse().find((c) => c.kind === 'delivery') ?? null,
    [threadComments],
  );
  const pinnedDeliveryId = task?.status === 'done' ? deliveryWord?.id ?? null : null;
  const timelineRef = useRef<TimelineItem[]>([]);
  const timeline = useMemo(
    () => mergeTaskTimeline(threadComments, storeMessages, { status: task?.status ?? '', pinnedDeliveryId }, timelineRef.current),
    [threadComments, storeMessages, task?.status, pinnedDeliveryId],
  );
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  const sessionRuns = useMemo(() => taskSessionRuns(timeline, agentBusy, task?.inProgressAt),
    [timeline, agentBusy, task?.inProgressAt]);
  useLayoutEffect(() => { autoGrow(commentRef.current); }, [draft, task?.id, workspaceOpen, twoCol]);
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [timeline, commentReceipt, workspaceOpen, twoCol, composerHeight]);

  // ── Drawer body = ONE task-scoped GroupLayout ─────────────────────────────
  // Thread, live browser tabs, Piano and each media attachment are all PANES of
  // the app's REAL PaneTabBar (a single tab bar; native split/resize/drag). The
  // hook owns identity + tiling; the derived (thread/plan/media) pane
  // bodies render through `renderSurface`. Defined here (after the thread deps:
  // `timeline`, `agentBusy`…) so every dep array is in scope.
  const browserRef = useRef<TaskBrowserGroupLayout | null>(null);
  const openTaskPane = useCallback((paneId: string) => {
    if (!browserRef.current?.focusPane(paneId)) return false;
    setWorkspaceOpen(true);
    return true;
  }, []);
  const previewInThread = useMemo(() => hasConversationMedia(task?.previewImage,
    [...timeline.flatMap((item) => item.source === 'comment' ? [item.comment] : []), ...(pinnedDeliveryId && deliveryWord ? [deliveryWord] : [])],
    timeline.flatMap((item) => item.source === 'session' ? [item.msg] : []),
  ), [task?.previewImage, timeline, pinnedDeliveryId, deliveryWord]);
  const foldedDeliveryNotes = useMemo(() => deliveryNotesToFold(
    timeline.flatMap((item) => item.source === 'comment' ? [item.comment] : []),
  ), [timeline]);
  const renderThread = useCallback((details?: React.ReactNode): React.ReactNode => {
    if (!task) return null;
    /**
     * ONE ROW OF THE CONVERSATION, whichever list it came from.
     *
     * The three shapes are not three styles of the same thing: a card comment
     * is a bubble with an author and a time, a step of the session is drawn by
     * the SAME `MessageContent` the topic chat uses (so a tool row, a question
     * form, a reasoning fold look and behave identically on both surfaces), and
     * a dispatcher envelope is one collapsed service line. What decides is
     * `source`, never the text.
     */
    const row = (item: TimelineItem, index: number) => {
      if (sessionRuns.hidden.has(item.id)) return null;
      const workRun = sessionRuns.runs.get(item.id);
      if (workRun) return <SessionRun key={item.id} items={workRun} sessionKey={sessionKey} onMessage={onMessage} />;
      if (item.source === 'comment') {
        const receipt = commentReceipt?.id === item.id ? commentReceipt.delivery : undefined;
        // Which of the two sources wins is a rule, and it lives in `chipKey.ts`
        // where a test can run it: the derivation is the authority, the receipt
        // speaks only where the derivation is silent or where the route moved
        // the words this instant.
        const chip = commentChip(item.delivery, receipt);
        const previous = timeline[index - 1];
        const continuation = !!item.comment.messageId && previous?.source === 'comment'
          && previous.comment.messageId === item.comment.messageId
          && previous.comment.author === item.comment.author
          && isThreadSpeech(previous.comment);
        if (foldedDeliveryNotes.has(item.id)) return (
          <details key={item.id} data-testid="task-delivery-note" className="group rounded border border-app-border-subtle">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-mini text-app-text-muted hover:text-app-text">
              <ChevronRight className="h-3 w-3 shrink-0 group-open:rotate-90" />
              <span className="shrink-0">{tr('board.task.deliveryNote')}</span>
              <span data-testid="task-delivery-note-preview" className="truncate text-app-text-secondary">{stripMarkdown(item.comment.content)}</span>
            </summary>
            <div data-testid="task-delivery-note-body" className="px-2 pb-2"><CommentBubble comment={item.comment} ownerName={ownerName} /></div>
          </details>
        );
        return (
          <div key={item.id} className="space-y-0.5">
            <CommentBubble
              comment={item.comment}
              ownerName={ownerName}
              continuation={continuation}
              resolvedParked={isResolvedParkedQuestion(item.comment, children)}
              historicalQuestion={!!parseQuestionBlock(item.comment.content) && (!pending || item.comment.id !== lastThreadComment?.id)}
              questionActions={pending && item.comment.id === lastThreadComment?.id ? (
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="task-question-options">
                  {replyOptions.map((opt) => (
                    <button key={opt} disabled={sending || busy || uploading}
                      onClick={() => void answerOption(opt)}
                      className="rounded border border-app-border bg-white/5 px-2.5 py-1.5 text-left text-compact leading-4 text-app-text hover:bg-white/10 disabled:opacity-50">
                      {stripMarkdown(opt)}
                    </button>
                  ))}
                </div>
              ) : undefined}
              onPreview={(p) => openTaskPane(mediaPaneIdFor(p))}
            />
            {/* WHERE YOUR MESSAGE GOT TO, derived from the envelopes at every
                read and never written into the thread (KANBAN-74). It sits
                under the person's own bubble, on their side. */}
            {chip && (
              <p
                data-testid={commentChipTestId(chip)}
                role={receipt ? 'status' : undefined}
                className="pr-1 text-right text-micro text-app-text-faint"
              >{tr(chip === 'note' ? 'board.task.noteSaved' : chip === 'saved' ? 'board.task.commentSaved'
                : chip === 'delivered' || chip === 'answered' ? 'board.task.delivered' : 'board.task.queuedForTurn')}</p>
            )}
          </div>
        );
      }
      if (item.envelope) return <DispatchEnvelopeRow key={item.id} messageId={item.msg.id} content={item.msg.content} />;
      if (item.msg.role === 'user') {
        // Something typed into the topic itself rather than into the card. The
        // same grey bubble a comment of yours gets: it is the same voice, and
        // two greys for one person would be a difference that means nothing.
        return (
          <div key={item.id} className="flex justify-end">
            <div className="user-bubble max-w-[88%] rounded-lg bg-app-user-bubble px-2.5 py-1.5 text-body-lg leading-5 text-app-text">
              <div className={COMPACT_MD_CLS}><ChatMarkdown components={{}}>{item.msg.content}</ChatMarkdown></div>
            </div>
          </div>
        );
      }
      // Imported system/session notices remain readable too.
      return <SessionRun key={item.id} items={[{ ...item, foldProgress: false }]} sessionKey={sessionKey} onMessage={onMessage} />;
    };
    // Adjacent transitions share one centered event row.
    const statusRun = (items: TimelineItem[]) => (
      <StatusTrail
        comments={items.flatMap((i) => (i.source === 'comment' ? [i.comment] : []))}
        ownerName={ownerName}
      />
    );
    /**
     * WHAT FOLDS, and the guard that matters: a row of the SESSION never does.
     * The fold's rule was written for the thread's bookkeeping; run over a
     * transcript it would start classifying the agent's own steps, and a fold
     * that swallows the work is exactly the silent failure this projection
     * exists to avoid.
     */
    const folds = task.status === 'done' ? isDoneThreadService : isServiceComment;
    const isService = (item: TimelineItem) => item.source === 'comment' && folds(item);
    return (
      <div
        ref={threadScrollRef}
        data-testid="task-conversation-scroll"
        onScroll={() => {
          const el = threadScrollRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto py-3"
        style={{
          paddingBottom: composerHeight + 24,
          maskImage: `linear-gradient(to bottom, #000 0, #000 calc(100% - ${composerHeight + 24}px), transparent calc(100% - ${composerHeight}px))`,
          WebkitMaskImage: `linear-gradient(to bottom, #000 0, #000 calc(100% - ${composerHeight + 24}px), transparent calc(100% - ${composerHeight}px))`,
        }}
      >
        <div className="chat-measure space-y-2 px-3">
        {details}
        {task.previewImage && !previewInThread && (
          <button type="button" data-testid="task-conversation-attachment" onClick={() => openTaskPane(mediaPaneIdFor(task.previewImage!))}
            className="flex w-full items-center gap-2 rounded border border-app-border px-2.5 py-2 text-left text-compact leading-4 text-app-text-secondary hover:bg-white/5">
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{task.previewImage.split('/').pop()}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
          </button>
        )}
        {/* IL VUOTO DICE COSA SUCCEDERA', non che e' vuoto. «Nessun commento»
            constatava un'assenza che si vede gia' da sola; questa riga e'
            l'unico posto in cui dire DOVE arriveranno la consegna e le domande
            dell'agente, e a chi tocca la mossa. Cambia con lo stato, perche' un
            task in coda e uno in backlog aspettano cose diverse: il secondo
            aspetta te. Ora la condizione e' la LISTA vuota e basta: da quando
            la sessione e' nella stessa lista, "ha un topic" non dice piu'
            niente su quello che c'e' da leggere. */}
        {timeline.length === 0 && (
          <p data-testid="task-thread-empty" className="text-compact leading-4 text-app-text-muted">
            {tr(emptyThreadKey(task.status))}
          </p>
        )}
        {/* THE DELIVERY, PINNED, on a closed card. Whoever opens a done task
            without having followed the chat read four lines of land plumbing
            before finding what changed and why. The declared delivery is the
            one anchor the thread has; up here it is the first thing read. It is
            excluded from the list below, so it is painted once. */}
        {task.status === 'done' && deliveryWord && (
          <div data-testid="task-delivery-band" className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 pb-1 pt-1.5">
            <div className="mb-1 text-micro font-medium uppercase tracking-wide text-emerald-300">{tr('board.task.deliveryBand')}</div>
            <CommentBubble
              comment={deliveryWord}
              ownerName={ownerName}
              onPreview={(p) => openTaskPane(mediaPaneIdFor(p))}
            />
          </div>
        )}
        <ThreadRuns
          comments={timeline} renderRow={row} renderStatusRun={statusRun}
          isService={isService}
        />
        {/* THE LIVE ROW, at the tail: "how is it going" is asked where you
            write, and a composer with no sign of life above it reads as an
            agent that stopped. No preview any more, because the streaming row
            itself is right above this one now. */}
        {agentBusy && (
          <SessionLiveRow
            phase={task.dispatchState === 'queued' ? tr('board.task.dispatch.queued') : task.dispatchState === 'starting' ? tr('board.task.dispatch.starting') : tr('board.task.dispatch.working')}
            since={task.dispatchState === 'working' ? sessionRuns.since : null}
          />
        )}
        </div>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- action callbacks use the task state listed below
  }, [task, timeline, commentReceipt, deliveryWord, agentBusy, busy, sending, uploading, pending, lastThreadComment, replyOptions, tr, ownerName, children, sessionKey, onMessage, openTaskPane, previewInThread, foldedDeliveryNotes, composerHeight, sessionRuns]);

  const renderSurface = useCallback<RenderSurface>((pane, _isVisible) => {
    if (pane.id.startsWith('plan:') && planComment)
      return <SurfaceContent surface={{ id: pane.id, kind: 'plan', label: tr('board.plan.paneTitle'), content: planComment.content }} taskId={taskId} />;
    if (pane.id.startsWith('media:')) {
      const p = pane.id.slice('media:'.length);
      return <SurfaceContent surface={{ id: pane.id, kind: 'media', label: pane.title || 'Allegato', url: getMediaUrl(p), path: p }} taskId={taskId} />;
    }
    return null;
  }, [planComment, taskId, tr]);

  // The single GroupLayout that IS the drawer body's tab system.
  //
  // `threadInline` stays on: the CONVERSATION (with the composer under it)
  // keeps its own column and never goes back into the tab group. There is no
  // Session tab any more: what the agent did is not a second surface next to
  // what it said, it is the same list, and the tab group is left to the things
  // you look AT while you read it (browser tabs, the plan, the attachments).
  const browser = useTaskBrowserGroupLayout(taskId, {
    planActive: !!planComment,
    mediaPaths,
    renderSurface,
    threadInline: true,
    openPaneInProject,
  });
  // How many panes the group has. Zero means a task with nothing to look at,
  // and the two layouts say so in two different ways (empty state on the right,
  // a single disabled row in one column).
  const workspacePaneCount = browser.groupLayoutProps.panes.length;
  const hasWorkspacePanes = workspacePaneCount > 0;
  // Apertura mirata. Va riprovata: al primo render i commenti (e quindi i media,
  // e quindi le pane) non sono ancora arrivati, perciò `focusPane` fallisce e
  // basta. Il ref si azzera solo quando la pane c'è davvero ed è stata attivata,
  // così il gesto dell'utente non si perde nel buco tra mount e fetch — e non si
  // ripete più dopo, altrimenti riporterebbe l'anteprima davanti a ogni nuovo
  // commento mentre stai leggendo il thread.
  const pendingFocusRef = useRef<string | null>(focusPaneId ?? null);
  useEffect(() => { pendingFocusRef.current = focusPaneId ?? null; }, [taskId, focusPaneId]);
  useEffect(() => {
    const wanted = pendingFocusRef.current;
    if (!wanted) return;
    if (openTaskPane(wanted)) pendingFocusRef.current = null;
  }, [browser, openTaskPane]);
  browserRef.current = browser;
  // Seed the first browser tab from the review output_url once, when the task
  // has no tabs yet (so the reviewer lands on the delivered page). NO forced
  // "Output" label — it's just a normal browser tab: the bar shows the system
  // default ("Browser") until the page loads, then the page's OWN title (auto).
  useEffect(() => {
    if (!task?.outputUrl) return;
    // Non seminare la tab quando la sonda dice che il server e' spento:
    // aprire una pagina morta e' peggio dell'assenza perche' promette e non mantiene.
    // `unknown` (mai sondata) -> lasciamo passare (conservativo: potrebbe essere viva).
    if (task.urlProbeStatus === 'dead') return;
    void browser.seedFromUrl(task.outputUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedFromUrl is stable per taskId; refire only when the output_url changes
  }, [task?.outputUrl, task?.urlProbeStatus]);

  const doneCount = children.filter((c) => c.status === 'done').length;

  // Identity stays visible; editable metadata belongs to task details.
  const identityCard = (
      <div className="border-b border-app-border px-3 py-3">
        {task?.parentTaskId && onOpenTask && (
          <button
            onClick={() => onOpenTask(task.parentTaskId!)}
            title={tr('board.task.openParentCardTitle')}
            className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-mini text-violet-300 hover:bg-violet-500/25"
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
              className="flex min-w-0 flex-1 items-center gap-1 text-mini text-app-text-secondary hover:text-app-text"
            >
              <ProjectFavicon path={currentProject?.path ?? ''} size={14} className="shrink-0" fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />} />
              <span className="min-w-0 truncate font-medium">{projectLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
            </button>
            {reopened && (
              <details data-testid="task-reopened-notice" className="group relative shrink-0 text-mini text-app-text-muted">
                <summary className="cursor-pointer list-none rounded px-1.5 py-0.5 hover:bg-white/5 hover:text-app-text">
                  ↩︎ {tr('board.task.reopened')}
                </summary>
                <p className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-app-border bg-elevated p-2 text-app-text shadow-lg">{reopened.detail}</p>
              </details>
            )}
            {/* Stessa precedenza della card: la ragione della coda batte il
                chip di stato, e le due superfici restano in passo. */}
            {task.queueReason ? (
              <QueueReasonChip reason={task.queueReason} />
            ) : (task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
              <DispatchChip state={task.dispatchState} error={task.dispatchError} deliveredBy={task.deliveredBy} />
            ) : showsStoppedChip(task) ? (
              // Same rule as the card, one module: `stoppedChip.ts`.
              <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-mini text-rose-300" title={task.dispatchError ?? undefined}>{tr('board.task.stopped')}</span>
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
            headerNote={moveBlocked ? <p className="px-2.5 pb-1 text-micro leading-snug text-amber-300/90">{moveBlocked}</p> : undefined}
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
            className="-mx-1.5 block max-h-24 w-[calc(100%+0.75rem)] resize-none overflow-y-auto rounded bg-white/5 px-1.5 py-1 text-body-lg leading-5 text-app-text outline-none"
          />
        ) : (
          <p
            onClick={() => { if (task) { setTitleDraft(task.text); setEditingTitle(true); } }}
            title={tr('board.task.editTitleTitle')}
            className="-mx-1.5 line-clamp-2 cursor-text break-words rounded px-1.5 py-1 text-body-lg leading-5 text-app-text hover:bg-white/5"
          >{task ? <MorphText text={task.text} /> : null}</p>
        )}
        {/* THE WAIT IS IDENTITY, NOT METADATA. It used to sit in the meta row,
            which now lives behind the collapsed "details" toggle: a blocked
            task opened in the drawer said nothing about waiting, and the
            blocker picker had no way in. A state you have to expand a section
            to discover is a state nobody reads, so the chip comes back next to
            the title, always mounted. Clicking it opens the same picker as the
            entry in the header menu, which anchors to whichever opened it. */}
        {task && (
          <>
            {blockedChip && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  ref={blockerChipRef}
                  onClick={() => openBlockerMenu(blockerChipRef.current)}
                  data-testid="task-blocked-by-chip"
                  title={tr('task.blocked.hint', { what: blockedChip.title })}
                  className="flex min-w-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-mini text-amber-300 hover:bg-amber-500/25"
                >
                  <Lock className="h-3 w-3 shrink-0" />
                  <span className="max-w-[14rem] truncate">{blockedChip.label}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-amber-300/70" />
                </button>
              </div>
            )}
            <Menu open={blockerMenuOpen} anchorRef={blockerAnchorRef} onClose={() => setBlockerMenuOpen(false)} align="right" minWidth={220} role="listbox" unmanagedFocus testId="task-blocker-picker">
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.blockedBy')}</p>
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
                  <p className="px-2.5 py-2 text-compact leading-4 text-app-text-muted">{tr('board.task.noOtherTasks')}</p>
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
          </>
        )}
      </div>
  );
  const metadataCard = (
    <div className="border-b border-app-border px-3 py-2">
        {/* Meta row — compact chips that wrap, card-style: priorità,
            modello · ⏱ effort (UN chip, come la card), piano-prima,
            blocked-by + reuse. Editable selectors keep their portaled Menus. */}
        {task && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className="flex items-center gap-1 text-mini text-app-text-muted"
              title={tr('task.lastUpdate', { when: new Date(task.updatedAt).toLocaleString('it-IT') })}
            ><Clock className="h-3 w-3 shrink-0" /> {fmtUpdatedAt(task.updatedAt)}</span>
            <button
              ref={prioBtnRef}
              onClick={() => task && setPrioMenuOpen(true)}
              data-testid="task-priority-chip"
              title={priorityAwaitingAgent(task)
                ? tr('task.priority.auto')
                : tr('task.priority.change')}
              className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-mini ${
                !priorityAwaitingAgent(task) && task.priority >= 3 ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
              {priorityAwaitingAgent(task) ? tr('board.task.priorityAuto') : PRIORITY_LABEL[task.priority] ?? 'Media'}
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
            </button>
            <Menu open={prioMenuOpen} anchorRef={prioBtnRef} onClose={() => setPrioMenuOpen(false)} minWidth={160} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.priority')}</p>
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p} role="option" aria-selected={p === task?.priority}
                  disabled={busy}
                  onClick={() => changePriority(p)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
                  <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
                  {p === task?.priority && !(task && priorityAwaitingAgent(task)) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
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
                ? tr('task.close.invisible')
                : task.labels.some((l) => l.label === 'visibile')
                  ? tr('task.close.visible')
                  : task.labels.some((l) => l.label === 'decisione') // allow-italian: the label vocabulary IS the data, compared by value
                    ? tr('task.close.decision')
                    : tr('task.close.none')}
              className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20"
            >
              <Tag className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.labels.length ? task.labels.map((l) => l.label).join(', ') : tr('board.task.labelsChip')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={labelMenuOpen} anchorRef={labelBtnRef} onClose={() => setLabelMenuOpen(false)} minWidth={220} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.whoCloses')}</p>
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
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.kind')}</p>
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
              onClick={() => { if (!task.assignedTopicId) setModelMenuOpen(true); }}
              aria-disabled={!!task.assignedTopicId}
              data-testid="task-model-chip"
              title={task.assignedTopicId ? tr('task.model.sessionFixed', { model: fmtModel(task.model) }) : (task.agentMs > 0 || task.agentTokens > 0)
                ? tr('task.model.stats', {
                    model: task.model ? fmtModel(task.model) : 'Auto',
                    effort: task.effort ? tr('task.model.effortPart', { effort: task.effort }) : '',
                    time: fmtMs(task.agentMs),
                    tokens: task.agentTokens ? tr('task.model.tokensPart', { n: task.agentTokens.toLocaleString('it-IT') }) : '',
                    cache: task.agentCacheReadTokens > 0 ? tr('task.model.cachePart', { n: fmtTok(task.agentCacheReadTokens) }) : '',
                  })
                : `${task.model ? `${fmtModel(task.model)}. ` : ''}${tr('task.model.hint')}`}
              className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20"
            >
              <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.model ? fmtModel(task.model) : 'Auto'}{task.effort ? ` · ${task.effort}` : ''}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}`}</span>
              {!task.assignedTopicId && <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />}
            </button>
            <Menu open={modelMenuOpen && !task.assignedTopicId} anchorRef={modelBtnRef} onClose={() => setModelMenuOpen(false)} minWidth={200} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.agentModel')}</p>
              <TaskModelMenuOptions
                models={models}
                value={task.model || null}
                onSelect={changeModel}
                disabled={busy}
                autoLabel={tr('board.task.modelAutoOption')}
                autoIcon
              />
            </Menu>
            {/* WHERE it runs, next to WHAT it runs with: same register as the
                model chip, same `Menu` primitive. A node is not a preference of
                the agent, it is the machine that executes the turn. */}
            <button
              ref={nodeBtnRef}
              onClick={() => setNodeMenuOpen(true)}
              data-testid="task-node-chip"
              disabled={nodePickerLocked}
              title={nodePickerLocked ? tr('board.task.node.runningTitle') : tr('board.task.node.title')}
              className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/10"
            >
              <Server className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.machineId ? machineLabel(machines, task.machineId) : tr('board.task.node.chipLocal')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={nodeMenuOpen} anchorRef={nodeBtnRef} onClose={() => setNodeMenuOpen(false)} minWidth={220} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.node.heading')}</p>
              <button
                role="option" aria-selected={!task.machineId} disabled={busy}
                onClick={() => changeNode(null)}
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              >
                <Server className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1">{tr('board.task.node.local')}</span>
                {!task.machineId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              {nodes.map((m) => (
                <button
                  key={m.id} role="option" aria-selected={m.id === task.machineId} disabled={busy}
                  onClick={() => changeNode(m.id)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.status === 'online' ? 'bg-emerald-400' : 'bg-app-text-faint'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="shrink-0 text-micro text-app-text-muted">
                    {m.status === 'online' ? tr('board.task.node.online') : tr('board.task.node.offline')}
                  </span>
                  {m.id === task.machineId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
              {nodes.length === 0 && (
                <p className="px-2.5 pb-1.5 pt-1 text-mini leading-snug text-app-text-muted">{tr('board.task.node.empty')}</p>
              )}
            </Menu>
            {/* Who is working it stays in the row for the same reason the wait
                does: on a card in progress with no topic and no chip, this is
                the state that decides whether somebody has to step in. When an
                ancestor holds the turn the chip takes you there, because the
                next question is always "and who would that be?". */}
            {workChip && (workAncestorId && onOpenTask ? (
              <button
                onClick={() => onOpenTask(workAncestorId)}
                data-testid="task-subtask-work-chip"
                data-kind="parent-turn"
                title={tr('task.work.hint', { what: workChip.title })}
                className="flex min-w-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-muted hover:bg-white/20"
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
                  ? 'flex min-w-0 items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-mini text-rose-300'
                  : 'flex min-w-0 items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-muted'}
              >
                {workChip.kind === 'unattended'
                  ? <AlertTriangle className="h-3 w-3 shrink-0" />
                  : <UserRound className="h-3 w-3 shrink-0" />}
                <span className="max-w-[14rem] truncate">{workChip.label}</span>
              </span>
            ))}
          </div>
        )}
    </div>
  );
  const descCard = (
    <>
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
            className="block w-full resize-none overflow-hidden rounded bg-white/5 px-1.5 py-0.5 text-body-lg leading-5 text-app-text-heading outline-none"
          />
        ) : task?.description ? (
          <>
            {/* CHIUSO ≠ VUOTO. La scelta di chiudere è ricordata in
                localStorage e vale per OGNI card: chiusa una volta, una
                descrizione da 2.578 caratteri si legge come «non c'è una
                descrizione utile» (il rilievo su `d4fcce17`). Il chevron non
                è evidenza di contenuto, quindi da chiuso la maniglia porta
                con sé la MISURA (quanto testo c'è) e la prima riga vera. */}
            <SectionHeader open={descOpen} onToggle={toggleDescOpen} label={tr('board.task.descLabel')} testId="task-section-desc" />
            {/* La misura sta FUORI dal bottone di proposito: il nome
                accessibile della maniglia resta «Descrizione» esatto, che è
                come la cercano le spec e chi naviga a voce. Qui dentro
                invece serve il numero, perché è il numero a dire che sotto
                c'è un piano e non due righe. */}
            {!descOpen && (
              <p
                onClick={toggleDescOpen}
                title={tr('board.task.descExpandTitle')}
                className="mt-1 cursor-pointer truncate text-compact leading-5 text-app-text-secondary hover:text-app-text-heading"
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
                className={`mt-1.5 cursor-text rounded px-1.5 py-0.5 text-body-lg leading-5 text-app-text-heading hover:bg-white/5 ${COMPACT_MD_CLS}`}
              ><ChatMarkdown components={{}}>{task.description}</ChatMarkdown></div>
            )}
          </>
        ) : (
          <button
            onClick={() => { setDescDraft(''); setEditingDesc(true); }}
            className="flex w-full items-center gap-1 text-mini font-semibold uppercase tracking-wide text-app-text-faint hover:text-app-text-secondary"
          >{tr('board.task.addDesc')}</button>
        )}
        {/* (L'anteprima stava QUI, sorella della descrizione ma fuori dal
            suo ramo `descOpen`: chiudere la descrizione non la nascondeva.
            Ora ha la sua sezione in cima al brief — «la consegna» è uno slot,
            non un dettaglio della descrizione.) */}

      </div>
    </>
  );
  const subtasksCard = (
    <>
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
        <SectionHeader
          open={subtasksOpen}
          onToggle={toggleSubtasksOpen}
          label={tr('board.task.subtasksLabel')}
          suffix={children.length > 0 ? ` · ${doneCount}/${children.length}` : undefined}
          testId="task-section-subtasks"
        />
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
                className="w-full rounded bg-white/5 px-2 py-1 text-compact leading-4 text-app-text outline-none placeholder:text-app-placeholder disabled:opacity-60"
              />
              {addingSub && <Spinner size="sm" tone="current" className="absolute right-1.5 top-1.5 text-app-text-secondary" />}
            </div>
          </div>
        )}
      </div>
      )}
    </>
  );

  const taskDetails = detailsOpen && task ? (
    <div data-testid="task-brief-scroll" className="-mx-3 -mt-3 mb-3 border-b border-app-border">
      {metadataCard}
      {descCard}
      {subtasksCard}
    </div>
  ) : null;

  const taskDelivery = deliveryOpen && task ? (
    <div data-testid="task-delivery-panel" className="-mx-3 -mt-3 mb-3 border-b border-app-border">
      <div className="space-y-2 px-3 py-3">
            {/* Lifecycle choices belong to delivery. Stop is owned by the composer. */}
            {task.status !== 'review' && (
              <TaskChoiceRow
                task={task} disabled={busy} exclude={['stop']} className="mb-2"
                onDone={() => { void load(); onChanged(); }}
                onError={setError} onNeedText={() => commentRef.current?.focus()}
              />
            )}
            {/* Review decisions stay next to the checks and delivery evidence. */}
            {task.status === 'review' && (
              <div className="mb-2 space-y-1.5">
                {/* L'evidenza sta ATTACCATA alla decisione: il gate rifiuta un
                    approve coi checks rossi, e scoprirlo da un 409 dopo il click
                    sarebbe farsi spiegare da un errore quello che si poteva vedere. */}
                <OutputUrlProbeNotice task={task} />
                <SystemDeliveryNotice task={task} />
                <ChecksSection task={task} />
                {/* Le parole e QUALE dei tre è il verde: dalla card, non da
                    qui. Su una review che nessuno ha consegnato il verde è
                    «Rimandalo avanti» e le altre due scendono a neutro. */}
                {/* `busy || sending`: da quando «Rimanda indietro» porta con sé
                    il testo, la sua strada lunga alza `sending` e non `busy`.
                    Senza il secondo, i tre bottoni restavano premibili mentre la
                    consegna era già partita. */}
                <div data-testid="task-review-actions" className="flex flex-wrap items-center gap-1.5">
                <ReviewDecisionRow
                  task={task} busy={busy || sending}
                  onAccept={() => decide('approve', { force: task.checksState === 'fail' })}
                  onSendBack={() => void sendBack()}
                  onLand={doLand}
                />
                {/* Le uscite che i tre bottoni qui sopra NON hanno: prendersi il
                    task («Serve a me») o archiviarlo. Approva/Rimanda indietro/Landa sono
                    già lì sopra per esteso, quindi si escludono — un doppione
                    non è una scelta in più. */}
                <TaskChoiceRow
                  task={task} disabled={busy || sending} exclude={['land', 'send-back', 'accept', 'redo', 'stop']}
                  onDone={() => { void load(); onChanged(); }}
                  onError={setError} onNeedText={() => commentRef.current?.focus()}
                />
                </div>
                {/* «Ricattura evidenza» NON è più qui: era un'azione di
                    servizio sull'anteprima disegnata larga quanto una
                    decisione, in mezzo alle decisioni, e a occhio faceva
                    quantità con loro. Adesso sta attaccata all'anteprima che
                    rifà, in cima al brief — anche quando l'anteprima non c'è,
                    che è il momento in cui serve davvero. */}
              </div>
            )}

      </div>
      <div className="px-3 pb-2">        {/* File consegnati: ogni artefatto (screenshot/video/PDF) è
            polimorfo — click sul nome lo apre come TAB nel workspace del
            task, l'icona lo SCARICA. Rimpiazza l'idea di "output" a parte:
            il risultato è tab + lista scaricabili. */}
        {mediaPaths.length > 0 && (
          <div className="mt-3" data-testid="task-downloads">
            <SectionHeader
              open={downloadsOpen}
              onToggle={toggleDownloadsOpen}
              label={tr('board.task.deliveredFiles')}
              suffix={` · ${mediaPaths.length}`}
              testId="task-section-downloads"
            />
            {downloadsOpen && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {mediaPaths.map((p) => {
                const name = p.split('/').pop() || p;
                return (
                  <li key={p} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-compact leading-4 text-app-text-heading">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                    <button
                      type="button"
                      data-testid={p === task?.previewImage ? 'task-preview-open' : undefined}
                      onClick={() => openTaskPane(mediaPaneIdFor(p))}
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
            )}
          </div>
        )}</div>
          {/* THE TWIN OPENER THAT COULD NEVER RENDER IS GONE.
              It was gated on `!mediaPaths.includes(task.previewImage)`, and
              `collectTaskMediaPaths` puts the preview FIRST in that list since
              2026-08-03 (050d9b766): the condition has been false ever since,
              for every task that has a preview. The live opener is the row in
              "File consegnati" just above, which carries the same testid and
              the same action — and `board-drawer-truth` spent that time looking
              for the dead one. What is left here is the band that speaks when
              there is NO preview (retired, or missing on an agent review), so
              its condition is now exactly that. */}
          {task && (task.previewRetiredAt || isAgentReview) && (
            <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-preview">
              <div className="flex flex-wrap items-center gap-2">
                {isAgentReview && <button disabled={recapturing} onClick={recapturePreview}
                  title={tr('board.task.recapturePreviewTitle')} data-testid="task-recapture-preview"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-compact leading-4 text-app-text-secondary hover:bg-white/10 disabled:opacity-40">
                  {recapturing ? <Spinner size="sm" tone="current" /> : <Camera className="h-3 w-3" />}{tr('board.task.recapturePreview')}
                </button>}
              </div>
              {!task.previewImage && task.previewRetiredAt && <p data-testid="task-preview-retired" className="mt-1.5 text-compact leading-4 text-app-text-muted">
                {tr('board.task.previewRetired')}{task.previewRetiredReason ? `: ${task.previewRetiredReason}` : ''}
              </p>}
              {!task.previewImage && !task.previewRetiredAt && <p data-testid="task-preview-missing" className="mt-1.5 text-compact leading-4 text-app-text-muted">
                {tr('board.task.previewMissing', { recapture: tr('board.task.recapturePreview') })}
              </p>}
            </div>
          )}
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
                    className="group/prev flex shrink-0 items-center rounded-md border border-app-border bg-white/[0.02] text-compact leading-4 text-app-text-muted"
                  >
                    <button
                      onClick={() => { setWorkspaceOpen(true); browser.reopenTab(t.contextId); }}
                      title={tr('board.task.reopenTabTitle')}
                      className="flex items-center gap-1.5 px-2 py-1"
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{label}</span>
                      <span className="text-nano uppercase tracking-wide text-app-text-faint">{tr('board.task.closedTab')}</span>
                    </button>
                    {/* The ONLY call site of `removeTab`, and it was hover-only:
                        with a finger the tray of closed tabs could only get
                        longer. `coarse:opacity-100` gives it back, and on a
                        coarse pointer the box grows to 24x24 (6+12+6).
                        `tap-expand-y`, not `tap-expand`: a 44px square centred
                        here would overhang the reopen button on its left and,
                        being later in the DOM, would win the overlap -- tapping
                        the end of the label would DELETE the tab instead of
                        reopening it. Vertical only costs the neighbour nothing
                        (see index.css). */}
                    <button
                      onClick={(e) => { e.stopPropagation(); browser.removeTab(t.contextId); }}
                      title={tr('board.task.removeTabTitle')}
                      aria-label={tr('board.task.removeTabTitle')}
                      data-testid="parked-tab-remove"
                      className="tap-expand-y mr-1 rounded p-0.5 text-app-text-muted opacity-0 hover:bg-white/10 hover:text-app-text group-hover/prev:opacity-100 focus-visible:opacity-100 coarse:p-1.5 coarse:opacity-100"
                    ><X className="h-3 w-3" /></button>
                  </div>
                );
              })}
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
  ) : null;

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
      className={`pane-frost flex flex-col border-app-border ${swiping ? '' : 'transition-transform duration-200'} absolute inset-0 z-40 w-full lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l ${
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
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-compact leading-4 text-app-text-heading hover:bg-white/10"
        >
          {/* A failed first read must not keep saying «Loading…»: the spinner is
              a promise, and here nothing is coming. */}
          {task ? <StatusIcon status={task.status} /> : loadFailedMessage ? <AlertTriangle className="h-3.5 w-3.5 text-rose-300" /> : <Spinner size="sm" tone="current" />}
          {task ? STATUS_LABEL[task.status] : loadFailedMessage ? tr('board.task.loadFailedChip') : tr('board.task.loading')}
          <ChevronDown className="h-3 w-3 text-app-text-faint" />
        </button>
        {/* Condividere sta accanto allo STATO, non dentro un menù: è una
            proprietà della scheda come lo stato, e nasconderla in un
            sottomenù avrebbe reso invisibile l'unica cosa che rende utile
            l'identità costruita sotto. */}
        {/* Un solo posto per «il link»: l'icona a catena accanto non c'è più,
            la copia vive dentro il pannello di condivisione. */}
        {task && <ShareControl resourceType="task" resourceId={task.id} deepLink={() => buildTaskLink(task.id, task.text)} />}
        <Menu open={statusMenuOpen} anchorRef={statusBtnRef} onClose={() => setStatusMenuOpen(false)} minWidth={170} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.moveTo')}</p>
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
              <p className="px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.options')}</p>
              <button
                role="menuitem" disabled={busy} onClick={togglePlanFirst}
                title={tr('task.planFirst')}
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
                role="menuitem" onClick={() => {
                  setOptionsMenuOpen(false);
                  setSubtasksOpen(true);
                  setSubtaskComposerOpen(true);
                  setDetailsOpen(true);
                  setDeliveryOpen(false);
                  setWorkspaceOpen(false);
                }}
                className={POPOVER_ITEM}
              ><Plus className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" /> {tr('board.task.addSubtask')}</button>
              <div className={POPOVER_DIVIDER} />
              {/* COPIA IL TASK e APRI NEL PROGETTO stanno QUI, non in riga.
                  Erano due icone fra le sette della testata, e sette icone senza
                  parole sono un rebus: nessuna di queste due si usa mentre si
                  decide su una scheda, quindi nessuna delle due si merita un
                  posto permanente accanto a «chiudi». Nel menù hanno anche la
                  cosa che a un'icona mancava — il proprio nome scritto. */}
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); void copyTask(); }}
                data-testid="task-copy-text"
                title={tr('board.task.copyTextTitle')}
                className={POPOVER_ITEM}
              >
                {copied === 'task'
                  ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  : <Copy className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />}
                <span className="min-w-0 flex-1">{copied === 'task' ? tr('board.task.copyTextDone') : tr('board.task.copyText')}</span>
              </button>
              {/* Le TAB vincono su `outputUrl`: su un task DISPATCHATO il
                  risultato sono le tab che l'agente ha aperto con
                  open_browser_pane — anche più d'una, col suo nome — e
                  `outputUrl` (quando c'è) è solo il seme della prima. Senza tab
                  vive resta il seme, così il flusso manuale non perde nulla.
                  Si chiama «apri il TASK» e non «apri il risultato»: i risultati
                  sono tanti e cambiano mentre l'agent lavora, quindi il gesto
                  promuove il task con quello che ha in quel momento. */}
              {workspaceManifest.length > 0 && (
                <button
                  role="menuitem" onClick={() => { setOptionsMenuOpen(false); openInWorkspace(); }}
                  data-testid="task-open-in-workspace"
                  title={tr('board.task.openInProjectTitle', { n: workspaceManifest.length })}
                  className={POPOVER_ITEM}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                  <span className="min-w-0 flex-1">{tr('board.task.openInProject')}</span>
                  <span className="shrink-0 text-micro text-app-text-faint">{workspaceManifest.length}</span>
                </button>
              )}
            </Menu>
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
          {/* Espandi/riduci ha senso solo sul side-panel desktop: su mobile il
              drawer è già full-screen, quindi il toggle è nascosto (<lg). */}
          <button
            onClick={toggleWide}
            data-testid="task-detail-wide-toggle"
            aria-pressed={wide}
            title={wide ? tr('task.drawer.narrow') : tr('task.drawer.widen')}
            className="hidden rounded p-1.5 text-app-text-secondary hover:bg-white/10 lg:block"
          >{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          <button aria-label={tr('board.task.closeDetail')} onClick={onClose} className="rounded p-1.5 text-app-text-secondary hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {/* L'errore NON sta qui: vive in fondo, nella zona di decisione, appiccicato
          ai bottoni che lo producono. Questa banda resta al `notice`, che è un
          avviso sul task e non il verdetto di un click. */}
      {notice && (
        <div
          data-testid="task-detail-notice"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-mini text-sky-300"
        >
          <span>{notice}</span>
          <button aria-label={tr('board.task.closeError')} onClick={() => setNotice(null)} className="tap-expand shrink-0 rounded p-0.5 hover:bg-white/10 coarse:p-1.5"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* Land ACCODATO, non ancora avvenuto. Sta sopra la banda «non su main»
          perché in questa finestra quella banda dice il vero ma non dice tutto:
          il codice non è su main E qualcuno ci sta già lavorando.
          La frase (e il caso che qui mancava: un `settled` RESPINTO, che senza
          leggere `outcome` era identico a un successo) sta in `LandingNotice`,
          insieme a quella della card. */}
      {landingBanda && <LandingNotice band={landingBanda} testId="task-detail-landing" />}
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
        <div data-testid="task-not-landed-banner" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-mini text-rose-300">
          <span className="min-w-0">
            <TriangleAlert className="w-4 h-4 inline-block align-[-2px]" aria-hidden="true" /> {tr('task.landing.closedBut')} <strong>{tr('board.task.notOnMain')}</strong>{tr('task.landing.commitIs')}
            {task.deliveryCommit ? <> <code className="rounded bg-black/30 px-1">{task.deliveryCommit.slice(0, 8)}</code></> : null}
            {task.deliveryBranch ? <> ({tr('task.landing.branch')} <code className="rounded bg-black/30 px-1">{task.deliveryBranch}</code>)</> : null}
            {' '}{tr('task.landing.notInMain')}
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
      {/* Deploy PROPOSED at approve (board setting `deployCommand`): a comment
          already told the story in the thread, this banner is the durable
          reminder + the button — same treatment as the "not on main" band
          above, for the same reason (a comment scrolls away, this does not). */}
      {task && showsDeployProposal(task) && (
        <div data-testid="task-deploy-proposed-banner" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-mini text-sky-300">
          <span className="min-w-0"><Rocket className="w-4 h-4 shrink-0" aria-hidden="true" /> {tr('board.task.deployProposed')}</span>
          <button
            data-testid="task-deploy-now"
            disabled={deploying} onClick={doDeploy}
            className="flex shrink-0 items-center gap-1 rounded border border-sky-400/40 bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30 disabled:opacity-50"
          >{deploying ? <Spinner size="sm" tone="current" /> : <GitMerge className="h-3 w-3" />} {tr('board.task.deployNow')}</button>
        </div>
      )}
      {task?.deployState === 'running' && (
        <div data-testid="task-deploy-running-banner" className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-mini text-amber-300">
          <Spinner size="sm" tone="current" /> {tr('board.task.deployRunning')}
        </div>
      )}
      {/* The conversation owns the single reading scroll. Workspace panes keep
          their defined height outside it; identity and composer stay fixed. */}
      {!task && loadFailedMessage ? (
        /* THE DEAD END, closed. With no row the body below never mounts, so the
           only thing on screen was the spinner: no message, no way to retry,
           and the one recovery that existed (the wake-up refresh on
           `visibilitychange`) worked by accident, if you happened to leave the
           window. Here the server's own sentence and one button that calls the
           same `load()`. */
        <div data-testid="task-load-error" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="h-6 w-6 text-rose-300" />
          <p className="text-body-lg leading-5 text-app-text-heading">{tr('board.task.loadFailedTitle')}</p>
          <p className="max-w-sm break-words text-mini text-app-text-muted">{loadFailedMessage}</p>
          <button
            data-testid="task-load-retry"
            onClick={() => { void load(); }}
            className="rounded-md border border-app-border px-3 py-1.5 text-compact leading-4 text-app-text-heading hover:bg-white/10"
          >
            {tr('board.task.loadRetry')}
          </button>
        </div>
      ) : !task ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="md" tone="current" className="text-app-text-muted" />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0" data-testid="task-brief-header">{identityCard}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-app-border px-3 py-1.5">
        <button type="button" data-testid="task-conversation-toggle" aria-pressed={(!workspaceOpen || twoCol) && !detailsOpen && !deliveryOpen}
          onClick={() => { setWorkspaceOpen(false); setDetailsOpen(false); setDeliveryOpen(false); }}
          className={`rounded px-2 py-1 text-compact leading-4 ${!workspaceOpen && !detailsOpen && !deliveryOpen ? 'bg-app-hover text-app-text' : 'text-app-text-secondary hover:text-app-text'}`}>
          {tr('board.task.threadLabel')}
        </button>
        <button type="button" data-testid="task-details-toggle" aria-expanded={detailsOpen}
          onClick={() => {
            detailsScrollRequested.current = !detailsOpen || workspaceOpen;
            setDetailsOpen((open) => workspaceOpen || !open);
            setDeliveryOpen(false);
            setWorkspaceOpen(false);
            stickRef.current = false;
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-muted hover:bg-white/5 hover:text-app-text">
          {detailsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {tr('board.task.detailsLabel')}
        </button>
        <button type="button" data-testid="task-delivery-toggle" aria-expanded={deliveryOpen}
          onClick={() => {
            detailsScrollRequested.current = !deliveryOpen || workspaceOpen;
            setDeliveryOpen((open) => workspaceOpen || !open);
            setDetailsOpen(false);
            setWorkspaceOpen(false);
            stickRef.current = false;
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-secondary hover:bg-app-hover hover:text-app-text">
          {deliveryOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {tr('board.task.deliveryBand')}
        </button>
        <button type="button" data-testid="task-workspace-toggle" data-open={workspaceOpen ? '1' : '0'} aria-expanded={workspaceOpen}
          onClick={toggleWorkspaceOpen}
          className="ml-auto flex min-w-0 items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-muted hover:bg-white/5 hover:text-app-text">
          <span className="truncate">{tr('board.task.workspaceLabel')}</span>
          {hasWorkspacePanes && <span>{workspacePaneCount}</span>}
        </button>
        <button type="button" onClick={() => { setWorkspaceOpen(true); browser.addBrowserTab(); }}
          data-testid="task-workspace-add-tab" title={tr('board.task.openTab')} aria-label={tr('board.task.openTab')}
          className="shrink-0 rounded p-1 text-app-text-secondary hover:bg-white/10"><Plus className="h-3.5 w-3.5" /></button>
      </div>
      <div className={`flex min-h-0 flex-1 ${twoCol ? 'flex-row' : 'flex-col'}`}>
        <div className={`relative flex min-h-0 min-w-0 flex-col ${twoCol ? 'w-[min(50%,30rem)] shrink-0 border-r border-app-border' : 'flex-1'}`}>
          <div className={`${workspaceOpen && !twoCol ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`} data-testid="task-session-column">
            {renderThread(<>{taskDetails}{taskDelivery}</>)}
          </div>
          {workspaceOpen && !twoCol && (
            <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
              {hasWorkspacePanes ? <GroupLayout {...browser.groupLayoutProps} /> : (
                <p className="p-4 text-compact leading-4 text-app-text-muted">{tr('board.task.noWorkspaceTabs')}</p>
              )}
            </div>
          )}
          {/* The composer floats over the conversation; its measured height
              reserves the final reading space. Delivery decisions live above. */}
          {/* DROPPING A FILE IN HERE ATTACHES IT. Paste was already on the
              text field, drag and drop was not: a captured screenshot could be
              pasted, the same screenshot saved to disk had no way in. The drop
              zone is the whole delivery area, not the field's own thirty
              pixels: whoever drags aims at the composer. A drag carrying NO
              file (a layout pane, a text selection) leaves it alone, through
              `dragCarriesFiles`. */}
          <div
            ref={composerAreaRef}
            className={`${workspaceOpen && !twoCol ? 'hidden' : ''} absolute bottom-0 left-0 right-0 chat-measure`}
            style={{ padding: isMobile ? 8 : 12, paddingBottom: 'max(var(--composer-gap), env(safe-area-inset-bottom, 0px))' }}
            onDragOver={(e) => { if (!dragCarriesFiles(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(true); }}
            onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setFileDragOver(false); }}
            onDrop={(e) => {
              if (!dragCarriesFiles(e.dataTransfer)) return;
              e.preventDefault(); e.stopPropagation();
              setFileDragOver(false);
              const files = filesFromDrop(e.dataTransfer);
              if (files.length) void uploadFiles(files);
            }}
            data-testid="task-thread-dropzone"
          >
            {task.status === 'review' && !task.assignedTopicId && !task.parentTaskId && (
              <p data-testid="task-comment-note-context" className="mb-1 px-1 text-mini text-app-text-secondary">
                {tr('board.task.unassignedNoteContext')}
              </p>
            )}
            {fileDragOver && (
              <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded border border-dashed border-emerald-400/60 bg-app-bg/70 text-mini text-emerald-300">
                {tr('board.task.dropToAttach')}
              </div>
            )}
            {/* L'errore dell'ultima azione, PRIMA riga della zona di decisione:
                sta appiccicato ai bottoni che l'hanno prodotto (Approva, Landa,
                le scelte, il composer) e resta nel viewport quanto loro. In
                testa al drawer era vero e invisibile. */}
            {/* THE ACTION LANDED, THE REFRESH DID NOT. Every mutation here ends
                with `load()`, so when that read fails the server has already
                moved and the drawer is still drawing the row from before. Said
                next to the buttons, with the same retry: silence here reads as
                a button that did nothing. */}
            {task && loadFailedMessage && (
              <div
                data-testid="task-stale-warning"
                className="mb-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-mini text-amber-200"
              >
                <span className="min-w-0 flex-1 break-words">{tr('board.task.staleAfterAction', { reason: loadFailedMessage })}</span>
                <button
                  data-testid="task-stale-retry"
                  onClick={() => { void load(); }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-amber-100 underline decoration-dotted hover:bg-white/10"
                >
                  {tr('board.task.loadRetry')}
                </button>
              </div>
            )}
            {error && (
              <div
                data-testid="task-action-error"
                className="mb-2 flex items-start gap-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-mini text-rose-300"
              >
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button aria-label={tr('board.task.closeError')} onClick={() => setError(null)} className="tap-expand shrink-0 rounded p-0.5 hover:bg-white/10 coarse:p-1.5"><X className="h-3 w-3" /></button>
              </div>
            )}
            <div data-testid="task-composer" className={COMPOSER_CARD}>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 p-2">
                {attachments.map((a) => (
                  <span key={a.path} className="group/att relative">
                    {a.isImage ? (
                      <ZoomableImage src={getMediaUrl(a.path)} alt={a.name} title={a.name} testId="task-composer-attachment-image" className="h-12 w-12 rounded object-cover" />
                    ) : (
                      <span className="flex max-w-[10rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-mini text-app-text-heading">
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
            <div className="flex items-end p-1">
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                title={tr('board.task.attachFileTitle')} aria-label={tr('board.task.attachFileTitle')}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-app-text-secondary hover:bg-app-hover disabled:opacity-40">
                {uploading ? <Spinner size="md" tone="current" /> : <Paperclip className="h-4 w-4" />}
              </button>
              <textarea
                ref={commentRef}
                data-testid="task-reply-input"
                value={draft} onChange={(e) => {
                  // A responsive remount can precede the save effect. Preserve
                  // the edit in the local draft cache before that can happen;
                  // network persistence remains debounced by boardDrafts.
                  boardDrafts.putTaskDraft(taskId, e.target.value);
                  setDraft(e.target.value);
                  saveCommentCursor();
                }} rows={1}
                onSelect={saveCommentCursor} onKeyUp={saveCommentCursor} onClick={saveCommentCursor}
                onFocus={() => markActiveComposer(commentCursorKey)}
                aria-label={composerPlaceholder}
                placeholder={composerPlaceholder}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                onPaste={(e) => {
                  const imgs = imagesFromClipboard(e.clipboardData);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className={`${COMPOSER_TEXTAREA} ${isMobile ? 'text-title' : 'text-prose'}`}
                style={{ minHeight: 32, maxHeight: 140 }}
              />
              <DictationButton
                testId="task-thread-dictation"
                onText={(t) => setDraft((prev) => (prev ? `${prev} ${t}` : t))}
                onError={setError}
              />
              <button type="button" data-testid="task-composer-submit"
                onClick={() => { if (agentBusy && !draft.trim() && !attachments.length) void stopAgent(); else void send(); }}
                disabled={busy || sending || uploading || (!agentBusy && !draft.trim() && !attachments.length)}
                title={agentBusy && !draft.trim() && !attachments.length ? taskActionWord('stop', tr).title : isAgentReview ? tr('board.task.sendToAgent') : composerSendTitle}
                aria-label={agentBusy && !draft.trim() && !attachments.length ? taskActionWord('stop', tr).label : isAgentReview ? tr('board.task.sendToAgent') : composerSendTitle}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all disabled:opacity-50 ${
                  draft.trim() || attachments.length ? 'bg-primary text-white hover:bg-primary-hover'
                    : agentBusy ? 'bg-app-text/15 text-app-text hover:bg-app-text/25'
                      : 'bg-transparent text-app-placeholder'
                }`}>
                {sending || busy ? <Spinner size="sm" tone="current" />
                  : agentBusy && !draft.trim() && !attachments.length ? <Square className="h-3.5 w-3.5 fill-current" />
                    : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
            </div>
            {isAgentReview && (
              <div className="mt-1 flex justify-end">
                <button type="button" onClick={() => void send({ quiet: true })}
                  disabled={busy || sending || uploading || (!draft.trim() && attachments.length === 0)}
                  title={tr('board.task.quietNoteTitle')} data-testid="task-reply-quiet-note"
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-compact leading-4 text-app-text-secondary hover:bg-app-hover disabled:opacity-50">
                  <StickyNote className="h-3.5 w-3.5" />{tr('board.task.quietNote')}
                </button>
              </div>
            )}
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
            {hasWorkspacePanes ? (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
                <GroupLayout {...browser.groupLayoutProps} />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-compact leading-4 text-app-text-muted">{tr('board.task.noWorkspaceTabs')}</p>
                <button
                  onClick={() => { setWorkspaceOpen(true); browser.addBrowserTab(); }}
                  className="rounded bg-white/10 px-2.5 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
                >{tr('board.task.openTab')}</button>
              </div>
            )}
          </div>
        )}
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
  // Riga nuda = nessun affordance di click; riga con qualcosa da dire = si apre.
  // La regola per esteso sta su `subtaskOpenable`.
  const openable = subtaskOpenable(node);
  // Questa riga è dove il triage guarda davvero: le colonne mostrano solo le
  // radici (`rootsOnly`), quindi uno step non è MAI una card — l'albero del
  // padre è l'unico posto in cui si vede senza averlo cercato per id.
  //
  // Asimmetrico di proposito. `unattended` è raro e va notato: marcatore rosso.
  // `parent-turn` è la norma (243 step chiusi così in un giorno): un chip su
  // ognuno sarebbe rumore su tutta la checklist, e per giunta ridondante — il
  // padre che la lavora è il drawer che stai guardando. Resta come icona muta,
  // che risponde al passaggio del mouse.
  const work = subtaskWorkChip(node, tr);
  // La ragione di coda, ma solo quando è FERMA: `subtaskQueueChip` è dove sta
  // scritto il perché del filtro.
  const stalled = subtaskQueueChip(node);
  const toggle = async () => {
    if (!open && kids === null) {
      // Only the children: this row draws the checklist and its chips, never a
      // comment. The whole body would carry the node's entire thread with it.
      try { setKids(await boardApi.getChildren(projectId, node.id)); }
      catch { setKids([]); }
    }
    setOpen((o) => !o);
  };
  return (
    <div>
      <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-white/5" style={{ paddingLeft: depth * 10 }}>
        {hasKids ? (
          <button onClick={toggle} className="shrink-0 text-app-text-muted hover:text-app-text-heading" title={open ? tr('common.collapse') : tr('common.expand')}>
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
            className={`min-w-0 flex-1 truncate text-left text-compact leading-4 ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-compact leading-4 ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-secondary'}`}>{node.text}</span>
        )}
        {stalled ? (
          <span data-testid={`subtask-queue-reason-${node.id}`} className="flex min-w-0 shrink">
            <QueueReasonChip reason={stalled} />
          </span>
        ) : null}
        {work && (work.kind === 'unattended' ? (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="unattended"
            title={work.title}
            className="flex shrink-0 items-center gap-1 rounded bg-rose-500/20 px-1 py-0.5 text-micro text-rose-300"
          ><AlertTriangle className="h-2.5 w-2.5 shrink-0" /> {work.label}</span>
        ) : (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="parent-turn"
            title={work.title}
            className="flex shrink-0 text-app-text-muted"
          ><UserRound className="h-2.5 w-2.5" /></span>
        ))}
        {hasKids && <span className="shrink-0 text-micro text-app-text-muted">↳ {node.subtaskDoneCount}/{node.subtaskCount}</span>}
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
  void taskId;
  if (surface.kind === 'media') return <MediaViewer key={surface.url} url={surface.url} path={surface.path} />;
  if (surface.kind === 'browser') return null; // handled by GroupLayout in TaskDetail
  // The fence is NOT the plan. The treatment lives in `PlanSurface`, in a file
  // of its own, because this one does not mount in a unit test.
  return <PlanSurface content={surface.content} />;
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
      <p className="text-body-lg leading-5 text-app-text-secondary">{tr('board.task.noPreviewForType')}</p>
      <button
        onClick={(e) => openLink(url, { external: isExternalLinkGesture(e), origin: e.target })}
        className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
      ><ExternalLink className="h-3.5 w-3.5" /> {tr('board.task.openInBrowser')}</button>
    </div>
  );
}

/**
 * Attachments of a thread message: images inline, other files as name chips.
 * Served through the allowlist-gated /api/media, exactly like chat message
 * media.
 *
 * AN IMAGE OPENS THE LIGHTBOX, the same one the chat opens (card 058ea722,
 * 03/09: "I attached to the task, and it does not show me the preview when I
 * click on it"). It used to open a workspace TAB through `onPreview`, which
 * needs the drawer's tab group to be mounted and reads as nothing happening
 * when it is not, and outside the drawer fell back to the system browser. A
 * tab is still one click away in the "Delivered files" list; a click on the
 * picture means "let me see it", and that is what it does everywhere now.
 * `onPreview` keeps serving the non-image chips (a PDF, a video, a log).
 */
export function MediaStrip({ media, onPreview }: { media?: string[]; onPreview?: (path: string) => void }) {
  const tr = useT();
  if (!media || media.length === 0) return null;
  const isImg = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p);
  // In-app preview when the host provides it (drawer → output panel): a
  // target=_blank anchor is a silent no-op inside the Tauri WKWebView.
  const open = (e: React.MouseEvent, p: string) => {
    e.preventDefault();
    if (onPreview) onPreview(p);
    // A tab of the Topics browser, not the system one: target=_blank is dead in
    // WKWebView, and an attachment is something you look at without leaving.
    else openLink(getMediaUrl(p), { external: isExternalLinkGesture(e), origin: e.target });
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {media.map((p) => isImg(p) ? (
        <ZoomableImage key={p} src={getMediaUrl(p)} alt={p.split('/').pop() ?? ''} title={p.split('/').pop()} testId="task-media-image" className="max-h-40 max-w-full rounded-md object-contain" />
      ) : (
        <a
          key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" onClick={(e) => open(e, p)}
          title={onPreview ? tr('task.media.preview') : p.split('/').pop()}
          className="flex max-w-[14rem] items-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
        ><Paperclip className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{p.split('/').pop()}</span></a>
      ))}
    </div>
  );
}

/**
 * ONE STEP OF THE AGENT, drawn exactly as the topic chat draws it.
 *
 * `MessageContent` and nothing else: the reasoning fold, the tool rows, the
 * media, and the `ToolInputForm` a paused `ask_user_question` puts on screen
 * all come for free, and they BEHAVE the same on both surfaces. The drawer used
 * to have its own miniature renderer for this (thinking, then prose, and that
 * was all), which is why a question the agent asked was answerable in the chat
 * and dead in the card.
 *
 * What is deliberately NOT passed is the accounting: `usage*` and `costCents`
 * draw a per-turn footer that belongs to the chat, not to a 22rem column where
 * the reader is following a decision. `sessionKey` IS passed, because it is
 * what lets the question form POST its answer.
 */
const SessionRun = memo(function SessionRun({ items, sessionKey, onMessage }: {
  items: TaskSessionRunItem[];
  sessionKey: string | null;
  onMessage?: (handler: (m: unknown) => void) => () => void;
}) {
  const tr = useT();
  const groups = useMemo(() => {
    type Part = ReturnType<typeof taskSessionSegments>[number] & { originalId: string };
    const result: { folded: boolean; parts: Part[] }[] = [];
    for (const item of items) {
      for (const segment of taskSessionSegments(item.msg, item.hasThreadReply, item.foldProgress)) {
        const part = { ...segment, originalId: item.msg.id };
        const last = result[result.length - 1];
        if (segment.folded && last?.folded) last.parts.push(part);
        else result.push({ folded: segment.folded, parts: [part] });
      }
    }
    let hasFold = false;
    return result.map((group) => {
      // The first disclosure belongs to the run. Earlier prose can join it
      // when the first tool arrives, without closing details the reader opened.
      const key = group.folded && !hasFold ? `${items[0].id}:work` : group.parts[0].message.id;
      hasFold ||= group.folded;
      return { ...group, key, summary: {
      ...group.parts[0].message,
      blocks: group.parts.flatMap((part) => part.message.blocks ?? []),
      toolCalls: group.parts.flatMap((part) => part.message.toolCalls ?? []),
    } }; });
  }, [items]);
  return <div className={`text-body-lg leading-5 text-app-text ${COMPACT_MD_CLS}`} data-testid="task-session-item" data-message-id={items[0].msg.id}>
    {groups.map(({ folded, parts, summary, key }) => {
      const content = parts.map(({ message, originalId }) => <MessageContent
        key={message.id}
        content={message.content ?? ''} role={message.role}
        thinking={message.thinking} toolCalls={message.toolCalls} blocks={message.blocks} media={message.media}
        partial={message.partial} isLast={false}
        sessionKey={sessionKey ?? undefined} messageId={originalId}
        onMessage={onMessage as ((h: (m: WSMessage) => void) => () => void) | undefined}
      />);
      return folded
        ? <TaskWorkAccordion key={key} msg={summary} label={tr('chat.taskWork.sessionDetails')}>{content}</TaskWorkAccordion>
        : <div key={key}>{content}</div>;
    })}
  </div>;
}, (previous, next) => previous.sessionKey === next.sessionKey && previous.onMessage === next.onMessage
  && previous.items.length === next.items.length
  && previous.items.every((item, index) => item.msg === next.items[index].msg
    && item.hasThreadReply === next.items[index].hasThreadReply
    && item.foldProgress === next.items[index].foldProgress));

/**
 * Un passaggio di stato: un CHIP, non un paragrafo.
 *
 * Era una riga larga quanto il thread per dire che una scheda ha cambiato
 * colonna, e sulla base viva sono 4406 righe su 9973 — metà del muro che rende
 * illeggibile una card aperta per decidere. Il fatto resta (la storia di una
 * scheda riaperta è l'unica cosa che nessuno può ricostruire), ma occupa quanto
 * vale: un chip che si legge di sfuggita, con il resto sotto il mouse.
 *
 * COSA STA SULLO SCHERMO E COSA NEL TOOLTIP, e non è una preferenza:
 *  · la DESTINAZIONE sempre — è il fatto;
 *  · la RAGIONE sempre quando c'è — è il perché, e senza il fatto è muto;
 *  · CHI ha mosso la scheda **solo quando non è stata l'app**. Un thread in cui
 *    ogni riga si firma «Topics» ha smesso di dire qualcosa: il nome torna a
 *    pesare proprio perché compare solo quando c'è una persona dietro;
 *  · ora, identità per esteso e testo grezzo della transizione: nel `title`.
 */
function StatusChip({ comment, ownerName }: { comment: TaskComment; ownerName: string | null }) {
  const tr = useT();
  // Lo stesso parser del server: la destinazione si legge fino al separatore,
  // altrimenti una transizione con la sua ragione (`done→in_progress · il land
  // ha fatto conflitto`) perde l'icona e si stampa cruda.
  const ev = parseStatusEvent(comment.content);
  const to = ev?.to as TaskStatus | undefined;
  const valid = !!to && TASK_STATUSES.includes(to);
  const at = new Date(comment.createdAt);
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName, { personName: comment.actorPersonName, deviceName: comment.actorDeviceName });
  const origin = actionOriginDisplay(comment.origin, tr);
  // L'app che sposta una card da sé non è una notizia: il nome resta solo per
  // chi lo è (tu, un agent, la verifica).
  const mover = who.kind === 'system' || who.kind === 'dispatcher' ? null : who.name;
  return (
    <span
      className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1 px-1.5 py-0.5 text-mini text-app-text-muted"
      title={`${who.name} (${who.detail})${origin ? ` · ${origin}` : ''} · ${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} /> : <span className="h-1 w-1 shrink-0 rounded-full bg-app-text-faint" />}
      {mover && <span className="shrink-0 text-app-text-secondary">{mover}</span>}
      {origin && <span className="shrink-0 text-app-text-faint">{origin}</span>}
      {mover && <span className="shrink-0 text-app-text-secondary">→</span>}
      <span className="shrink-0">{valid ? STATUS_LABEL[to] : comment.content}</span>
      {/* Reasons wrap so touch users can read them without a tooltip. */}
      {valid && ev?.reason && <span className="min-w-0 break-words text-app-text-secondary">· {ev.reason}</span>}
    </span>
  );
}

/**
 * I passaggi di stato ADIACENTI, in una striscia sola.
 *
 * `todo → in_progress → review` sono tre fatti consecutivi che dicono una cosa
 * sola, e in verticale erano tre righe. In orizzontale sono la traccia che
 * sono, e l'ora dell'ultimo chiude la striscia: le altre stanno nei tooltip,
 * dove servono a chi cerca un istante preciso e non a chi scorre.
 */
export function StatusTrail({ comments, ownerName }: { comments: TaskComment[]; ownerName: string | null }) {
  const tr = useT();
  const last = comments[comments.length - 1];
  if (!last) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1 px-1 py-1 text-center"
      data-testid="task-status-trail"
      aria-label={tr('board.task.statusTrail')}
    >
      {comments.map((c) => <StatusChip key={c.id} comment={c} ownerName={ownerName} />)}
      <span className="shrink-0 text-mini text-app-text-faint">
        {new Date(last.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

export function CommentBubble({ comment, ownerName = null, resolvedParked = false, onPreview, questionActions, historicalQuestion = false, continuation = false }: {
  comment: TaskComment;
  /** Come si chiama chi usa l'app: le TUE righe si firmano col tuo nome. */
  ownerName?: string | null;
  /**
   * Questa riga è la domanda sui sottotask fermi, e i sottotask si sono mossi.
   * Resta nella storia — è successo — ma smette di occupare lo spazio di una
   * decisione: niente cornice, niente elenco di uscite, un chip come le altre
   * righe di servizio. Lo decide chi chiama, che ha i figli sotto mano.
   */
  resolvedParked?: boolean;
  onPreview?: (path: string) => void;
  questionActions?: React.ReactNode;
  historicalQuestion?: boolean;
  continuation?: boolean;
}) {
  const tr = useT();
  const origin = actionOriginDisplay(comment.origin, tr);
  // Machine-authored review evidence (live-preview screenshot from the verifier).
  // Distinct from human/agent speech: it never woke the agent, it just informs.
  //
  // NIENTE SCATOLA. Era una card verde bordata dentro un thread di paragrafi
  // nudi, e la scatola prometteva un contenuto a sé stante che non c'è: è una
  // riga come le altre, scritta da un'altra mano. Resta l'unica cosa che la
  // distingue davvero — CHI l'ha scritta — sulla stessa riga d'intestazione di
  // ogni altro messaggio, in verde.
  if (comment.kind === 'review-note') {
    return (
      <div className="pr-8">
        <p className="flex items-center gap-1 text-micro font-medium uppercase tracking-wide text-emerald-400/80">
          <Camera size={11} /> {tr('board.task.reviewPreview')}
          {origin && <span className="normal-case tracking-normal text-app-text-faint">{origin}</span>}
          <span className="ml-auto normal-case tracking-normal text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>
        <div className="text-body-lg leading-5 text-app-text"><CommentBody content={comment.content} /></div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
      </div>
    );
  }
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName, { personName: comment.actorPersonName, deviceName: comment.actorDeviceName });
  const app = who.kind === 'system' || who.kind === 'dispatcher';
  /**
   * UNA RIGA DELL'APP È UN CHIP, non un paragrafo con un'intestazione sopra.
   *
   * «Mergiato su main (commit 4f1a2b).» è un fatto lungo una riga, e occupava
   * tre: il nome di chi ha parlato, il testo, l'ora. Su una card che ha
   * lavorato sono dieci righe così, ed è metà del «pienissimo di messaggi
   * situazionali». Il criterio è UNA RIGA, non una lunghezza a occhio: lo stesso
   * confine che `task-comment-service.ts` usa già per la nota di consegna, e per
   * la stessa ragione — quando l'app riporta le parole recuperate dell'agent le
   * mette dopo una riga vuota, e quelle parole sono spesso l'unica cosa che
   * l'agent ha detto. Multi-riga resta prosa, sempre.
   */
  // (`review-note` è già uscito sopra, con la sua intestazione verde.)
  // Una domanda gia' risolta scende allo stesso rango: e' un fatto avvenuto,
  // non una cosa da decidere. Il blocco `question` e' multi-riga per via delle
  // recinzioni, quindi non passerebbe dal test qui sopra — ma quello che resta
  // da leggere e' una frase sola, ed e' quella che il chip mostra.
  const oneLiner = app && (resolvedParked || (!parseQuestionBlock(comment.content) && !/[\n\r]/.test(comment.content.trim())));
  if (oneLiner) {
    return (
      <div
        className="mx-auto flex w-fit max-w-full items-center justify-center gap-1.5 px-1.5 py-0.5 text-center text-mini text-app-text-muted"
        data-testid="task-app-note"
        title={`${who.name} (${who.detail})${origin ? ` · ${origin}` : ''} · ${comment.content} · ${new Date(comment.createdAt).toLocaleString('it-IT')}`}
      >
        <Bot className="h-3 w-3 shrink-0" />
        {origin && <span className="shrink-0 text-app-text-faint">{origin}</span>}
        <span className="min-w-0 break-words">{isFreshSessionNote(comment) ? tr('board.task.freshSessionQueued') : parseQuestionBlock(comment.content)?.question ?? comment.content}</span>
        <span className="ml-auto shrink-0 text-app-text-faint">{commentTime(comment.createdAt)}</span>
      </div>
    );
  }
  if (!who.self) {
    // CHI HA PARLATO STA SCRITTO, non appeso a un tooltip. Prima l'unico posto
    // dove il nome compariva era il `title`, quindi una riga dell'agent e una
    // dell'app si leggevano identiche e la differenza si scopriva col mouse —
    // su un thread che mescola quattro voci è la differenza che serve per prima.
    return (
      <div className="pr-8">
        {(!continuation || app) && <p className="flex items-baseline gap-1.5 text-micro" title={who.detail}>
          <span className={`font-medium uppercase tracking-wide ${app ? 'text-app-text-faint' : 'text-app-text-secondary'}`}>{who.name}</span>
          {origin && <span className="text-app-text-faint">{origin}</span>}
          <span className="ml-auto text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>}
        <div className={`text-body-lg leading-5 ${app ? 'text-app-text-muted' : 'text-app-text'}`}>
          <CommentBody content={comment.content} questionActions={questionActions} historicalQuestion={historicalQuestion} />
        </div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
      </div>
    );
  }
  // La bolla di ciò che scrivi TU: lo stesso grigio della chat
  // (`bg-app-user-bubble` + la classe `user-bubble` che riveste codice e link),
  // non l'azzurro di prima. In quest'app il blu è l'accento delle AZIONI, e un
  // messaggio non è un'azione: due superfici che dicono la stessa cosa con due
  // colori diversi erano il motivo per cui il drawer «non sembrava l'app».
  return (
    <div className="flex justify-end">
      <div className="user-bubble max-w-[88%] rounded-lg bg-app-user-bubble px-2.5 py-1.5 text-body-lg leading-5 text-app-text">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-right text-nano text-app-text-muted" title={who.detail}>
          {who.name}{origin ? ` · ${origin}` : ''} · {commentTime(comment.createdAt)}
        </p>
      </div>
    </div>
  );
}

/**
 * Current questions carry their answer buttons in the conversation. Historical
 * questions disclose their original Markdown and options without active actions.
 */
export function CommentBody({ content, questionActions, historicalQuestion = false }: { content: string; questionActions?: React.ReactNode; historicalQuestion?: boolean }) {
  const q = parseQuestionBlock(content);
  // Un recinto che NON parsa (aperto e mai chiuso, corpo vuoto) arriverebbe qui
  // com'e', e per il renderer ```…``` e' un blocco di codice: prosa in
  // `whitespace-pre`, cioe' scroll orizzontale. `questionToProse` e' un no-op su
  // tutto il resto. Vedi `shared/question-prose.ts`.
  if (!q) return <div className={`mt-0.5 text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{questionToProse(content)}</ChatMarkdown></div>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  const options = q.options.length > 0 ? (
    <ul className="mt-1 space-y-0.5">
      {q.options.map((opt, i) => (
        <li key={i} className="flex items-start gap-1.5 text-compact leading-4 text-app-text-secondary">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-app-text-muted" />
          <span className={`min-w-0 flex-1 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{opt}</ChatMarkdown></span>
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <div className={`text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{outside}</ChatMarkdown></div>}
      {/* La domanda e le sue opzioni passano dallo STESSO renderer markdown del
          resto del thread. Erano le uniche due stringhe stampate crude, e
          l'agent le scrive come scrive tutto il resto: `**Opus**`, `` `--flag` ``
          e i backtick attorno a un path arrivavano qui come caratteri. */}
      {historicalQuestion ? (
        <details className="group text-app-text-secondary" data-testid="task-past-question">
          <summary className="flex cursor-pointer list-none items-start gap-1.5 py-1 text-body-lg leading-5 hover:text-app-text">
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 group-open:rotate-90" />
            <span>{stripMarkdown(q.question)}</span>
          </summary>
          <div className={`pl-5 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{q.question}</ChatMarkdown>{options}</div>
        </details>
      ) : <div className="rounded border border-app-border bg-white/[0.02] px-2.5 py-2">
        <div className={`text-prose leading-snug text-app-text ${COMPACT_MD_CLS}`}>
          <ChatMarkdown components={{}}>{q.question}</ChatMarkdown>
        </div>
        {questionActions ?? options}
      </div>}
    </div>
  );
}
