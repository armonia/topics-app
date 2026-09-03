import { pickPlanComment } from './planPanel';
import { isAutoCapturedPreview } from '../../../../shared/media-kind';
import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent as ReactTouchEvent } from 'react';
import { useT, useLocale } from '../../hooks/useT';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useOwnerName } from '../../hooks/useOwnerName';
import { authorDisplay } from '../../lib/authorDisplay';
import { AlertTriangle, ArrowUpRight, Bot, Camera, Check, ChevronDown, ChevronRight, Clock, Copy, Download, ExternalLink, GitCompare, GitMerge, Globe, Hourglass, Lock, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Paperclip, Plus, Send, ShieldCheck, Sparkles, StickyNote, Tag, UserRound, WifiOff, X } from 'lucide-react';
import { SectionHeader, useSectionOpen } from './sectionAccordion';
import { ChatMarkdown } from '../ChatMarkdown';
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
import { isDoneThreadService } from '../../../../shared/task-comment-service';
import { questionToProse } from '../../../../shared/question-prose';
import { ThreadRuns } from './ThreadRuns';
import { copyText } from '../../lib/clipboard';
import { openExternalOnce } from '../../lib/openExternal';
import { buildTaskLink } from '../../lib/openTaskLink';
import { canOpenTaskSession, shouldExplainMissingSession, type TaskSessionState } from '../../lib/taskSession';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { enqueueProjectBrowserNavigate, isProjectWindowMounted } from '../../state/pane/adapters';
import { useTaskBrowserTabs, liveTabs, workspaceTwinContextId } from '../../state/taskBrowserTabs';
import { paneIdToContextId } from '../../state/taskBrowserLayout';
import { noteAutoOpenedPreview, releaseAutoOpenedPreview } from '../../state/taskWorkspacePreviews';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { writeCursor, markActiveComposer, restoreCursor } from '../../lib/composerCursor';
import { DictationButton } from '../Shared/DictationButton';
import { emptyThreadKey } from './emptyThread';
import { boardApi, commentAuthorLabel, diffTotals, hasCodeQuestion, showsLandingDebt, showsDeployProposal, STATUS_LABEL, TASK_STATUSES, isAgentWorking, isThreadSpeech, parseQuestionBlock, parseStatusEvent, isProjectlessId, boardDrafts, systemDeliveryNote, blockedByChip, subtaskWorkChip, subtaskQueueChip, subtaskOpenable, reopenedChip, attemptHasWork, priorityAwaitingAgent, CLOSER_LABELS, KIND_LABELS, type TaskLabel, type BoardTask, type TaskStatus, type TaskComment, type BoardProjectRef, type DiffBundle, type DiffNote, type CheckRun, type TaskAttempt, type LandingTicket } from '../../lib/board';
import { PreviewMedia } from './PreviewMedia';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { UnifiedDiff } from './UnifiedDiff';
import { collectTaskMediaPaths } from './taskMedia';
import { TaskChoiceRow } from './TaskChoiceRow';
import { taskActionErrorMessage } from './taskActionError';
import { usableQuestionOptions } from './taskChoices';
import { drawerSurfaceLabels, reviewDecisionButtons, taskActionWord } from './taskActionWords';
import { TASK_ACTION_ICON } from './taskActionIcons';
import { manualStatusTarget } from '../../lib/boardOrder';
import { formatReviewNotes } from './reviewNotes';
import { COMPACT_MD_CLS, PLAN_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER, DISPATCH_CHIP, mediaPaneIdFor, type TaskSurface } from './constants';
import { friendlyModelLabel, fmtModel, commentTime, fmtMs, fmtTok, fmtUpdatedAt, autoGrow, attemptStat, taskCopyText, descSummary, fmtCount } from './format';
import { StatusIcon, DispatchChip, QueueReasonChip } from './atoms';
import { bucketSessionMsgs, EMPTY_SESSION_BUCKETS, type SessionBuckets, type SessionMsg } from './sessionBuckets';
import { SessionPane, SessionLiveRow } from './SessionPane';
import { usePaneAlive } from '../../state/paneLiveness';
import { ProjectPickerBody } from './ProjectPicker';
import { addBoardProject, projectNameFromId, useBoardProjects, UNKNOWN_PROJECT_NAME } from '../../lib/boardProjectsStore';
import { GroupLayout } from '../Layout/GroupLayout';
import { useTaskBrowserGroupLayout, sessionPaneId, type TaskBrowserGroupLayout, type RenderSurface } from './useTaskBrowserGroupLayout';
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
    <div className="flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
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
    <div className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
      <Hourglass className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.movedToReviewBySystem')}</span>{' '}
        {systemDeliveryNote(task.deliveredReason)}
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
  onSendBack: () => void;
  onLand: () => void;
}) {
  const tr = useT();
  const d = reviewDecisionButtons(task, tr);
  // Un solo verde, e il rosso dei checks lo tinge d'ambra solo quando il verde
  // È «Approva»: su «Rimandalo avanti» l'ambra prometterebbe un'eccezione che
  // quel bottone non fa.
  const primaryCls = task.checksState === 'fail' && d.primary === 'accept'
    ? 'bg-amber-600/80 hover:bg-amber-600 text-white'
    : 'bg-emerald-500/80 hover:bg-emerald-500 text-white';
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
      <div className="flex items-center gap-1.5">
        {ordered.map((b) => {
          const isPrimary = b.id === d.primary;
          return (
            <button
              key={b.id}
              data-testid={b.testId}
              disabled={busy} onClick={b.onClick}
              title={b.word.title}
              className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-50 ${
                isPrimary ? `flex-1 font-medium ${primaryCls}` : neutralCls
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
          className={`flex w-full items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-50 ${
            d.primary === 'accept' ? 'bg-sky-500/80 font-medium text-white hover:bg-sky-500' : neutralCls
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
          className="inline-flex max-w-full items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-muted"
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
        className="flex max-w-full items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/10"
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
          <span className="min-w-0 truncate rounded bg-white/5 px-1 text-[9px] text-app-text-faint">{from}</span>
        )}
        {notes.length > 0 && (
          <span className="shrink-0 rounded bg-indigo-500/20 px-1 text-[9px] text-indigo-300">
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
  /** La ricevuta del land chiesto da QUESTO client, finché non si chiude. */
  const [landing, setLanding] = useState<LandingTicket | null>(null);
  const showError = (e: unknown) => setError(taskActionErrorMessage(e));
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
  // The preview has a section of its OWN. It used to sit beside the description
  // inside the same box but OUTSIDE its `descOpen` branch: closing the
  // description did not hide it, and no handle did either.
  const [previewOpen, togglePreviewOpen] = useSectionOpen('Preview');
  const [downloadsOpen, toggleDownloadsOpen] = useSectionOpen('Downloads');
  // The workspace (the task's GroupLayout: thread + browser + piano + media) is
  // itself an accordion, coherent with the others. Its open state is read by the
  // layout AROUND it (flex-1 vs shrink-0, and the scroll cap), which is why it
  // stays a hook here instead of a self-contained section component.
  const [workspaceOpen, toggleWorkspaceOpen] = useSectionOpen('Workspace');
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
  //
  // It also catches the session poll up. That poll is gated on visibility (see
  // `sessionCatchUp` further down, where `loadSession` exists), and the two
  // refreshes have to land TOGETHER: a task row from now next to a session tail
  // from three ticks ago reads as an agent that stopped talking.
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
  /**
   * Come si chiama, ADESSO, il bottone che raccoglie il testo del composer.
   *
   * Il placeholder deve nominarlo, perché da quando il gemello «Rimanda» non è
   * più accanto alla casella la destinazione di quel testo non è più a un
   * centimetro di distanza. E non può essere una parola scritta a mano qui: su
   * una card che nessuno ha consegnato quel bottone si chiama «Rimandalo
   * avanti», e un placeholder che continuasse a dire «Rimanda indietro»
   * manderebbe a cercare un bottone che sullo schermo non c'è.
   */
  const sendBackLabel = task ? reviewDecisionButtons(task, tr).sendBack.label : '';
  // Le parole dei tre bottoni di decisione stanno in `ReviewDecisionRow`, che le
  // chiede a `reviewDecisionButtons`: cambiano tutte con lo stato della card (i
  // checks rossi rinominano Approva, una card che nessuno ha consegnato
  // rinomina anche Landa e sposta il verde), e una parola che cambia sullo
  // schermo deve cambiare nella stessa funzione che la sottrae qui sotto.
  // Pending question = the agent's last word is a question block: its options
  // render as quick-reply buttons right above the composer (same zone as the
  // review actions), mirroring the card.
  // `isThreadSpeech` drops the two kinds that are never "the agent's last word":
  // 'status' (transition history) and 'service' (the dispatcher's bookkeeping).
  // Same predicate as the card and as `pendingQuestion`, deliberately - the
  // drawer showing no buttons while the card shows two is the shape this bug
  // takes when the three drift.
  // …e la terza cosa che non e' mai «l'ultima parola»: una domanda sui sottotask
  // fermi a cui i sottotask hanno gia' risposto muovendosi. Restava in coda al
  // thread e la scheda ne disegnava le risposte rapide — due bottoni che
  // rimettevano in coda o archiviavano un insieme vuoto. Vedi
  // `shared/parked-question.ts`: la domanda resta nella storia, smette di
  // presentarsi come una decisione da prendere.
  const speech = comments.filter((c) => isThreadSpeech(c) && !isResolvedParkedQuestion(c, children));
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
      if (media && media.length > 0) {
        // Attachments ride the comments endpoint (media isn't a review-decision
        // field); when the task is in agent review the server auto-resumes the
        // agent with the text AND the file paths (boundRootOf path).
        await boardApi.comment(projectId, taskId, v || '(allegato)', { media, quiet });
      } else if (isAgentReview && !quiet) {
        // Race fallback: if the task left review meanwhile, still save the text
        // as a plain comment instead of losing it.
        try { await boardApi.review(projectId, taskId, 'reject', v); }
        catch { await boardApi.comment(projectId, taskId, v); }
      } else {
        await boardApi.comment(projectId, taskId, v, { quiet });
      }
      setError(null);
      await load(); onChanged();
      return true;
    } catch (e) { showError(e); return false; }
  };
  const send = async (opts?: { quiet?: boolean }) => {
    const v = draft.trim(); if ((!v && attachments.length === 0) || sending) return;
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

  /**
   * «Rimanda indietro»: LA DECISIONE E IL TESTO SONO UN GESTO SOLO.
   *
   * ── Il difetto ───────────────────────────────────────────────────────────────
   * Il bottone grande chiamava `decide('reject')`, cioè `review(reject,
   * undefined)`. Il bottone «Rimanda» del composer chiamava `review(reject,
   * draft)`. Stesso endpoint, stessa decisione, stessa colonna d'arrivo: erano
   * due nomi per una porta sola. E il grande, quello che il pollice trova per
   * primo, BUTTAVA VIA l'indicazione appena scritta — mentre il suo stesso
   * tooltip dice «scrivi nel campo qui sotto per dargli un'indicazione». Il
   * testo restava nella casella, l'agente ripartiva senza sapere niente, e
   * niente lo diceva.
   *
   * Adesso la strada è una. Con del testo (o un allegato) passa da
   * `deliverAnswer`, che conosce anche la via dei media e ripulisce la casella
   * solo se è andata a buon fine; a mani vuote resta il reject nudo, che è la
   * stessa decisione senza indicazione. Il gemello nel composer è sparito: non
   * era una scelta in più, era la stessa detta due volte.
   */
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
  //
  // GATED, on both axes, because neither one alone stops it. `PaneKeepAlive`
  // freezes RENDERS, not the effects of a subtree that is already mounted, so a
  // drawer parked behind another pane kept fetching 200 messages every 3s;
  // and a pane that IS the visible one keeps fetching with the window in the
  // background. The tick therefore asks both: the pane has a box (`paneAlive`,
  // the context), and the document is on screen (checked INSIDE the timer, like
  // the two siblings above, so no re-render is needed to park the cycle).
  const paneAlive = usePaneAlive();
  useEffect(() => {
    if (!agentBusy || !sessionKey || !paneAlive) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSession();
    }, 3000);
    return () => clearInterval(t);
  }, [agentBusy, sessionKey, loadSession, paneAlive]);

  // Coming back from hidden, the drawer would sit on the last tick it managed
  // to run until the next one fires. The wake-up listener up at `onWake` calls
  // this through the ref (it is declared above `loadSession`, and one listener
  // for both refreshes keeps the two in step).
  useEffect(() => {
    sessionCatchUp.current = agentBusy && sessionKey ? () => { void loadSession(); } : null;
    return () => { sessionCatchUp.current = null; };
  }, [agentBusy, sessionKey, loadSession]);

  // Tail of the newest agent message (reasoning first): the "how is it going"
  // glance without opening anything. Walked backwards rather than
  // `[...msgs].reverse().find()`: that copied all 200 rows on every poll.
  const streamPreview = useMemo(() => {
    if (!agentBusy || !sessionMsgs?.length) return null;
    let last: SessionMsg | undefined;
    for (let i = sessionMsgs.length - 1; i >= 0; i--) {
      if (sessionMsgs[i].role !== 'user') { last = sessionMsgs[i]; break; }
    }
    if (!last) return null;
    const text = (last.thinking?.trim() || last.content.trim()).replace(/\s+/g, ' ');
    return text ? text.slice(-280) : null;
  }, [agentBusy, sessionMsgs]);

  /**
   * The session cut at the comment boundaries, ONE pass per poll.
   *
   * The cut no longer decides WHERE the steps are drawn (the session pane draws
   * them whole); it decides where the pane puts a "replied here" mark, which is
   * the one thing the old interleaved slices carried that a flat transcript
   * would lose. Unchanged buckets keep their array, so a session that did not
   * move between two polls hands the pane the same rows and it skips its
   * render. `bucketsRef` carries the previous result in: the memo cannot read
   * its own output.
   */
  const bucketsRef = useRef<SessionBuckets>(EMPTY_SESSION_BUCKETS);
  const sessionBuckets = useMemo(
    () => bucketSessionMsgs(sessionMsgs, threadComments, bucketsRef.current),
    [sessionMsgs, threadComments],
  );
  useEffect(() => { bucketsRef.current = sessionBuckets; }, [sessionBuckets]);
  /** The thread's comment ids in order: the boundaries the session pane draws
   *  its "replied here" marks against. */
  const boundaryIds = useMemo(() => threadComments.map((c) => c.id), [threadComments]);

  // ── Drawer body = ONE task-scoped GroupLayout ─────────────────────────────
  // Thread, live browser tabs, Piano and each media attachment are all PANES of
  // the app's REAL PaneTabBar (a single tab bar; native split/resize/drag). The
  // hook owns identity + tiling; the derived (thread/session/plan/media) pane
  // bodies render through `renderSurface`. Defined here (after the thread deps:
  // sessionBuckets/agentBusy/streamPreview…) so every dep array is in scope.
  const browserRef = useRef<TaskBrowserGroupLayout | null>(null);
  const renderThread = useCallback((): React.ReactNode => {
    if (!task) return null;
    // ONE row = one comment. The agent's steps used to be interleaved above
    // every row as a collapsed slice; they live in the Session pane now, whole
    // and open, so the thread is the conversation and nothing else. Nothing is
    // drawn in the gap above a row any more, which is also why the wall of
    // bookkeeping no longer needs a cut rule (`breaksRun`).
    const row = (c: TaskComment) => (
      <CommentBubble
        key={c.id}
        comment={c}
        ownerName={ownerName}
        resolvedParked={isResolvedParkedQuestion(c, children)}
        onPreview={(p) => browserRef.current?.focusPane(`media:${p}`)}
      />
    );
    // Adjacent status transitions are ONE chip strip.
    const statusRun = (cs: TaskComment[]) => (
      <StatusTrail comments={cs} ownerName={ownerName} />
    );
    // The declared delivery (`kind: 'delivery'`), latest one: the row the
    // closed card is pinned on. Null when nobody declared one.
    const deliveryWord = [...threadComments].reverse().find((c) => c.kind === 'delivery') ?? null;
    return (
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {/* IL VUOTO DICE COSA SUCCEDERA', non che e' vuoto. «Nessun commento»
            constatava un'assenza che si vede gia' da sola; questa riga e'
            l'unico posto in cui dire DOVE arriveranno la consegna e le domande
            dell'agente, e a chi tocca la mossa. Cambia con lo stato, perche' un
            task in coda e uno in backlog aspettano cose diverse: il secondo
            aspetta te. */}
        {threadComments.length === 0 && !task.assignedTopicId && (
          <p data-testid="task-thread-empty" className="text-xs text-app-text-muted">
            {tr(emptyThreadKey(task.status))}
          </p>
        )}
        {/* THE DELIVERY, PINNED, on a closed card. Whoever opens a done task
            without having followed the chat read four lines of land plumbing
            before finding what changed and why. The declared delivery is the
            one anchor the thread has; up here it is the first thing read. */}
        {task.status === 'done' && deliveryWord && (
          <div data-testid="task-delivery-band" className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 pb-1 pt-1.5">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-emerald-300">{tr('board.task.deliveryBand')}</div>
            {row(deliveryWord)}
          </div>
        )}
        <ThreadRuns
          comments={threadComments} renderRow={row} renderStatusRun={statusRun}
          // On a closed card the land's hygiene notes fold with the bookkeeping:
          // the outcome they report is the column the card sits in.
          isService={task.status === 'done' ? isDoneThreadService : undefined}
        />
        {/* THE LIVE ROW STAYS HERE even though the steps left. "How is it
            going" is asked where you write, and a composer with no sign of life
            above it reads as an agent that stopped. The preview is one line,
            not the steps: pressing it brings the Session tab forward, which is
            where the steps went. */}
        {agentBusy && (
          <SessionLiveRow
            phase={task.dispatchState === 'queued' ? tr('board.task.dispatch.queued') : task.dispatchState === 'starting' ? tr('board.task.dispatch.starting') : tr('board.task.dispatch.working')}
            since={task.dispatchState === 'working' ? task.inProgressAt : null}
            stopping={busy}
            preview={streamPreview}
            onStop={() => { void stopAgent(); }}
            onOpenPane={() => { browserRef.current?.focusPane(sessionPaneId(taskId)); }}
          />
        )}
        <div ref={bottomRef} />
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopAgent/bottomRef are stable enough; the meaningful inputs are listed
  }, [task, threadComments, agentBusy, streamPreview, busy, tr, ownerName, taskId]);

  /**
   * The agent session, WHOLE, as the leftmost tab of the task's workspace.
   *
   * The live row is repeated here rather than shared with the thread by a ref:
   * both surfaces can be on screen at once (two columns), and a Stop button
   * that exists in only one of them is a Stop button you cannot reach from
   * where you happen to be looking.
   */
  const renderSessionPane = useCallback((): React.ReactNode => (
    <SessionPane
      buckets={sessionBuckets}
      boundaryIds={boundaryIds}
      live={agentBusy && task ? (
        <SessionLiveRow
          phase={task.dispatchState === 'queued' ? tr('board.task.dispatch.queued') : task.dispatchState === 'starting' ? tr('board.task.dispatch.starting') : tr('board.task.dispatch.working')}
          since={task.dispatchState === 'working' ? task.inProgressAt : null}
          stopping={busy}
          preview={streamPreview}
          onStop={() => { void stopAgent(); }}
        />
      ) : null}
    />
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stopAgent is stable enough; the meaningful inputs are listed
  ), [sessionBuckets, boundaryIds, agentBusy, task, tr, busy, streamPreview]);

  const renderSurface = useCallback<RenderSurface>((pane, _isVisible) => {
    // Session first: it is the task's main surface, and the prefixes are
    // disjoint, so the order is the statement rather than the routing.
    if (pane.id.startsWith('session:')) return renderSessionPane();
    if (pane.id.startsWith('thread:')) return renderThread();
    if (pane.id.startsWith('plan:') && planComment)
      return <SurfaceContent surface={{ id: pane.id, kind: 'plan', label: 'Piano', content: planComment.content }} taskId={taskId} />;
    if (pane.id.startsWith('media:')) {
      const p = pane.id.slice('media:'.length);
      return <SurfaceContent surface={{ id: pane.id, kind: 'media', label: pane.title || 'Allegato', url: getMediaUrl(p), path: p }} taskId={taskId} />;
    }
    return null;
  }, [renderSessionPane, renderThread, planComment, taskId]);

  // The single GroupLayout that IS the drawer body's tab system.
  //
  // `threadInline` stays on: the THREAD (the conversation, with the composer
  // under it) keeps its own column and never goes back into the tab group.
  // What the agent DID is a different thing from what you say to it, and it is
  // the half you look at: `sessionActive` gives it a tab of its own, next to
  // the browser tabs, the plan and the attachments.
  //
  // No topic, no session, no tab: a task that was never dispatched has nothing
  // to show, and an empty "Sessione" tab would be a surface repeating what the
  // empty thread already says.
  const browser = useTaskBrowserGroupLayout(taskId, {
    planActive: !!planComment,
    sessionActive: !!task?.assignedTopicId,
    sessionTitle: tr('board.task.sessionLabel'),
    mediaPaths,
    renderSurface,
    threadInline: true,
    openPaneInProject,
  });
  // How many panes the group has. Zero means a task with nothing to look at,
  // and the two layouts say so in two different ways (empty state on the right,
  // a single disabled row in one column). A dispatched task is never zero any
  // more: the session alone fills it.
  const workspacePaneCount = browser.groupLayoutProps.panes.length;
  const hasWorkspacePanes = workspacePaneCount > 0;
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
    // Non seminare la tab quando la sonda dice che il server e' spento:
    // aprire una pagina morta e' peggio dell'assenza perche' promette e non mantiene.
    // `unknown` (mai sondata) -> lasciamo passare (conservativo: potrebbe essere viva).
    if (task.urlProbeStatus === 'dead') return;
    void browser.seedFromUrl(task.outputUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedFromUrl is stable per taskId; refire only when the output_url changes
  }, [task?.outputUrl, task?.urlProbeStatus]);

  const doneCount = children.filter((c) => c.status === 'done').length;

  /**
   * I TRE PEZZI DEL BRIEF, hoistati perché due layout li montano in due posti.
   *
   * In modo stretto stanno impilati dentro l'unica colonna, come sempre. In
   * modo largo salgono in una FASCIA a tutta larghezza sopra le colonne: la
   * consegna di una card è il suo titolo, e in una colonna da 22rem un titolo
   * di due righe e mezza è la prima cosa che si perde — proprio mentre le due
   * colonne esistono per farti vedere di più. Lì sopra la descrizione prende la
   * sinistra e i sottotask la destra: sono le due letture che si fanno insieme,
   * «cosa chiede» e «a che punto è».
   *
   * Definiti QUI e non nel JSX perché duplicarli sarebbe la solita coppia che
   * diverge al primo ritocco (la board ne ha già pagate abbastanza).
   */
  const identityCard = (
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
              <DispatchChip state={task.dispatchState} error={task.dispatchError} deliveredBy={task.deliveredBy} />
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
          >{task ? <MorphText text={task.text} /> : null}</p>
        )}
        {/* Meta row — compact chips that wrap, card-style: priorità,
            modello · ⏱ effort (UN chip, come la card), piano-prima,
            blocked-by + reuse. Editable selectors keep their portaled Menus. */}
        {task && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className="flex items-center gap-1 text-[11px] text-app-text-muted"
              title={tr('task.lastUpdate', { when: new Date(task.updatedAt).toLocaleString('it-IT') })}
            ><Clock className="h-3 w-3 shrink-0" /> {fmtUpdatedAt(task.updatedAt)}</span>
            <button
              ref={prioBtnRef}
              onClick={() => task && setPrioMenuOpen(true)}
              data-testid="task-priority-chip"
              title={priorityAwaitingAgent(task)
                ? tr('task.priority.auto')
                : tr('task.priority.change')}
              className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] ${
                !priorityAwaitingAgent(task) && task.priority >= 3 ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
              {priorityAwaitingAgent(task) ? tr('board.task.priorityAuto') : PRIORITY_LABEL[task.priority] ?? 'Media'}
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
                  : task.labels.some((l) => l.label === 'decisione')
                    ? tr('task.close.decision')
                    : tr('task.close.none')}
              className="flex min-w-0 items-center gap-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/20"
            >
              <Tag className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.labels.length ? task.labels.map((l) => l.label).join(', ') : tr('board.task.labelsChip')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={labelMenuOpen} anchorRef={labelBtnRef} onClose={() => setLabelMenuOpen(false)} minWidth={220} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.whoCloses')}</p>
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
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.kind')}</p>
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
                ? tr('task.model.stats', {
                    model: task.model ? fmtModel(task.model) : 'Auto',
                    effort: task.effort ? tr('task.model.effortPart', { effort: task.effort }) : '',
                    time: fmtMs(task.agentMs),
                    tokens: task.agentTokens ? tr('task.model.tokensPart', { n: task.agentTokens.toLocaleString('it-IT') }) : '',
                    cache: task.agentCacheReadTokens > 0 ? tr('task.model.cachePart', { n: fmtTok(task.agentCacheReadTokens) }) : '',
                  })
                : tr('task.model.hint')}
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
                <span className="min-w-0 flex-1">{tr('board.task.modelAutoOption')} <span className="text-app-text-muted">(opus-first)</span></span>
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
                title={tr('task.blocked.hint', { what: blockedChip.title })}
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
                title={tr('task.work.hint', { what: workChip.title })}
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
            )}
          </div>
        )}
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
                className="w-full rounded bg-white/5 px-2 py-1 text-xs text-app-text outline-none placeholder:text-app-placeholder disabled:opacity-60"
              />
              {addingSub && <Spinner size="sm" tone="current" className="absolute right-1.5 top-1.5 text-app-text-secondary" />}
            </div>
          </div>
        )}
      </div>
      )}
    </>
  );

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
        {/* Un solo posto per «il link»: l'icona a catena accanto non c'è più,
            la copia vive dentro il pannello di condivisione. */}
        {task && <ShareControl resourceType="task" resourceId={task.id} deepLink={() => buildTaskLink(task.id, task.text)} />}
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
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); setSubtasksOpen(true); setSubtaskComposerOpen(true); }}
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
                  <span className="shrink-0 text-[10px] text-app-text-faint">{workspaceManifest.length}</span>
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
            ? <>{tr('board.task.land')} <strong>{tr('board.task.landQueued')}</strong>{tr(landing.ahead === 1 ? 'board.task.landQueuedRestOne' : 'board.task.landQueuedRestMany', { n: landing.ahead })}</>
            : <>{tr('board.task.land')} <strong>{tr('board.task.landRunning')}</strong>{tr('board.task.landRunningRest')}</>}
        </div>
      )}
      {landing?.phase === 'failed' && (
        <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          ⚠️ {tr('board.task.land')} <strong>{tr('board.task.landFailed')}</strong>: {landing.error ?? tr('board.task.landUnknownError')}
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
            ⚠️ {tr('task.landing.closedBut')} <strong>{tr('board.task.notOnMain')}</strong>{tr('task.landing.commitIs')}
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
        <div data-testid="task-deploy-proposed-banner" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-300">
          <span className="min-w-0">🚀 {tr('board.task.deployProposed')}</span>
          <button
            data-testid="task-deploy-now"
            disabled={deploying} onClick={doDeploy}
            className="flex shrink-0 items-center gap-1 rounded border border-sky-400/40 bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30 disabled:opacity-50"
          >{deploying ? <Spinner size="sm" tone="current" /> : <GitMerge className="h-3 w-3" />} {tr('board.task.deployNow')}</button>
        </div>
      )}
      {task?.deployState === 'running' && (
        <div data-testid="task-deploy-running-banner" className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          <Spinner size="sm" tone="current" /> {tr('board.task.deployRunning')}
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
          ↩︎ <strong>{tr('board.task.reopened')}</strong> {tr('board.task.reopenedRest', { detail: reopened.detail })}
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
      <div className="flex min-h-0 flex-1 flex-col">
      {/* ── LA FASCIA DEL BRIEF, solo in modo largo ──────────────────────────
          LA CONSEGNA È IL TITOLO, e in una colonna da 22rem un titolo di due
          righe e mezza è la prima cosa che si perde — proprio mentre le due
          colonne esistono per farti vedere di più. Qui sale a tutta larghezza,
          sopra entrambe, così «di che task si parla» si legge in un colpo
          d'occhio invece che a capo.

          Sotto, affiancate: la DESCRIZIONE (cosa chiede) e i SOTTOTASK (a che
          punto è). Sono le due letture che si fanno insieme, e impilate erano
          due scroll di distanza. I sottotask prendono la destra solo quando
          esistono: una colonna bordata e vuota è peggio di nessuna colonna, e
          senza di loro la descrizione si prende tutto.

          Il tetto (`max-h-[15rem]`) NON è il surrogato di uno scroll mancante —
          la trappola che questo drawer ha già pagato una volta: ognuna delle
          due metà possiede il proprio `overflow-y-auto`, quindi il tetto limita
          quanto il brief ruba alle superfici di lavoro e niente si taglia.

          `[&>div]:border-b-0`: i due blocchi portano il filetto che li separava
          quando erano impilati. Affiancati, quel filetto disegnerebbe una riga
          che si ferma a metà larghezza, sopra il bordo della fascia. */}
      {twoCol && (
        <div className="shrink-0 border-b border-app-border" data-testid="task-brief-header">
          {identityCard}
          <div className="flex max-h-[15rem] items-stretch">
            <div className="min-w-0 flex-1 overflow-y-auto [&>div]:border-b-0">{descCard}</div>
            {(children.length > 0 || subtaskComposerOpen) && (
              <div className="w-[19rem] shrink-0 overflow-y-auto border-l border-app-border [&>div]:border-b-0">{subtasksCard}</div>
            )}
          </div>
        </div>
      )}
      <div className={`flex min-h-0 flex-1 ${twoCol ? 'flex-row' : 'flex-col'}`}>
        {/* La colonna del BRIEF. In modo largo è la colonna stretta di sinistra
            (brief + sessione + composer) e il tiling si prende la destra; in modo
            stretto è l'unica colonna e si prende tutto. */}
        <div className={`flex min-h-0 min-w-0 flex-col ${twoCol ? 'w-[22rem] shrink-0 border-r border-app-border' : 'flex-1'}`}>
        {/* IN MODO LARGO QUESTO SCROLL NON È PIÙ IL BRIEF, è quel che resta:
            anteprima, tab chiuse, tentativi, il chip delle modifiche. Titolo,
            descrizione e sottotask sono saliti nella fascia qui sopra, quindi
            un `flex-1` gli darebbe metà colonna per tenerci tre righe — e la
            metà che si mangia è la SESSIONE, che è l'altra cosa per cui la
            colonna esiste. Prende quanto gli serve, con un tetto oltre il quale
            scorre lui. In modo stretto resta il contenitore di scroll di
            sempre: lì dentro c'è tutto il brief. */}
        {/* ANCHE IN COLONNA SOLA il brief ha un tetto, e per la stessa ragione
            per cui ce l'ha in due colonne: sotto di lui adesso c'è la SESSIONE,
            che è montata sempre. Con `flex-1` il brief e la sessione si
            dividevano l'altezza a metà — e un brief lungo (descrizione +
            sottotask + tentativi) spingeva la sessione a una finestrella di tre
            righe. Prende quanto gli serve fino al tetto, oltre scorre lui: è già
            un contenitore di scroll, quindi il tetto non taglia niente.

            IL TETTO SI STRINGE QUANDO LE ZONE SONO TRE. Con lo Spazio di lavoro
            aperto la colonna deve reggere brief + output + sessione, e a 720px
            di finestra un tetto a metà colonna lasciava all'output 45px, cioè
            la sola barra delle tab: un pannello «aperto» che non mostra niente.
            Chi cede è il brief, perché è l'unico dei tre che scorre — gli altri
            due o si vedono o non ci sono. Chiuso l'output, il tetto torna
            largo: non c'è più niente con cui dividere. */}
        <div
          className={`shrink-0 overflow-y-auto ${twoCol ? 'max-h-[40%]' : (workspaceOpen && hasWorkspacePanes ? 'max-h-[25%]' : 'max-h-[50%]')}`}
          data-testid="task-brief-scroll"
        >
          {/* L'ANTEPRIMA È LA CONSEGNA, e sta in cima: è la cosa per cui il
              drawer si apre. Sezione sua, maniglia sua — prima viveva appesa
              alla descrizione ma fuori dal suo ramo aperto/chiuso, quindi
              nessun gesto la nascondeva. */}
          {/* ── CONSEGNA: l'evidenza, e il gesto che la rifà, nello stesso posto ──
              Lo slot esiste in tre stati, e prima ne aveva solo due: c'è
              l'immagine, l'immagine è stata ritirata con un motivo, oppure — il
              terzo, quello nuovo — non c'è NIENTE. Il terzo era il buco: una
              card in review consegnata senza anteprima non diceva niente di sé
              in cima al drawer, e chi la apriva non aveva modo di sapere se
              l'evidenza mancava o se semplicemente non era ancora arrivata.
              Sono le card «con l'anteprima vuota».
              «Ricattura evidenza» sta sulla riga del titolo in tutti e tre,
              perché è un'azione di SERVIZIO sull'anteprima: viveva in fondo,
              larga quanto una decisione e in mezzo alle decisioni, dove faceva
              quantità con loro senza esserne una. E il posto dove serve di più
              è proprio il terzo stato, dove prima non c'era niente da guardare
              e niente da premere. */}
          {task && (task.previewImage || task.previewRetiredAt || isAgentReview) && (
            <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-preview">
              <div className="flex items-center gap-2">
                {task.previewImage ? (
                  <SectionHeader
                    open={previewOpen}
                    onToggle={togglePreviewOpen}
                    // WHAT THE PHOTO IS, when we took it ourselves. An
                    // auto-capture is the app booted from the card's branch and
                    // photographed wherever it was — usually its own landing
                    // page. Measured 2026-09-01 on two cards in review: the
                    // «account panel» one portrayed «Welcome to Topics», the
                    // «remove profile tab» one portrayed the kanban. Reported
                    // the same day: the previews «don't even look right».
                    //
                    // The cure is NOT a machine deciding whether a photo shows
                    // the work — the two gates the preview manager grew can say
                    // WHO answered on the port and whether the page is an
                    // error, and neither can say that. It is to DECLARE what
                    // the photo is, so nobody reads it as a proof it is not.
                    // Same discipline as the delivery sheet, which says out
                    // loud that the server drew it.
                    label={isAutoCapturedPreview(task.previewImage)
                      ? `${tr('board.task.deliveryLabel')} · ${tr('board.task.deliveryAutoShot')}`
                      : tr('board.task.deliveryLabel')}
                    testId="task-section-preview"
                    grow
                  />
                ) : (
                  <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
                    {tr('board.task.deliveryLabel')}
                  </span>
                )}
                {isAgentReview && (
                  <button
                    disabled={recapturing} onClick={recapturePreview}
                    title={tr('board.task.recapturePreviewTitle')}
                    data-testid="task-recapture-preview"
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-app-text-secondary hover:bg-white/10 hover:text-app-text disabled:opacity-40"
                  >{recapturing ? <Spinner size="sm" tone="current" /> : <Camera className="h-3 w-3" />} {tr('board.task.recapturePreview')}</button>
                )}
              </div>
              {task.previewImage && previewOpen && (
                <PreviewMedia
                  path={task.previewImage}
                  // Anche qui il carosello: le altre evidenze del thread sono
                  // proprio cio' che si cerca aprendo il drawer di una card in
                  // review, e scorrerle qui costa una rotellata invece di
                  // scendere lungo tutti i commenti.
                  paths={task.previewImages}
                  variant="drawer"
                  onOpenTab={() => browser.focusPane(mediaPaneIdFor(task.previewImage!))}
                />
              )}
              {/* L'anteprima MANCA, e c'è un motivo: lo slot della consegna lo
                  dice qui, dove si guarderebbe l'immagine. È uno STATO letto
                  dalla card (`previewRetiredAt`), non una nota nel thread —
                  quindi sparisce da solo appena qualcuno allega un'anteprima
                  nuova, invece di restare a dire il contrario come faceva la
                  nota della bonifica. */}
              {!task.previewImage && task.previewRetiredAt && (
                <div data-testid="task-preview-retired" className="mt-1.5 flex items-start gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200/90">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <p className="min-w-0">
                    <span className="font-medium">{tr('board.task.previewRetired')}</span>
                    {task.previewRetiredReason && <span className="text-amber-200/70">: {task.previewRetiredReason}</span>}
                  </p>
                </div>
              )}
              {/* Nessuna evidenza e nessun motivo: si dice, invece di lasciare
                  uno slot muto. La frase nomina il bottone accanto, così il
                  vuoto porta con sé la sua uscita. */}
              {!task.previewImage && !task.previewRetiredAt && (
                <p data-testid="task-preview-missing" className="mt-1.5 text-xs text-app-text-muted">
                  {tr('board.task.previewMissing', { recapture: tr('board.task.recapturePreview') })}
                </p>
              )}
            </div>
          )}
          {!twoCol && identityCard}
          {!twoCol && descCard}
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
          {!twoCol && subtasksCard}
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
          {/* "Spazio di lavoro" — the task's tab group (the agent Session, the
              browser tabs, the Plan, the attachments: the app's real
              PaneTabBar). In one column it sits HERE, between the brief and the
              thread; in two columns it is the right-hand column at full height
              (below).

              THE ORDER IS THE POINT: what you look at on top, the thread under
              it, glued to the composer. You read the conversation where you
              write it, and what it is about sits above rather than in its place.

              WHAT THIS HANDLE CAN NOW HIDE. With the session inside the group,
              closing this section closes the session too. That is accepted, not
              overlooked: the thread keeps the live row (phase, ticker, Stop and
              a one-line preview that reopens the tab), so closing the workspace
              never hides whether the agent is alive — only its steps.

              With no panes the group is not an empty section to stare at: the
              row stays, with the door to open one, which is all it takes to say
              the space exists without stealing height from the thread. */}
          {!twoCol && (
          <div className={`flex min-w-0 flex-col ${workspaceOpen && hasWorkspacePanes ? 'min-h-0 flex-1' : 'shrink-0'}`}>
            <div className="flex w-full shrink-0 items-center gap-1 border-y border-app-border pl-3 pr-1.5">
              <SectionHeader
                open={workspaceOpen}
                onToggle={toggleWorkspaceOpen}
                label={tr('board.task.workspaceLabel')}
                suffix={hasWorkspacePanes ? ` ${workspacePaneCount}` : undefined}
                testId="task-workspace-toggle"
                chevron={hasWorkspacePanes}
                disabled={!hasWorkspacePanes}
                grow
                padded
              />
              <button
                onClick={browser.addBrowserTab}
                title={tr('board.task.openTab')} aria-label={tr('board.task.openTab')}
                data-testid="task-workspace-add-tab"
                className="shrink-0 rounded p-1 text-app-text-secondary hover:bg-white/10 hover:text-app-text"
              ><Plus className="h-3.5 w-3.5" /></button>
            </div>
            {workspaceOpen && hasWorkspacePanes && (
              <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
                <GroupLayout {...browser.groupLayoutProps} />
              </div>
            )}
          </div>
          )}
          {/* THE THREAD — its own section, mounted ALWAYS, in both layouts: on
              the left with the task in two columns, under the workspace and
              above the composer in one. Its scroll is its own, sibling to the
              brief's: neither is inside the other. */}
          <div className="flex min-h-0 flex-1 flex-col border-t border-app-border" data-testid="task-session-column">
            {/* "Discussione", not "Sessione": the word "Sessione" now names the
                TAB holding what the agent did, and two neighbouring surfaces
                with the same name tell the reader nothing about which one they
                are looking at. This is the conversation — what you say and what
                comes back.

                It is not a handle. The thread never closes: it is the one zone
                the drawer must always have, because the composer hangs off it.
                No chevron, so the shape says it is not pressable. */}
            <div className="flex shrink-0 items-center gap-1 border-b border-app-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-app-text-muted">
              {tr('board.task.threadLabel')}
            </div>
            {renderThread()}
          </div>
          {/* La zona di DECISIONE: `shrink-0`, fuori dallo scroll, ultima della
              colonna. È l'invariante che il guscio esiste per garantire —
              Approva/Rimanda indietro/Landa dentro il viewport a qualunque altezza di
              finestra e con qualunque combinazione di sezioni aperte. */}
          {/* DROPPING A FILE IN HERE ATTACHES IT. Paste was already on the
              text field, drag and drop was not: a captured screenshot could be
              pasted, the same screenshot saved to disk had no way in. The drop
              zone is the whole delivery area, not the field's own thirty
              pixels: whoever drags aims at the composer. A drag carrying NO
              file (a layout pane, a text selection) leaves it alone, through
              `dragCarriesFiles`. */}
          <div
            className={`relative shrink-0 border-t p-2 ${fileDragOver ? 'border-emerald-400/60 bg-emerald-500/5' : 'border-app-border'}`}
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
            {fileDragOver && (
              <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded border border-dashed border-emerald-400/60 bg-app-bg/70 text-[11px] text-emerald-300">
                {tr('board.task.dropToAttach')}
              </div>
            )}
            {/* L'errore dell'ultima azione, PRIMA riga della zona di decisione:
                sta appiccicato ai bottoni che l'hanno prodotto (Approva, Landa,
                le scelte, il composer) e resta nel viewport quanto loro. In
                testa al drawer era vero e invisibile. */}
            {error && (
              <div
                data-testid="task-action-error"
                className="mb-2 flex items-start gap-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300"
              >
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button aria-label={tr('board.task.closeError')} onClick={() => setError(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
              </div>
            )}
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
                  task={task} disabled={busy} exclude={['land', 'send-back', 'accept', 'redo']}
                  onDone={() => { void load(); onChanged(); }}
                  onError={setError} onNeedText={() => commentRef.current?.focus()}
                />
                {/* «Ricattura evidenza» NON è più qui: era un'azione di
                    servizio sull'anteprima disegnata larga quanto una
                    decisione, in mezzo alle decisioni, e a occhio faceva
                    quantità con loro. Adesso sta attaccata all'anteprima che
                    rifà, in cima al brief — anche quando l'anteprima non c'è,
                    che è il momento in cui serve davvero. */}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span key={a.path} className="group/att relative">
                    {a.isImage ? (
                      <ZoomableImage src={getMediaUrl(a.path)} alt={a.name} title={a.name} testId="task-composer-attachment-image" className="h-12 w-12 rounded object-cover" />
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
                onClick={() => fileInputRef.current?.click()} disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                title={tr('board.task.attachFileTitle')}
                className="rounded p-1.5 text-app-text-secondary hover:bg-white/10 disabled:opacity-40"
              >{uploading ? <Spinner size="md" tone="current" /> : <Paperclip className="h-4 w-4" />}</button>
              {/* IL MICROFONO ANCHE QUI. C'era sul composer della chat e su
                  quello della board, non sul thread di un task - che ha
                  graffetta e incolla, quindi non e' un campo minore: e' un
                  campo pieno a cui mancava una cosa sola. Chi detta un task e
                  poi vuole rispondere all'agente trovava il gesto sparito.
                  Componente condiviso e non una seconda stesura: porta con se'
                  il gesto tieni-premuto, i due stati distinti e `touch-none`,
                  che una copia perde uno alla volta. */}
              <DictationButton
                testId="task-thread-dictation"
                onText={(t) => setDraft((prev) => (prev ? `${prev} ${t}` : t))}
                onError={setError}
              />
              <textarea
                ref={commentRef}
                value={draft} onChange={(e) => { setDraft(e.target.value); saveCommentCursor(); }} rows={1}
                onSelect={saveCommentCursor} onKeyUp={saveCommentCursor} onClick={saveCommentCursor}
                onFocus={() => markActiveComposer(commentCursorKey)}
                placeholder={isAgentReview ? tr('board.task.replyPlaceholder', { sendBack: sendBackLabel }) : agentBusy ? tr('board.task.steerPlaceholder') : tr('board.task.commentPlaceholder')}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
                onPaste={(e) => {
                  const imgs = imagesFromClipboard(e.clipboardData);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-app-text outline-none"
              />
              {/* IN REVIEW IL COMPOSER HA UN GESTO SOLO, ED È QUELLO CHE NON
                  DECIDE NIENTE.
                  Qui ce n'erano due: «Rimanda» (azzurro) e «Nota». Il primo era
                  il gemello del «Rimanda indietro» grande qui sopra — stesso
                  `POST …/review`, stessa decisione, stessa colonna d'arrivo — e
                  due parole per una porta sola non sono due uscite: sono un
                  dubbio davanti a entrambe. La decisione vive con le decisioni;
                  qui resta «Nota», che è l'unica cosa che il composer sa fare e
                  che i bottoni sopra non fanno: scrivere senza svegliare
                  nessuno. Il testo che scrivi qui lo raccoglie «Rimanda
                  indietro» — lo dice il placeholder, che lo chiama per nome.
                  Fuori dalla review il composer resta quello di sempre. */}
              {isAgentReview ? (
                <button
                  onClick={() => void send({ quiet: true })} disabled={sending || (!draft.trim() && attachments.length === 0)}
                  title={tr('board.task.quietNoteTitle')}
                  data-testid="task-reply-quiet-note"
                  className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                >{sending ? <Spinner size="md" tone="current" /> : <StickyNote className="h-3.5 w-3.5" />} {tr('board.task.quietNote')}</button>
              ) : (
                <button
                  onClick={() => void send()} disabled={sending || (!draft.trim() && attachments.length === 0)}
                  title={agentBusy ? tr('task.comment.toAgent') : tr('task.comment')}
                  className={`rounded p-1.5 text-white disabled:opacity-50 ${agentBusy ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
                >{sending ? <Spinner size="md" tone="current" /> : <Send className="h-4 w-4" />}</button>
              )}
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
            {hasWorkspacePanes ? (
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
  const work = subtaskWorkChip(node);
  // La ragione di coda, ma solo quando è FERMA: `subtaskQueueChip` è dove sta
  // scritto il perché del filtro.
  const stalled = subtaskQueueChip(node);
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
            className={`min-w-0 flex-1 truncate text-left text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-xs ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-secondary'}`}>{node.text}</span>
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
    else openExternalOnce(getMediaUrl(p)); // target=_blank is dead in WKWebView
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {media.map((p) => isImg(p) ? (
        <ZoomableImage key={p} src={getMediaUrl(p)} alt={p.split('/').pop() ?? ''} title={p.split('/').pop()} testId="task-media-image" className="max-h-40 max-w-full rounded-md object-contain" />
      ) : (
        <a
          key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" onClick={(e) => open(e, p)}
          title={onPreview ? tr('task.media.preview') : p.split('/').pop()}
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
// `SessionMsg` lives in `./sessionBuckets` now, next to the code that places
// the messages between the comments.

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
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName);
  // L'app che sposta una card da sé non è una notizia: il nome resta solo per
  // chi lo è (tu, un agent, la verifica).
  const mover = who.kind === 'system' || who.kind === 'dispatcher' ? null : who.name;
  return (
    <span
      className="flex min-w-0 max-w-full items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-muted"
      title={`${who.name} (${who.detail}) · ${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} /> : <span className="h-1 w-1 shrink-0 rounded-full bg-app-text-faint" />}
      {mover && <span className="shrink-0 text-app-text-secondary">{mover} →</span>}
      <span className="shrink-0">{valid ? STATUS_LABEL[to] : comment.content}</span>
      {/* La ragione: perché la card si è mossa, sul chip che la muove. Tagliata
          a vista, MAI dal testo — il tooltip la porta intera e il DOM pure, che
          è quello su cui una spec la cerca. */}
      {valid && ev?.reason && <span className="min-w-0 truncate text-app-text-faint">· {ev.reason}</span>}
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
      className="flex flex-wrap items-center gap-1 px-1"
      data-testid="task-status-trail"
      aria-label={tr('board.task.statusTrail')}
    >
      {comments.map((c) => <StatusChip key={c.id} comment={c} ownerName={ownerName} />)}
      <span className="shrink-0 text-[11px] text-app-text-faint">
        {new Date(last.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

export function CommentBubble({ comment, ownerName = null, resolvedParked = false, onPreview }: {
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
}) {
  const tr = useT();
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
        <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-400/80">
          <Camera size={11} /> {tr('board.task.reviewPreview')}
          <span className="ml-auto normal-case tracking-normal text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>
        <div className="text-sm text-app-text"><CommentBody content={comment.content} /></div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
      </div>
    );
  }
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName);
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
  const oneLiner = app && (resolvedParked || !/[\n\r]/.test(comment.content.trim()));
  if (oneLiner) {
    return (
      <div
        className="flex max-w-full items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-muted"
        data-testid="task-app-note"
        title={`${who.name} (${who.detail}) · ${comment.content} · ${new Date(comment.createdAt).toLocaleString('it-IT')}`}
      >
        <Bot className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{parseQuestionBlock(comment.content)?.question ?? comment.content}</span>
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
        <p className="flex items-baseline gap-1.5 text-[10px]" title={who.detail}>
          <span className={`font-medium uppercase tracking-wide ${app ? 'text-app-text-faint' : 'text-app-text-secondary'}`}>{who.name}</span>
          <span className="ml-auto text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>
        <div className={`text-sm ${app ? 'text-app-text-muted' : 'text-app-text'}`}>
          <CommentBody content={comment.content} />
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
      <div className="user-bubble max-w-[88%] rounded-lg bg-app-user-bubble px-2.5 py-1.5 text-sm text-app-text">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-right text-[9px] text-app-text-muted" title={who.name}>{commentTime(comment.createdAt)}</p>
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
  // Un recinto che NON parsa (aperto e mai chiuso, corpo vuoto) arriverebbe qui
  // com'e', e per il renderer ```…``` e' un blocco di codice: prosa in
  // `whitespace-pre`, cioe' scroll orizzontale. `questionToProse` e' un no-op su
  // tutto il resto. Vedi `shared/question-prose.ts`.
  if (!q) return <div className={`mt-0.5 text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{questionToProse(content)}</ChatMarkdown></div>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <div className={`text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{outside}</ChatMarkdown></div>}
      {/* La domanda e le sue opzioni passano dallo STESSO renderer markdown del
          resto del thread. Erano le uniche due stringhe stampate crude, e
          l'agent le scrive come scrive tutto il resto: `**Opus**`, `` `--flag` ``
          e i backtick attorno a un path arrivavano qui come caratteri. */}
      <div className="rounded border border-rose-500/25 bg-rose-500/5 px-2 py-1.5">
        <div className={`text-[13px] leading-snug text-app-text ${COMPACT_MD_CLS}`}>
          <ChatMarkdown components={{}}>{q.question}</ChatMarkdown>
        </div>
        {q.options.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {q.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-app-text">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-rose-300/70" />
                <span className={`min-w-0 flex-1 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{opt}</ChatMarkdown></span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
