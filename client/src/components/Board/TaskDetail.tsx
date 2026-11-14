import { pickPlanComment } from './planPanel';
import { DANGER_TEXT } from '@/lib/popoverStyles';
import { useTopics as useTopicMap } from '../../contexts/TopicsContext';
import { useProvidersSnapshot } from '@/hooks/useProvidersSnapshot';
import { resolveShownEffortTier } from '@/lib/effortTiers';
import { reconcileAcknowledgedComments } from './acknowledgedComments';
import type { TaskCommentAcknowledgement } from '../../../../shared/task-comment-ack';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useSyncExternalStore, type TouchEvent as ReactTouchEvent } from 'react';
import { useT, useLocale } from '../../hooks/useT';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useOwnerName } from '../../hooks/useOwnerName';
import { AlertTriangle } from 'lucide-react';
import { useSectionOpen } from './sectionAccordion';
import { Spinner } from '../Shared/Spinner';
import { getMediaUrl } from '../../lib/api';
import { uploadAttachment, MAX_ATTACHMENTS, type StagedAttachment } from '../../lib/attachments';
import { isSupersededPreviewNote } from '../../../../shared/preview-retirement';
import { isResolvedParkedQuestion } from '../../../../shared/parked-question';
import { pendingQuestionComment } from '../../../../shared/board';
import { surfaceTopicsRoutingEnabled } from '../../lib/topicsRoutingGate';
import { useTaskModelTrigger } from '../../hooks/useTaskModelTrigger';
import { copyText } from '../../lib/clipboard';
import { type TaskSessionState } from '../../lib/taskSession';
import { enqueueProjectBrowserNavigate, isProjectWindowMounted } from '../../state/pane/adapters';
import { useTaskBrowserTabs, taskBrowserTabs, liveTabs, workspaceTwinContextId } from '../../state/taskBrowserTabs';
import { paneIdToContextId } from '../../state/taskBrowserLayout';
import { nodesOf, useMachines } from '../../state/machinesStore';
import { writeCursor, restoreCursor } from '../../lib/composerCursor';
import { landingBand } from './landingBand';
import { useLandingTicket } from './useLandingTicket';
import { boardApi, isAgentWorking, isThreadSpeech, parseQuestionBlock, isProjectlessId, boardDrafts, blockedByChip, subtaskWorkChip, reopenedChip, type TaskLabel, type BoardTask, type TaskStatus, type TaskComment, type BoardProjectRef } from '../../lib/board';
import { collectTaskMediaPaths, hasConversationMedia } from './taskMedia';
import { taskActionErrorMessage } from './taskActionError';
import { usableQuestionOptions } from './taskChoices';
import { drawerSurfaceLabels, taskActionWord } from './taskActionWords';
import { manualStatusTarget } from '../../lib/boardOrder';
import { diffFocusPath } from './constants';
import { autoGrow, taskCopyText } from './format';
import { getSessionMessagesFromStore, subscribeSession } from '../../state/messageStore';
import { taskSessionRuns } from './taskSessionRuns';
import type { ChatMessage } from '../../types';
import { holdTopic } from '../../state/topicSubscriptions';
import { mergeTaskTimeline, type TimelineItem } from './taskTimeline';
import { deliveryNotesToFold } from './taskDeliveryNotes';
import { usePaneAlive } from '../../state/paneLiveness';
import { addBoardProject, projectNameFromId, useBoardProjects, UNKNOWN_PROJECT_NAME } from '../../lib/boardProjectsStore';
import { GroupLayout } from '../Layout/GroupLayout';
import { useTaskBrowserGroupLayout, type TaskBrowserGroupLayout, type RenderSurface } from './useTaskBrowserGroupLayout';
import { SurfaceContent } from './TaskComments';
import { DeliveryPanel, DeliveryBanners } from './TaskDeliveryBand';
import { IdentityCard, TaskTabsBar, TaskTopBar } from './TaskHeader';
import { TaskDetailsPanel } from './TaskMetadata';
import { TaskComposer, ThreadRows } from './TaskThread';

/** One shared empty array: a new one per read would loop `useSyncExternalStore`. */
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];








// ── Detail: drawer by default, expandable review surface ────────────────────

export function TaskDetail({ projectId, taskId, initialStatus, initialTitle, bump, onClose, onChanged, onOpenTask, onOpenTopic, onMessage, loadHistory, sessionState = 'unknown', focusPaneId, boardTopicsRoutingDefault = null, boardDispatchModel = null }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
  /**
   * The status the board already holds for this card. The chip draws it on the
   * drawer's first frame instead of "Loading...", which was a different width:
   * the header changed size 30 ms after mount (fluidity audit panes:F6).
   */
  initialStatus?: TaskStatus;
  /**
   * The title the board already holds for this card. Without it the drawer
   * showed a spinner until `boardApi.get` (thread, children, everything) came
   * back, so the title - the one thing that tells you the right card opened -
   * arrived only with the rest. With it the header (project and title) is
   * readable on the first frame, and the real row replaces it when it lands.
   */
  initialTitle?: string;
  /**
   * Change signal (`taskDetailBump` of the board's live row: its updatedAt and
   * its queue reason): any WS task:updated (a step flipping, a new comment, a
   * held card re-sent with another block) re-fetches the open detail, so the
   * drawer follows the agent in real time instead of freezing at mount.
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
  /** AICTRL-05: default di QUESTA board per lo switch. `null` nella board globale, dove non esiste UN default e decide il solo legacy del task. allow-italian: dice cosa significa `null` qui */
  boardTopicsRoutingDefault?: boolean | null;
  /** Serve a leggere il prefisso legacy quando il task non ha un modello proprio. allow-italian: perche' il modello della board entra nello switch */
  boardDispatchModel?: string | null;
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
  // A focus can name a FILE of the diff instead of a pane (`diffFocusFor`, a
  // row of the card's changed-files chip): that one opens the delivery band,
  // where «Modifiche» lives, and never the workspace.
  const focusDiff = diffFocusPath(focusPaneId);
  const paneFocus = focusDiff ? undefined : focusPaneId;
  const [deliveryOpen, setDeliveryOpen] = useState(!!focusDiff);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [workspaceOpen, setWorkspaceOpen] = useState(!!paneFocus);
  const toggleWorkspaceOpen = () => setWorkspaceOpen((open) => !open);
  useEffect(() => {
    setDetailsOpen(false);
    setDeliveryOpen(!!focusDiff);
    setWorkspaceOpen(!!paneFocus);
  }, [taskId, focusDiff, paneFocus]);
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
  // Last observed scroll position: telling a scroll the layout caused from
  // one the reader did needs the sample from before this event.
  const lastTopRef = useRef(Number.POSITIVE_INFINITY);
  const lastHeightRef = useRef(Number.POSITIVE_INFINITY);
  const lastClientHeightRef = useRef(0);
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

  // The thread re-wraps when the drawer narrows, and rows render after the
  // last re-pin: while the reader is following, any size change of the
  // thread or its scroller re-pins. A reader who scrolled up is left alone.
  const threadContentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroll = threadScrollRef.current;
    const content = threadContentRef.current;
    if (!scroll || !content) return;
    const repin = () => {
      lastTopRef.current = scroll.scrollTop;
      lastHeightRef.current = scroll.scrollHeight;
      lastClientHeightRef.current = scroll.clientHeight;
      if (stickRef.current) scroll.scrollTop = scroll.scrollHeight;
    };
    repin();
    const observer = new ResizeObserver(repin);
    observer.observe(scroll);
    observer.observe(content);
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
  // The chip's status: the loaded row, else the board's copy while it loads.
  // A failed first read still says so, instead of a status nobody confirmed.
  const chipStatus: TaskStatus | null = task?.status ?? (loadFailedMessage ? null : initialStatus ?? null);
  // A card closed while its drawer is open: park its live preview tabs. Only the
  // transition counts, so opening an already-done card leaves its tabs alone.
  const seenStatusRef = useRef<TaskStatus | null>(null);
  useEffect(() => {
    const status = task?.status ?? null;
    const before = seenStatusRef.current;
    seenStatusRef.current = status;
    if (before && before !== 'done' && status === 'done') taskBrowserTabs.closeAll(taskId);
  }, [task?.status, taskId]);
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
      //
      // `answerTo` NAMES THE QUESTION ON SCREEN. The server's registry of open
      // questions is keyed by TASK, and two sessions of one task (a coordinator
      // and its child) can both want it: without the id a yes read on one
      // message was delivered to whichever question was open at that instant,
      // and a confirmed send left for a different recipient. With it, a reply
      // to a question that is no longer the open one stays a note.
      const saved = await boardApi.comment(projectId, taskId, v || '(allegato)', {
        media, quiet, answerTo: !quiet && pending ? lastThreadComment?.id : undefined,
      });
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
  const drawerRouting = surfaceTopicsRoutingEnabled(task ?? {}, boardTopicsRoutingDefault, boardDispatchModel);
  // Same value the chat bar shows: topic override, else the tier its provider imposes.
  const topicMap = useTopicMap();
  const { snapshot: providersSnapshot } = useProvidersSnapshot();
  const sessionTopic = task?.assignedTopicId ? topicMap[task.assignedTopicId] : undefined;
  const shownEffort = resolveShownEffortTier(
    providersSnapshot?.providers ?? [],
    sessionTopic?.effort ?? task?.effort ?? null,
    sessionTopic?.provider && sessionTopic.model ? { provider: sessionTopic.provider, model: sessionTopic.model } : null,
    sessionTopic?.provider ?? undefined,
  );
  const modelTrigger = useTaskModelTrigger(task?.model || null, drawerRouting, 'task', boardDispatchModel);
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

  // The selector closes itself after a choice; a heading's engine keeps it
  // open (`keepOpen`), so closing here would undo that.
  const changeModel = async (model: string | null) => {
    if (!task || task.assignedTopicId || (task.model ?? null) === model || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { model }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // AICTRL-01: same session-fixed guard as changeModel — once a topic exists,
  // the routing decision for that run has already been made.
  const changeTopicsRouting = async (next: boolean) => {
    if (!task || task.assignedTopicId || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { topicsRouting: next }); setError(null); await load(); onChanged(); }
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
  // "This Mac only": the overflow never moves the card when the Mac is full.
  const toggleStayLocal = async () => {
    if (!task || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { stayLocal: !task.stayLocal }); setError(null); await load(); onChanged(); }
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
  // The row's project, or the board's until the row arrives: the header is
  // already drawn with the title the board knows (`initialTitle`).
  const headerProjectId = task?.projectId ?? (initialTitle != null ? projectId : undefined);
  const currentProject = projects?.find((p) => p.projectId === headerProjectId) ?? null;
  const projectLabel = headerProjectId && isProjectlessId(headerProjectId)
    ? 'Nessun progetto'
    // `?? UNKNOWN_PROJECT_NAME`: da un id che non ha un nome dentro (un UUID)
    // `projectNameFromId` torna `null`, e a schermo va la frase, non il codice.
    : currentProject?.name ?? (headerProjectId ? projectNameFromId(headerProjectId) ?? UNKNOWN_PROJECT_NAME : '');
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
  const pendingFocusRef = useRef<string | null>(paneFocus ?? null);
  useEffect(() => { pendingFocusRef.current = paneFocus ?? null; }, [taskId, paneFocus]);
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
      className={`pane-frost flex flex-col border-app-border ${swiping ? '' : 'transition-transform duration-base'} absolute inset-0 z-40 w-full pb-[var(--mobile-band-own-h,0px)] lg:relative lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l ${
        wide ? 'lg:w-[min(64rem,72%)] lg:shadow-2xl' : 'lg:w-96 lg:max-w-[75%]'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-app-border px-3 py-2.5">
        <TaskTopBar blockerChipRef={blockerChipRef} busy={busy} changeStatus={changeStatus} chipStatus={chipStatus} copied={copied}
          copyTask={copyTask} loadFailedMessage={loadFailedMessage} onClose={onClose} onOpenTopic={onOpenTopic} openBlockerMenu={openBlockerMenu}
          openInWorkspace={openInWorkspace} optionsBtnRef={optionsBtnRef} optionsMenuOpen={optionsMenuOpen} sessionState={sessionState}
          setDeliveryOpen={setDeliveryOpen} setDetailsOpen={setDetailsOpen} setOptionsMenuOpen={setOptionsMenuOpen}
          setStatusMenuOpen={setStatusMenuOpen} setSubtaskComposerOpen={setSubtaskComposerOpen} setSubtasksOpen={setSubtasksOpen}
          setWorkspaceOpen={setWorkspaceOpen} statusBtnRef={statusBtnRef} statusMenuOpen={statusMenuOpen} task={task}
          togglePlanFirst={togglePlanFirst} toggleReuseContext={toggleReuseContext} toggleWide={toggleWide} tr={tr} wide={wide}
          workspaceManifest={workspaceManifest} />
      </div>
      <DeliveryBanners busy={busy} deploying={deploying} doDeploy={doDeploy} doLand={doLand} landWord={landWord} landingBanda={landingBanda}
        notice={notice} setNotice={setNotice} task={task} tr={tr} />
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
          <AlertTriangle className={`h-6 w-6 ${DANGER_TEXT}`} />
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
        <div className="flex min-h-0 flex-1 flex-col">
          {initialTitle != null && <div className="shrink-0" data-testid="task-brief-header">
            <IdentityCard blockedChip={blockedChip} blockerAnchorRef={blockerAnchorRef} blockerCandidates={blockerCandidates}
              blockerChipRef={blockerChipRef} blockerMenuOpen={blockerMenuOpen} boardTasks={boardTasks} cancelKey={cancelKey}
              currentProject={currentProject} doCreateProject={doCreateProject} doMove={doMove} doOpenProject={doOpenProject}
              editingTitle={editingTitle} initialTitle={initialTitle} moveBlocked={moveBlocked} onOpenTask={onOpenTask}
              openBlockerMenu={openBlockerMenu} openProjMenu={openProjMenu} pickBlocker={pickBlocker} projBusy={projBusy} projChipRef={projChipRef}
              projMenuOpen={projMenuOpen} projectLabel={projectLabel} projects={projects} reopened={reopened} saveTitle={saveTitle}
              setBlockerMenuOpen={setBlockerMenuOpen} setEditingTitle={setEditingTitle} setProjMenuOpen={setProjMenuOpen}
              setTitleDraft={setTitleDraft} task={task} titleDraft={titleDraft} tr={tr} />
          </div>}
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="md" tone="current" className="text-app-text-muted" />
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0" data-testid="task-brief-header">
        <IdentityCard blockedChip={blockedChip} blockerAnchorRef={blockerAnchorRef} blockerCandidates={blockerCandidates}
          blockerChipRef={blockerChipRef} blockerMenuOpen={blockerMenuOpen} boardTasks={boardTasks} cancelKey={cancelKey}
          currentProject={currentProject} doCreateProject={doCreateProject} doMove={doMove} doOpenProject={doOpenProject} editingTitle={editingTitle}
          initialTitle={initialTitle} moveBlocked={moveBlocked} onOpenTask={onOpenTask} openBlockerMenu={openBlockerMenu} openProjMenu={openProjMenu}
          pickBlocker={pickBlocker} projBusy={projBusy} projChipRef={projChipRef} projMenuOpen={projMenuOpen} projectLabel={projectLabel}
          projects={projects} reopened={reopened} saveTitle={saveTitle} setBlockerMenuOpen={setBlockerMenuOpen} setEditingTitle={setEditingTitle}
          setProjMenuOpen={setProjMenuOpen} setTitleDraft={setTitleDraft} task={task} titleDraft={titleDraft} tr={tr} />
      </div>
      <TaskTabsBar browser={browser} deliveryOpen={deliveryOpen} detailsOpen={detailsOpen} detailsScrollRequestedRef={detailsScrollRequested}
        hasWorkspacePanes={hasWorkspacePanes} setDeliveryOpen={setDeliveryOpen} setDetailsOpen={setDetailsOpen} setWorkspaceOpen={setWorkspaceOpen}
        stickRef={stickRef} toggleWorkspaceOpen={toggleWorkspaceOpen} tr={tr} twoCol={twoCol} workspaceOpen={workspaceOpen}
        workspacePaneCount={workspacePaneCount} />
      <div className={`flex min-h-0 flex-1 ${twoCol ? 'flex-row' : 'flex-col'}`}>
        <div className={`relative flex min-h-0 min-w-0 flex-col ${twoCol ? 'w-[min(50%,30rem)] shrink-0 border-r border-app-border' : 'flex-1'}`}>
          <div className={`${workspaceOpen && !twoCol ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`} data-testid="task-session-column">
            <ThreadRows agentBusy={agentBusy} answerOption={answerOption} busy={busy} children={children} commentReceipt={commentReceipt}
              composerHeight={composerHeight} deliveryWord={deliveryWord} detailsOpen={detailsOpen} foldedDeliveryNotes={foldedDeliveryNotes}
              lastClientHeightRef={lastClientHeightRef} lastHeightRef={lastHeightRef} lastThreadComment={lastThreadComment} lastTopRef={lastTopRef}
              openTaskPane={openTaskPane} ownerName={ownerName} pending={pending} previewInThread={previewInThread} replyOptions={replyOptions}
              sending={sending} sessionKey={sessionKey} sessionRuns={sessionRuns} stickRef={stickRef} task={task} threadContentRef={threadContentRef}
              threadScrollRef={threadScrollRef} timeline={timeline} tr={tr} uploading={uploading}
              details={
                <>
                  <TaskDetailsPanel addSubtask={addSubtask} addingSub={addingSub} boardDispatchModel={boardDispatchModel} busy={busy}
                    cancelKey={cancelKey} changeModel={changeModel} changeNode={changeNode} changePriority={changePriority}
                    changeTopicsRouting={changeTopicsRouting} children={children} descDraft={descDraft} descOpen={descOpen} detailsOpen={detailsOpen}
                    doneCount={doneCount} drawerRouting={drawerRouting} editingDesc={editingDesc} labelBtnRef={labelBtnRef}
                    labelMenuOpen={labelMenuOpen} locale={locale} machines={machines} modelBtnRef={modelBtnRef} modelMenuOpen={modelMenuOpen}
                    modelTrigger={modelTrigger} nodeBtnRef={nodeBtnRef} nodeMenuOpen={nodeMenuOpen} nodePickerLocked={nodePickerLocked} nodes={nodes}
                    onOpenTask={onOpenTask} prioBtnRef={prioBtnRef} prioMenuOpen={prioMenuOpen} projectId={projectId} saveDesc={saveDesc}
                    setDescDraft={setDescDraft} setEditingDesc={setEditingDesc} setLabelMenuOpen={setLabelMenuOpen} setModelMenuOpen={setModelMenuOpen}
                    setNodeMenuOpen={setNodeMenuOpen} setPrioMenuOpen={setPrioMenuOpen} setSubDraft={setSubDraft} shownEffort={shownEffort}
                    subDraft={subDraft} subtaskComposerOpen={subtaskComposerOpen} subtasksOpen={subtasksOpen} task={task}
                    toggleDescOpen={toggleDescOpen} toggleLabel={toggleLabel} toggleStayLocal={toggleStayLocal} toggleSubtasksOpen={toggleSubtasksOpen}
                    tr={tr} workAncestorId={workAncestorId} workChip={workChip} />
                  <DeliveryPanel browser={browser} bump={bump} busy={busy} commentRef={commentRef} decide={decide} deliveryOpen={deliveryOpen}
                    doLand={doLand} downloadsOpen={downloadsOpen} focusDiff={focusDiff} isAgentReview={isAgentReview} load={load}
                    mediaPaths={mediaPaths} onChanged={onChanged} onOpenTopic={onOpenTopic} openTaskPane={openTaskPane} projectId={projectId}
                    recapturePreview={recapturePreview} recapturing={recapturing} sendBack={sendBack} sending={sending} setError={setError}
                    setWorkspaceOpen={setWorkspaceOpen} task={task} taskId={taskId} toggleDownloadsOpen={toggleDownloadsOpen} tr={tr} />
                </>
              } />
          </div>
          {workspaceOpen && !twoCol && (
            <div className="flex min-h-0 flex-1 flex-col" data-testid="task-drawer-body">
              {hasWorkspacePanes ? <GroupLayout {...browser.groupLayoutProps} /> : (
                <p className="p-4 text-compact leading-4 text-app-text-muted">{tr('board.task.noWorkspaceTabs')}</p>
              )}
            </div>
          )}
          <TaskComposer agentBusy={agentBusy} attachments={attachments} busy={busy} commentCursorKey={commentCursorKey} commentRef={commentRef}
            composerAreaRef={composerAreaRef} composerPlaceholder={composerPlaceholder} composerSendTitle={composerSendTitle} draft={draft}
            error={error} fileDragOver={fileDragOver} fileInputRef={fileInputRef} isAgentReview={isAgentReview} isMobile={isMobile} load={load}
            loadFailedMessage={loadFailedMessage} onOpenTopic={onOpenTopic} saveCommentCursor={saveCommentCursor} send={send} sending={sending}
            sessionState={sessionState} sessionTopic={sessionTopic} setAttachments={setAttachments} setDraft={setDraft} setError={setError}
            setFileDragOver={setFileDragOver} shownEffort={shownEffort} stopAgent={stopAgent} task={task} taskId={taskId} tr={tr} twoCol={twoCol}
            uploadFiles={uploadFiles} uploading={uploading} workspaceOpen={workspaceOpen} />
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
                  className="rounded bg-black/10 dark:bg-white/10 px-2.5 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
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









