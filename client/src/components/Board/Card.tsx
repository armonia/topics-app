import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ArchiveRestore, CircleSlash, ClipboardList, Copy, Hourglass, Lock, MessageSquare, Plus, RotateCcw, Send, ShieldCheck, Square, StickyNote, Trash2, UserRound, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { STATUS_LABEL, blockedByChip, boardApi, commentAuthorLabel, isAgentWorking, isProjectlessId, parseQuestionBlock, reopenedChip, showsLandingDebt, subtaskWorkChip, systemDeliveryChip, waitingOnThisChip, whoCloses, type BoardTask, type TaskStatus } from '../../lib/board';
import { selectCardComments, type CardComments } from './cardComments';
import { useConfirm } from '../../hooks/useConfirm';
import { useLongPress, openContextMenuAt } from '../../hooks/useLongPress';
import { useMobile } from '../../hooks/useMobile';
import { PreviewMedia } from './PreviewMedia';
import { TaskChoiceMenu, TaskChoiceRow } from './TaskChoiceRow';
import { taskActionErrorMessage } from './taskActionError';
import { usableQuestionOptions } from './taskChoices';
import { taskChoiceState } from './taskChoices';
import { taskActionWord } from './taskActionWords';
import { useT } from '../../hooks/useT';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { PRIORITY_DOT, PRIORITY_LABEL, DISPATCH_CHIP, COMPACT_MD_CLS, mediaPaneIdFor, type LiveUsage, type OpenTask } from './constants';
import { copyText } from '../../lib/clipboard';
import { canOpenTaskSession, shouldExplainMissingSession, type TaskSessionState } from '../../lib/taskSession';
import { fmtMs, fmtLive, fmtTok, fmtModel, fmtUpdatedAt, taskCopyText } from './format';
import { StatusIcon, DispatchChip, QueueReasonChip, TaskIdChip, LabelChip } from './atoms';
import { POPOVER_DIVIDER, POPOVER_ITEM, POPOVER_ITEM_DANGER } from '@/lib/popoverStyles';

// ── Column ────────────────────────────────────────────────────────────────
export function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, cardError, onCardError, onRefetch, onOpenTopic, resolveSession, tasksById, projectPathById, liveById, awaitingHuman, justMoved, justCreated, archived = false }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: OpenTask; onCreate: (text: string) => void;
  canCreate: boolean; showProject: boolean; onRefetch: () => void;
  /** L'errore dell'ULTIMA azione fallita, con la card a cui appartiene: la
   *  colonna lo consegna solo a quella, il resto riceve `null`. */
  cardError: { taskId: string; message: string } | null;
  onCardError: (taskId: string, message: string | null) => void;
  onOpenTopic?: (topicId: string) => void;
  /** La sessione dell'agente esiste ancora? Risolta QUI e passata alla card come
   *  stringa, non come funzione: una card memoizzata confronta le props in modo
   *  superficiale, e un risolutore nuovo a ogni render della board le
   *  ridisegnerebbe tutte. Vedi `lib/taskSession.ts`. */
  resolveSession?: (assignedTopicId: string | null | undefined) => TaskSessionState;
  tasksById: Map<string, BoardTask>; projectPathById: Map<string, string>;
  /** Live per-turn usage keyed by task id (ticking chip on working cards). */
  liveById: Map<string, LiveUsage>;
  /** Task che in questo momento aspettano una persona (evento transitorio). */
  awaitingHuman: Set<string>;
  /** Card appena arrivate in una colonna → quale: lampeggiano per un paio di
   *  secondi, col colore della colonna d'arrivo. */
  justMoved: Map<string, TaskStatus>;
  /** Card appena NATE: stesso lampo all'altro capo della vita del task, in azzurro. */
  justCreated: Set<string>;
  /** La colonna sta mostrando l'ARCHIVIO: le sue card si ripristinano, non si
   *  archiviano di nuovo. */
  archived?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };
  // Stable identity across the board's 4s live-usage tick: SortableContext gets a
  // fresh array only when the task set actually changes, not every render.
  const itemIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  // Responsive columns. The board is a scroll-snap carousel at EVERY breakpoint:
  // each column `snap-center`s to the middle as its own "slide", so whenever the
  // columns overflow the viewport (a phone, or a narrow desktop pane / open drawer)
  // scrolling glides column-by-column and always frames a useful one — instead of
  // stopping half-way between two. When everything already fits (wide desktop),
  // there is no overflow so snapping is inert. Columns are a fixed w-72 with a peek
  // of their neighbours on both sides; Review is wider (its own, roomier slide).
  const isReview = status === 'review';
  const snapCls = 'snap-center';
  // Width is a RANGE, not a number: `basis` is the floor (what a column is worth
  // when the board overflows and scroll-snapping takes over), `grow` spends any
  // leftover room on a wide board so the columns fill it instead of leaving a
  // dead gutter, and `max-w` is the ceiling — past it a card stops being easier
  // to read and just gets wider, so the surplus goes back to the gutter.
  // The floor holds because the item is already `shrink-0`.
  // Review is the approval surface — roomier floor AND roomier ceiling than the
  // working columns on every viewport.
  //
  // SUL TELEFONO IL PAVIMENTO DI REVIEW È LO SCHERMO, non un numero.
  // Sotto `sm` la riga eccede sempre (cinque colonne non ci stanno mai), quindi
  // `grow` non ha avanzo da spendere e ogni colonna vale il suo `basis`: con un
  // basis fisso da 22rem la colonna dell'approvazione restava 352px comunque —
  // su un 390 un'unghia di margine, su un 360 già più larga della finestra, e
  // in nessuno dei due casi una slide che coincide con lo schermo. `basis-full`
  // la lega alla larghezza VISIBILE della riga, che è ciò che cambia da telefono
  // a telefono: la review è la superficie su cui si decide, e da mobile è UNA
  // slide intera. Il tetto (`max-w`) resta il limite di leggibilità.
  // Da `sm` in su non cambia niente: 22rem, e 32rem da `lg`.
  //
  // …E IL PAVIMENTO NON BASTA SENZA `min-w-0`. Un flex item nasce con
  // `min-width: auto`, cioè «mai più stretto del tuo contenuto», e quel minimo
  // batte sia il `basis` sia il `max-w`. Misurato: con in colonna una card il
  // cui titolo è un path assoluto senza spazi, Review stava a 405px SIA a 390
  // che a 360 di finestra — larghezza identica, quindi non seguiva lo schermo
  // affatto: seguiva la parola più lunga. Fuori dalla riga di 31px sul primo
  // telefono e di 61 sul secondo.
  // `break-words` sul titolo (Card, più sotto) NON salva: `overflow-wrap:
  // break-word` spezza la parola quando la larghezza è già decisa, ma non
  // abbassa la dimensione min-content che quella decisione usa. Il pavimento
  // lo toglie solo `min-w-0`, e da lì in poi `break-words` fa il suo lavoro
  // dentro la colonna stretta.
  // Vale per TUTTE le colonne, non solo Review: la stessa card in Todo avrebbe
  // sfondato allo stesso modo il suo `max-w`.
  const widthCls = isReview
    ? 'min-w-0 grow basis-full sm:basis-[22rem] max-w-[34rem] lg:basis-[32rem] lg:max-w-[44rem]'
    : 'min-w-0 grow basis-72 max-w-[26rem]';
  const borderCls = isOver ? 'border-emerald-400/60' : 'border-app-border';
  const bgCls = isOver ? 'bg-emerald-400/5' : 'bg-white/5';

  return (
    <div ref={setNodeRef} data-testid={`kanban-column-${status}`} className={`flex ${widthCls} shrink-0 flex-col rounded-lg border ${snapCls} ${borderCls} ${bgCls}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-app-text-heading">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-app-text-secondary">{tasks.length}</span>
      </div>
      {/* Bottom clearance lives on the scroll body (not the outer board padding)
          so the column FRAME reaches the bottom of the pane, while a full column's
          last card can still scroll clear of the floating "Descrivi un task" box.
          On a short column it is invisible slack below the already-empty area.

          MISURATO, non stimato: il composer è alto 110px e il suo bordo
          superiore cade 129px sopra il fondo del corpo colonna. Con `pb-16`
          (64px) la corsa NON bastava — nemmeno scrollando fino in fondo la
          card ultima riusciva a uscire da sotto quel riquadro, e un task appena
          creato (che prende `kanban_order = max + 1`, quindi atterra proprio
          lì) restava dietro alla scatola in cui l'avevi scritto. `pb-36` =
          144px: 129 di composer + un margine. Il valore qui dà la CORSA; a
          decidere dove fermarsi è la misura del composer viva, in
          KanbanBoardPane — perché quell'altezza cresce col testo. */}
      {/* scrollbar-standard keeps the app's standard thin hover scrollbar as the
          single indicator and zeroes the legacy ::-webkit-scrollbar, so the
          native bar no longer renders ON TOP of it (the "double bar" on hover). */}
      {/* `pt-1.5` = i 6px che il LAMPO di una card dipinge fuori dal suo bordo
          (vedi `.task-flash` in index.css). Un corpo colonna con
          `overflow-y-auto` è un contenitore di scorrimento e taglia al suo
          padding box: ai lati gli 8px di `px-2` bastano, in cima la stanza non
          c'era proprio e alla prima card della colonna l'alone si vedeva mozzato
          di netto. Sei pixel, non uno spazio scelto a occhio. */}
      <div data-testid={`kanban-column-body-${status}`} className="flex-1 space-y-2 overflow-y-auto px-2 pt-1.5 pb-36 scrollbar-standard">
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <Card
              key={t.id} task={t} onOpen={onOpen} showProject={showProject} onRefetch={onRefetch} onOpenTopic={onOpenTopic}
              error={cardError?.taskId === t.id ? cardError.message : null}
              onError={onCardError}
              sessionState={resolveSession?.(t.assignedTopicId) ?? 'unknown'}
              parentTitle={t.parentTaskId ? tasksById.get(t.parentTaskId)?.text : undefined}
              projectPath={projectPathById.get(t.projectId)}
              live={liveById.get(t.id)}
              awaiting={awaitingHuman.has(t.id)}
              justMovedTo={justMoved.get(t.id)}
              justCreated={justCreated.has(t.id)}
              archived={archived}
            />
          ))}
        </SortableContext>
        {!canCreate ? null : adding ? (
          <div className="rounded-md border border-app-border bg-white/5 p-2">
            <textarea
              autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setText(''); setAdding(false); } }}
              className="w-full resize-none bg-transparent text-sm text-app-text outline-none" rows={2} placeholder="Task…"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button onClick={() => { setText(''); setAdding(false); }} className="rounded px-2 py-0.5 text-xs text-app-text-secondary hover:bg-white/10">Annulla</button>
              <button onClick={submit} className="rounded bg-emerald-500/80 px-2 py-0.5 text-xs text-white hover:bg-emerald-500">Aggiungi</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-app-text-secondary hover:bg-white/5">
            <Plus className="h-3.5 w-3.5" /> Aggiungi
          </button>
        )}
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────
// Memoized: the board re-renders every 4s as the live-usage ticker rebuilds
// `liveById`. Without memo every card re-renders on each tick; with it only the
// cards whose `live` prop actually changed (the working ones) do. All handler
// props from the parent (onOpen/onError/onRefetch/onOpenTopic) are stable
// (useCallback / state setters), and task/parentTitle come from tasks-keyed
// memos, so the shallow prop compare holds for idle cards.
export const Card = memo(function Card({ task, onOpen, showProject, error, onError, onRefetch, onOpenTopic, sessionState = 'unknown', parentTitle, projectPath, live, awaiting, justMovedTo, justCreated, archived = false }: {
  task: BoardTask; onOpen: OpenTask; showProject: boolean;
  /** Il perché l'ultimo click non ha fatto niente, disegnato SULLA card (in coda,
   *  sotto le sue scelte): la barra in cima al board sta a colonne di distanza,
   *  spesso fuori dal viewport, e da lassù un `approve` rifiutato sembrava un
   *  bottone morto. `null` = nessun errore su questa card. */
  error?: string | null;
  /** Riporta l'esito di un'azione della card: un messaggio la mostra, `null` la
   *  pulisce. L'id viaggia nella chiamata perché l'handler sia lo STESSO per
   *  tutte le card (identità stabile, memo intatto). */
  onError: (taskId: string, message: string | null) => void;
  onRefetch: () => void; onOpenTopic?: (topicId: string) => void;
  /** Stato della SESSIONE dell'agente (non della scheda): vedi `lib/taskSession.ts`. */
  sessionState?: TaskSessionState;
  /** Text of the parent task when this card is a subtask (context chip). */
  parentTitle?: string;
  /** Real filesystem path of task.projectId, for the favicon (cross-project board only). */
  projectPath?: string;
  /** Il turno e' vivo ma fermo su una PERSONA: pannello di domanda o permesso
   *  aperti a meta' turno. Transitorio, non e' in DB. */
  awaiting?: boolean;
  /** Live per-turn usage while this task's agent works (ticking chip). */
  live?: LiveUsage;
  /** La card è appena arrivata in QUESTA colonna: lampo del colore della
   *  colonna, si spegne da solo. */
  justMovedTo?: TaskStatus;
  /** La card è appena stata CREATA: lampo azzurro, si spegne da solo. */
  justCreated?: boolean;
  /** La card viene dall'ARCHIVIO (vista `?archived=1`): il gesto in coda al
   *  menu non è più archiviare — è già archiviata — ma riportarla indietro. */
  archived?: boolean;
}) {
  // Sortable: the source card is dimmed (the DragOverlay carries the visual)
  // but its NEIGHBOURS get the reflow transform — the list opens a gap under
  // the pointer, so dropping "between two cards" reads as such. The ACTIVE
  // card must NOT get its transform (that one follows the pointer): applied,
  // the dim source card flew across the board alongside the overlay and the
  // drop targeting went with it.
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({ id: task.id });

  // Review context, lazily loaded from the task detail (one GET, two uses):
  // for an agent-driven task the comment PAIR (`selectCardComments`) — the
  // thread's last word as a quick-reply with option buttons when it's a
  // question block and plain text otherwise, plus the human request it answers
  // (the human must never be asked Approva/Rimanda indietro blind, nor read an answer
  // whose question is off the card); for ANY review card with steps the direct
  // CHILDREN, expanded on the card as the delivery checklist. Subtasks never
  // ride the board feed (rootsOnly), so the card fetches them itself.
  const [thread, setThread] = useState<CardComments | null>(null);
  const [children, setChildren] = useState<BoardTask[]>([]);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  // Il commento libero è l'ULTIMA opzione, non l'unica: «Rifai così…» ci porta
  // il cursore invece di agire (è l'unica scelta che senza una riga non dice
  // niente all'agente).
  const freeTextRef = useRef<HTMLInputElement>(null);
  // Right-click menu (archive/select live here now — NOT as a trash icon that
  // crowds the card header). Cursor-positioned, portaled, viewport-clamped.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Il menu della tessera si apriva SOLO col tasto destro: sulla board da
  // telefono era irraggiungibile. `openContextMenuAt` apre lo stesso menu, non
  // un secondo. NB: la board monta un `DndContext` con `TouchSensor` a 200ms
  // (KanbanBoardPane), quindi qui i due gesti convivono — il sensore rivendica
  // il tocco solo se il dito si MUOVE oltre la tolleranza, mentre il long-press
  // scatta a 500ms su un dito fermo.
  const { isTouch } = useMobile();
  const cardLongPress = useLongPress(openContextMenuAt, { enabled: isTouch });
  const confirm = useConfirm();
  const tr = useT();
  // The context menu offers two of the same actions as the button row (stop,
  // archive): the words come from the same table, or the card goes back to
  // calling them two different things depending on where you press.
  const stopWord = taskActionWord('stop', tr);
  const dropWord = taskActionWord('drop', tr);
  // Stessa tavola dell'«Archivia» che sostituisce: una porta e il suo ritorno
  // non possono chiamarsi in due sistemi diversi.
  const restoreWord = taskActionWord('restore', tr);
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  // Lo stallo dei sottotask parcheggiati È una domanda, e la fa il SISTEMA: la
  // card può non avere nessun topic legato (il padre era stato rilasciato prima
  // di finire fermo). Senza questa riga la domanda arrivava in review muta — con
  // le due risposte scritte in un commento e nessun bottone per darle.
  const isSystemQuestion = task.status === 'review' && task.deliveredReason === 'parked_children';
  const showsQuestion = isAgentReview || isSystemQuestion;
  const wantDetail = showsQuestion || (task.status === 'review' && task.subtaskCount > 0);
  useEffect(() => {
    if (!wantDetail) { setThread(null); setChildren([]); return; }
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ comments, children: kids }) => {
        if (!alive) return;
        setThread(showsQuestion ? selectCardComments(comments) : null);
        setChildren(kids ?? []);
      })
      .catch(() => { if (alive) { setThread(null); setChildren([]); } });
    return () => { alive = false; };
    // Re-check when the task changes (a re-kick bumps updatedAt).
  }, [wantDetail, showsQuestion, task.projectId, task.id, task.updatedAt]);
  const lastComment = thread?.latest ?? null;
  // Plain text: the context row is a single clamped line, so markdown blocks
  // would only leak their syntax into it.
  const humanContextText = thread?.humanContext ? stripMarkdown(thread.humanContext.content) : '';
  const pending = lastComment ? parseQuestionBlock(lastComment.content) : null;
  // A quick reply whose text IS one of the card's real choices is a trap: the
  // reply rejects the card and restarts the agent with those words, while the
  // button one row below performs the action. Same label, opposite effect.
  // No `surfaceLabels`: in review the card draws no buttons of its own, only
  // `TaskChoiceRow`, which `taskChoices` already knows about. The context menu
  // does not count, it is shut until you open it.
  const replyOptions = useMemo(
    () => (pending ? usableQuestionOptions(task, pending.options, { t: tr }) : []),
    [pending, task, tr],
  );

  // L'esito di un'azione della card torna SULLA card: si pulisce l'errore
  // precedente quando se ne tenta una nuova, altrimenti il messaggio del click
  // di prima resterebbe lì a raccontare un fallimento già superato.
  const fail = (e: unknown, fallback: string) => onError(task.id, taskActionErrorMessage(e, fallback));
  // Il ripiego, quando il server non manda una frase, nomina l'azione con la
  // PAROLA della tabella condivisa: dire «Approva non è riuscito» sotto un
  // bottone che si chiama «Va bene» rimetterebbe due nomi sulla stessa porta.
  const failedWord = (id: Parameters<typeof taskActionWord>[0]) => `${taskActionWord(id, tr).label}: non è riuscito`;
  const clearError = () => onError(task.id, null);
  // Le scelte (`TaskChoiceRow`) passano di qui per la stessa ragione: il loro
  // messaggio arriva già con l'etichetta della voce premuta, e va tradotto e
  // appoggiato su QUESTA card. Un esito buono la ripulisce.
  const choiceFailed = (message: string) => onError(task.id, taskActionErrorMessage(message));
  // Il campo si svuota anche qui: da quando «Rimanda indietro» porta con sé il
  // testo, lasciarlo nella casella dopo un esito buono lo farebbe sembrare mai
  // partito — e al secondo click ripartirebbe due volte.
  const choiceDone = () => { clearError(); setFreeText(''); onRefetch(); };

  // Route mutations by the task's own projectId (works in the global board too).
  const review = async (decision: 'approve' | 'reject', comment?: string) => {
    if (busy) return;
    setBusy(true); clearError();
    try { await boardApi.review(task.projectId, task.id, decision, comment); setThread(null); setFreeText(''); onRefetch(); }
    catch (e) { fail(e, failedWord(decision === 'approve' ? 'accept' : 'send-back')); }
    finally { setBusy(false); }
  };
  // Answering a question re-kicks the same agent tab (server routes reject →
  // dispatcher.resume), so the answer is a reject carrying the human's choice.
  const answer = (text: string) => review('reject', text);
  // Il campo libero della card in review: con un agente dietro è una RISPOSTA
  // (riparte lui); senza, è un commento e basta.
  // Un `reject` chiuderebbe una revisione umana che nessuno ha chiesto di
  // rifiutare.
  //
  // `quiet` è il secondo gesto: la nota si salva sulla card e basta, l'agent
  // non riparte e il task resta in Review. Serve perché finora scrivere qui
  // RIMANDAVA indietro la consegna senza dirlo, e chi voleva solo annotare
  // "verificata" risvegliava un agente su un lavoro finito.
  const replyFree = (opts?: { quiet?: boolean }) => {
    const v = freeText.trim();
    if (!v) return;
    if (isAgentReview && opts?.quiet !== true) void answer(v); else void steer(v, opts);
  };
  const archive = async () => {
    // Archiviare un task con l'agent al lavoro gli taglia il turno (il server lo
    // stacca prima di archiviare, altrimenti resterebbe a girare per nessuno).
    // Il turno non torna indietro, quindi si chiede — ma solo quando c'è
    // davvero un agent da fermare: su una card ferma la domanda sarebbe rumore.
    if (isAgentWorking(task.dispatchState)) {
      const ok = await confirm({
        title: 'Archiviare un task in corso?',
        confirmLabel: 'Archivia e ferma',
        body: <p>Su questo task c&apos;è un agent al lavoro: archiviandolo il suo turno viene interrotto e non riprende.</p>,
      });
      if (!ok) return;
    }
    clearError();
    try { await boardApi.archive(task.projectId, task.id); onRefetch(); }
    catch (e) { fail(e, failedWord('drop')); }
  };
  // Il ritorno dall'archivio. Niente conferma: è il gesto che RIMETTE una card
  // dove stava, e chi si pente riarchivia con lo stesso menu.
  const restore = async () => {
    try { await boardApi.restore(task.projectId, task.id); onRefetch(); }
    catch (e) { fail(e, failedWord('restore')); }
  };
  // «Aspetta» senza buttare via: interrompe il turno e basta. Prima l'unica
  // voce del menu era «Archivia», che su un task vivo chiede «Archivia e
  // ferma» — un gesto solo per due intenzioni, con quella distruttiva
  // obbligatoria per chi voleva solo guardare. Stesso endpoint del bottone nel
  // drawer, quindi stesso esito: il task viene PARCHEGGIATO in Backlog (chip
  // «fermato», non «fallito») e non riparte da solo — chi ferma vuole vedere
  // dove stava andando, non farlo ripartire mentre guarda.
  const stop = async () => {
    if (busy) return;
    setBusy(true); clearError();
    try { await boardApi.stop(task.projectId, task.id); onRefetch(); }
    catch (e) { fail(e, failedWord('stop')); }
    finally { setBusy(false); }
  };
  // Steer a WORKING agent: a comment on an in_progress task is buffered by the
  // dispatcher and handed over at the next turn (Claude-Code style). Same
  // /comments endpoint as the drawer composer — the server routes it to resume().
  const steer = async (text: string, opts?: { quiet?: boolean }) => {
    const v = text.trim();
    if (busy || !v) return;
    setBusy(true); clearError();
    try { await boardApi.comment(task.projectId, task.id, v, { quiet: opts?.quiet }); setFreeText(''); onRefetch(); }
    catch (e) { fail(e, 'Il messaggio non è partito'); }
    finally { setBusy(false); }
  };
  // Human-readable project label = the dirName prefix before the id hash.
  // Project-less = truly unassigned OR the catch-all board (which runs the task
  // standalone). Both render with NO chip — the "generale" label is noise.
  const unassigned = isProjectlessId(task.projectId);
  const projectLabel = task.projectId.replace(/-[^-]+$/, '');
  // A task in review is the APPROVAL surface, never the "steer a working agent"
  // surface — so it's never busy here even if a stale dispatch_state='working'
  // lingers. Without this gate a review task with dispatch_state='working'
  // renders BOTH the steer input and the review feedback input (two boxes).
  const agentBusy = task.status !== 'review' && isAgentWorking(task.dispatchState);
  // Agent cluster in the card's top-right slot: dispatch state + model/effort +
  // "apri la sessione" all live up there — the body below stays pure content.
  //
  // Il gesto e la SCHEDA sono due cose diverse (il click nudo sulla card apre la
  // scheda), quindi qui si offre solo ciò che esiste davvero: la sessione viva
  // si apre, la sessione finita si DICE e non si apre. Vedi `lib/taskSession.ts`.
  const canOpenSession = !!onOpenTopic && canOpenTaskSession(sessionState);
  const sessionEnded = shouldExplainMissingSession(sessionState);
  // Always shown: the eyebrow row carries the click-to-copy task id on every card
  // (plus project/state/model/tab when present).
  const showTopRow = true;
  const showPriority = !task.priorityAuto && task.priority !== 2;
  // Review expands the subtask checklist on the card; elsewhere the count chip suffices.
  const checklist = task.status === 'review' ? children : [];
  // "done" that never reached main — the 19/07 loss, made visible. Il predicato
  // sta in `shared/board`: la stessa pastiglia la disegnano la banda del drawer e
  // il contatore accanto a «Pubblica», e le tre copie divergevano.
  const notLanded = showsLandingDebt(task);
  // Il ramo come si legge su una card: senza il prefisso `topics/`, che ce
  // l'hanno tutti e occupa sette caratteri dei pochi che il chip ha. Con il
  // prefisso il troncamento mangiava proprio la parte che distingue un ramo
  // dall'altro (`topics/spectral-fo…`), cioè l'unica informazione nuova. Il
  // nome intero resta nel `title` e nel drawer.
  const notLandedBranch = task.deliveryBranch?.replace(/^topics\//, '') ?? null;
  // Solo il ROSSO va sulla card: un verde è la norma e riempirebbe la colonna di
  // spunte che nessuno legge, mentre il rosso è la ragione per non aprire il task.
  const checksRed = task.checksState === 'fail';
  // Solo in Review: lì la domanda è "cosa guardo?", e la risposta cambia se
  // nessun agent ha detto "fatto". Su una card done sarebbe archeologia (il
  // drawer la conserva comunque). La regola sta in `lib/board.ts` come le altre
  // due qui sotto: dentro il JSX nessun test unitario la raggiungeva.
  const systemDelivered = systemDeliveryChip(task);
  // Il legame, non la lista: il chip nasce da `blockedByTaskId` + il bloccante
  // risolto dal server, così vale anche quando il bloccante non è fra i task
  // fetchati (sottotask, altro progetto, archiviato).
  const blockedChip = blockedByChip(task);
  // «Riaperta»: la card ERA in Done e non c'è più. Il fatto vive sulla card
  // (l'API lo dice), non solo nel thread — dalla colonna si vedeva solo il buco.
  const reopened = reopenedChip(task);
  // Quale famiglia di scelte disegna questa card (una sola, vedi taskChoices).
  const choiceState = taskChoiceState(task);
  // …e l'altra metà, che è il verso OPPOSTO: quanti aspettano QUESTA card.
  // Anche questo numero è un fatto del DB, non della lista fetchata — un
  // dipendente che è un sottotask o sta in un altro progetto non è fra le card,
  // ma aspetta lo stesso. Le due frasi non condividono una parola: vedi il
  // blocco «i due versi dell'attesa» in lib/board.ts.
  const waitingOnThis = waitingOnThisChip(task);
  const hasMetaRow = !!(blockedChip || reopened || waitingOnThis || task.parentTaskId || task.userCommentCount > 0 || task.planFirst || task.assignedTo || notLanded || checksRed || systemDelivered || task.labels.length);

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      data-task-card={task.id}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      {...cardLongPress.handlers}
      data-pressing={cardLongPress.pressed || undefined}
      // «Tieni premuto» = lo STESSO menu del tasto destro. Il gesto e' lo
      // standard dell'app: `openContextMenuAt` sintetizza un `contextmenu`
      // nativo che bolla fino all'`onContextMenu` qui accanto, quindi non
      // esiste un secondo menu da tenere allineato — e' lo stesso.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
      // Gli attributi sono il gancio dei test (e del debug a occhio): dicono
      // COSA è successo, la classe dice come si dipinge. `data-just-done` resta
      // il caso che le spec guardano da sempre, ed è ora un caso particolare di
      // `data-just-moved`, non un meccanismo a parte.
      data-just-moved={justMovedTo}
      data-just-done={justMovedTo === 'done' || undefined}
      data-just-created={justCreated || undefined}
      // I due lampi sono UNA scelta, non due classi che si sommano: `animation`
      // è una proprietà sola, quindi la seconda vincerebbe per ordine di
      // dichiarazione in index.css invece che per quello che è successo alla
      // card. Lo spostamento batte la nascita — nascere è l'evento più debole
      // dei due, e una card che nasce non ha attraversato nessun confine.
      className={`group cursor-grab rounded-md border border-app-border bg-surface p-2.5 text-sm text-app-text shadow-sm hover:border-app-border-light ${isDragging ? 'opacity-40' : ''} ${justMovedTo ? `task-flash task-flash-${justMovedTo}` : justCreated ? 'task-flash task-flash-created' : ''}`}
    >
      {/* Top row: project eyebrow (cross-project) on the LEFT; the AGENT
          cluster in the top-right SLOT — dispatch state, model/effort, "apri
          tab". Everything about "who's on this and where" lives up here, so
          the body below is pure content. flex-wrap + justify-end: on a narrow
          card extra chips drop to a second right-aligned line instead of
          crushing the eyebrow. */}
      {showTopRow && (
        <div className="mb-1 flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-xs md:text-[11px] text-app-text-secondary">
            {showProject && !unassigned && (
              <>
                {projectPath && <ProjectFavicon path={projectPath} size={12} className="shrink-0" />}
                <span className="min-w-0 truncate font-medium">{projectLabel}</span>
              </>
            )}
            <TaskIdChip id={task.id} />
          </div>
          {/* The live chip's pulse dot already says "working": while it ticks,
              the 'al lavoro' state chip is redundant — one chip, not two. */}
          {awaiting ? (
            // Vince su tutto il resto mentre dura: un turno fermo su di te non e'
            // «al lavoro», e mostrarlo come tale e' la bugia che questo chip
            // esiste per togliere.
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-500/15 text-rose-300"
              // Per RISPONDERE serve la sessione, non la scheda: il testo diceva
              // «il tab del task», che è l'altra superficie e non ha un campo
              // dove rispondere a un turno vivo.
              title="Il turno e' vivo ma aspetta te: apri la sessione dell'agente per rispondere"
            >aspetta te</span>
          ) : (live && task.dispatchState === 'working') ? null : task.queueReason ? (
            // Una card ferma in Todo dice PERCHÉ, e la ragione arriva già
            // scritta dal server. Vince sul chip di stato («in coda», «in
            // attesa»): sono la stessa informazione, ma quella è una parola
            // sola e uguale per sei motivi diversi.
            <QueueReasonChip reason={task.queueReason} />
          ) : (task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
            <DispatchChip state={task.dispatchState} error={task.dispatchError} />
          ) : (!task.dispatchState && task.dispatchError) ? (
            <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300" title={task.dispatchError}>fermato</span>
          ) : null}
          {live && task.dispatchState === 'working' ? (
            <LiveEffortChip usage={live} />
          ) : (task.model || task.agentMs > 0 || task.agentTokens > 0) ? (
            // The model always lives here, in the time/effort chip — never as a
            // second standalone chip. Before the agent has logged any time we
            // show just the model; once it runs we prepend it to the ⏱ effort,
            // matching the live chip (`Opus · ⏱ 2m · 1.2k tok`).
            <span
              title={(task.agentMs > 0 || task.agentTokens > 0)
                ? `Effort dell'agent: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''} · modello ${fmtModel(task.model)}`
                : `Modello: ${fmtModel(task.model)}`}
              className="shrink-0 whitespace-nowrap rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-secondary"
            >{fmtModel(task.model)}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)}` : ''}`}</span>
          ) : null}
          {canOpenSession && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenTopic!(task.assignedTopicId!); }}
              data-testid="card-open-session"
              className="shrink-0 rounded bg-white/10 p-1 text-app-text hover:bg-white/20"
              title="Apri la sessione dell'agente: la chat dove sta lavorando (chiuderla NON la ferma)"
            ><MessageSquare className="h-3 w-3" /></button>
          )}
          {/* La sessione c'era e non c'è più. Non si nasconde e non si apre il
              vuoto: si dice, spento, così il gesto mancante ha una ragione. */}
          {sessionEnded && (
            <span
              data-testid="card-session-gone"
              className="shrink-0 rounded bg-white/5 p-1 text-app-text-faint"
              title="L'agente non è più vivo: la sua sessione non esiste più. Quello che ha fatto resta qui, sulla scheda."
            ><MessageSquare className="h-3 w-3" /></span>
          )}
        </div>
      )}
      {/* Anteprima della consegna: screenshot (previewImage, allowlist media)
          reso come thumbnail sopra il titolo — la review parte guardando la
          cosa. Il click passa alla card (apre il drawer). object-top: di un
          full-page si vede la testata, non un centro anonimo. */}
      {task.previewImage && (
        <PreviewMedia
          path={task.previewImage}
          variant="card"
          // Il click nudo sulla card apre il drawer sul Thread; questo apre lo
          // stesso task con l'anteprima GIÀ in primo piano come tab.
          onOpenTab={() => onOpen(task.id, mediaPaneIdFor(task.previewImage!))}
        />
      )}
      {/* Title — full width; the priority rides INLINE before the text (only
          when hand-set and non-default), so urgency reads in the same glance
          as the title instead of down in a chip row. */}
      <span className="block break-words leading-snug">
        {showPriority && (
          <span
            title={`Priorità: ${PRIORITY_LABEL[task.priority] ?? task.priority}`}
            className={`mr-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-middle text-xs md:text-[10px] ${
              task.priority >= 3 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-app-text-secondary'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
            {PRIORITY_LABEL[task.priority] ?? task.priority}
          </span>
        )}
        {task.text}
      </span>
      {/* Subtasks, straight under the title. In Review the checklist EXPANDS —
          the human is judging a delivery and the steps are the evidence: max 5
          rows, the rest behind "Vedi tutti" (opens the drawer tree). The other
          columns keep the compact done/total chip. */}
      {checklist.length > 0 ? (
        <div className="mt-1 space-y-0.5" onClick={(e) => e.stopPropagation()}>
          {checklist.slice(0, 5).map((s) => {
            // L'unico posto in cui un sottotask si vede sulla BOARD: le colonne
            // mostrano solo le radici (`rootsOnly`), la checklist si apre sulla
            // card in Review. Ed è il momento giusto per dirlo — è lì che si
            // decide se approvare, e uno step «in corso» che non sta lavorando
            // nessuno è esattamente ciò che tiene aperto il task.
            const work = subtaskWorkChip(s);
            return (
            <button
              key={s.id}
              onClick={() => onOpen(s.id)}
              title={`${STATUS_LABEL[s.status]} · apri il sottotask`}
              className="flex w-full items-center gap-1.5 rounded px-0.5 text-left hover:bg-white/5"
            >
              <StatusIcon status={s.status} />
              <span className={`min-w-0 flex-1 truncate text-xs ${s.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-heading'}`}>{s.text}</span>
              {work && (work.kind === 'unattended' ? (
                <span
                  data-testid={`card-subtask-work-${s.id}`}
                  data-kind="unattended"
                  title={work.title}
                  className="flex shrink-0 items-center gap-1 rounded bg-rose-500/20 px-1 py-0.5 text-[10px] text-rose-300"
                ><AlertTriangle className="h-2.5 w-2.5 shrink-0" /> {work.label}</span>
              ) : (
                <span
                  data-testid={`card-subtask-work-${s.id}`}
                  data-kind="parent-turn"
                  title={work.title}
                  className="flex shrink-0 text-app-text-muted"
                ><UserRound className="h-2.5 w-2.5" /></span>
              ))}
            </button>
            );
          })}
          {checklist.length > 5 && (
            <button
              onClick={() => onOpen(task.id)}
              title="Apri la scheda del task: la checklist per intero"
              className="px-0.5 text-xs md:text-[11px] text-app-text-secondary hover:text-app-text"
            >+{checklist.length - 5}… Vedi tutti</button>
          )}
        </div>
      ) : task.subtaskCount > 0 ? (
        <div className="mt-1">
          <span
            title={`${task.subtaskDoneCount}/${task.subtaskCount} sottotask completati`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
          >↳ {task.subtaskDoneCount}/{task.subtaskCount}</span>
        </div>
      ) : null}
      {/* Description preview — plain text, clamped (the full markdown lives in
          the drawer). The update time closes the body — but on an agent review
          card the agent's LAST COMMENT is the true tail, so the date renders
          after that (inside the review block) instead of here. */}
      {task.description && (
        <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-app-text-secondary">{stripMarkdown(task.description)}</p>
      )}
      {!isAgentReview && (
        <div
          className="mt-1 text-xs md:text-[10px] text-app-text-muted"
          title={`Ultimo aggiornamento: ${new Date(task.updatedAt).toLocaleString('it-IT')}`}
        >{fmtUpdatedAt(task.updatedAt)}</div>
      )}
      {/* Relational chips (blocker / parent / thread / plan / assignee): the
          row renders only when at least one is present. */}
      {hasMetaRow && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {/* PRIMO della riga, e non per gravità: è l'unico chip che cambia la
              DECISIONE. Gli altri dicono in che rapporti sta la card (aspetta,
              la aspettano, ha un padre); questo dice che sotto può non esserci
              niente da approvare, e va letto prima di guardare i bottoni.
              L'icona non è la clessidra di «N la aspettano»: due fatti diversi
              con lo stesso glifo si leggono come lo stesso fatto. */}
          {systemDelivered && (
            <span
              data-testid="card-system-delivered"
              title={systemDelivered.title}
              className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><CircleSlash className="h-3 w-3 shrink-0" /> {systemDelivered.label}</span>
          )}
          {blockedChip && (
            <span
              data-testid="card-blocked-by"
              title={blockedChip.title}
              className="flex max-w-[11rem] items-center gap-1 truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><Lock className="h-3 w-3 shrink-0" /> <span className="truncate">{blockedChip.label}</span></span>
          )}
          {reopened && (
            <span
              data-testid="card-reopened"
              title={reopened.title}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><RotateCcw className="h-3 w-3 shrink-0" /> {reopened.label}</span>
          )}
          {waitingOnThis && (
            <span
              data-testid="card-waiting-on-this"
              title={waitingOnThis.title}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><Hourglass className="h-3 w-3 shrink-0" /> {waitingOnThis.label}</span>
          )}
          {task.parentTaskId && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpen(task.parentTaskId!); }}
              title={parentTitle ? `Apri la scheda del padre: ${parentTitle}` : 'Apri la scheda del task padre'}
              className="max-w-[9rem] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300 hover:bg-violet-500/25"
            >⤴ {parentTitle ?? 'padre'}</button>
          )}
          {task.userCommentCount > 0 && (
            <span
              title={`${task.userCommentCount} ${task.userCommentCount === 1 ? 'tuo messaggio' : 'tuoi messaggi'} nel thread (esclusa l'AI)`}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
            ><MessageSquare className="h-3 w-3 shrink-0" /> {task.userCommentCount}</span>
          )}
          {notLanded && (
            <span
              data-testid="card-not-landed"
              title={`Il lavoro consegnato (${task.deliveryCommit?.slice(0, 8) ?? '?'}${task.deliveryBranch ? ` su ${task.deliveryBranch}` : ''}) NON risulta su main. Apri il task per landarlo prima che il branch venga potato.`}
              className="flex max-w-full items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
              // Il RAMO sta nel testo, non solo nel `title`: su touch l'hover non
              // esiste, e senza il nome la card dice che c'è un problema ma non
              // dove sta il lavoro. `max-w-full` più il `flex-wrap` della riga:
              // il chip prende la sua riga invece di comprimere il nome, e
              // `truncate` resta solo per il caso estremo (nome intero nel DOM
              // e nel tooltip, colonna che non si allarga mai).
            ><AlertTriangle className="h-3 w-3 shrink-0" /> <span className="truncate">non su main{notLandedBranch ? ` · ${notLandedBranch}` : ''}</span></span>
          )}
          {checksRed && (
            <span
              title={`Checks pre-review ROSSI: ${(task.checks ?? []).filter((c) => !c.ok).map((c) => c.cmd).join(', ') || 'un comando è fallito'}`}
              className="flex items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
            ><AlertTriangle className="h-3 w-3 shrink-0" /> checks rossi</span>
          )}
          {task.planFirst && (
            <span
              title="L'agent consegna prima un piano da approvare"
              className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300"
            >piano</span>
          )}
          {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading">@{task.assignedTo}</span>}
          {/* Le etichette in coda alla riga: quelle di visibilità dicono CHI
              CHIUDE la card, le altre servono a leggere la board. */}
          {task.labels.map((l) => <LabelChip key={l.label} label={l.label} source={l.source} />)}
          {/* La CONSEGUENZA, detta dove si decide: una card invisibile con la
              barra verde per intero non aspetta Attilio. Solo in review — nelle
              altre colonne non c'è ancora niente da chiudere. */}
          {task.status === 'review' && whoCloses(task.labels.map((l) => l.label), task.checksState) === 'conductor' && (
            <span
              data-testid="card-conductor-closes"
              title="Invisibile e barra verde: questa card la può chiudere il conduttore senza passare da te."
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-emerald-300"
            ><ShieldCheck className="h-3 w-3 shrink-0" /> la chiude il conduttore</span>
          )}
        </div>
      )}
      {/* Steer a WORKING agent right from the card ("anche da kanban"): the
          message is buffered and handed to the agent at the next turn. */}
      {agentBusy && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          {/* UNA riga sola. «Ferma» e «Consegna quello che hai» stavano qui
              sopra come due bottoni pieni: azioni rare, disegnate col peso di
              una decisione, su una card che non chiede niente — sta solo
              lavorando, o aspetta il suo turno. Sono passate nel `⋯`, che è
              l'ultima cosa della riga proprio perché è l'ultima che serve; il
              campo e il suo invio restano attaccati, che è il gesto vero di una
              card in corso.
              Nel drawer restano bottoni (vedi TaskChoiceRow): lì la card la
              stai già guardando apposta. */}
          <div className="flex items-center gap-1">
            <input
              ref={freeTextRef}
              value={freeText} disabled={busy}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); steer(freeText); } }}
              placeholder="…oppure scrivi all'agent"
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => steer(freeText)}
              title="Invia all'agent. Lo riceve al prossimo turno, come Claude Code."
              className="flex shrink-0 items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
            <TaskChoiceMenu
              task={task} disabled={busy} onDone={choiceDone} onError={choiceFailed}
              ariaLabel="Azioni su questo turno"
            />
          </div>
        </div>
      )}
      {/* Bloccata: le scelte sono le uniche due uscite dall'attesa (togliere il
          legame, o toglierlo e farla partire). Senza, la card resta ferma e
          l'unico modo per muoverla è aprire il drawer e cercare il picker. */}
      {choiceState === 'blocked' && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <TaskChoiceRow task={task} disabled={busy} onDone={choiceDone} onError={choiceFailed} />
        </div>
      )}
      {/* OGNI card in review, non solo quelle di un agente. `showsQuestion`
          seleziona chi ha una PAROLA da mostrare (l'agente, o il sistema sui
          figli parcheggiati); le SCELTE invece nascono dallo stato e valgono
          anche per una consegna che nessun agente ha fatto. Tenerle sotto lo
          stesso gate lasciava quella card con la sola casella di testo, che è
          esattamente il difetto che `taskChoices` ha chiuso. */}
      {task.status === 'review' && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {/* The human request the answer below is answering, kept to ONE line.
              On a card that bounced back through review it is the rework note,
              and without it the answer arrives with its question missing. It is
              context, not content: muted, clamped, and quoted only when a real
              reply followed it (`selectCardComments`). No human word, no row:
              nothing empty is ever reserved here. */}
          {showsQuestion && humanContextText && (
            <p
              data-testid="card-human-context"
              className="truncate border-l-2 border-sky-400/40 pl-1.5 text-xs md:text-[11px] leading-relaxed text-app-text-muted"
              title={`La tua richiesta: ${humanContextText}`}
            >{humanContextText}</p>
          )}
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {!showsQuestion ? null : pending ? (
            <p className="break-words text-xs leading-snug text-app-text">{stripMarkdown(pending.question)}</p>
          ) : lastComment ? (
            // Render the agent's last word as REAL markdown (bold/headings/lists
            // format instead of showing raw `**`/`#`). Shown in full — no clamp,
            // no fade. Tooltip = plain text.
            //
            // The name in front of the colon is DERIVED, never the stored
            // author. Rows written before 13/08/2026 carry the topic name there,
            // which for a dispatched agent is the task title cut at 60
            // characters, so this tooltip used to open with half a word.
            <div
              className={`text-xs leading-relaxed text-app-text-heading ${COMPACT_MD_CLS}`}
              title={`${commentAuthorLabel(lastComment.author).label}: ${stripMarkdown(lastComment.content)}`}
            >
              <ChatMarkdown components={{}}>{lastComment.content}</ChatMarkdown>
            </div>
          ) : null}
          {/* Update time trails the agent's last word (the card body's true tail). */}
          <div
            className="text-xs md:text-[10px] text-app-text-muted"
            title={`Ultimo aggiornamento: ${new Date(task.updatedAt).toLocaleString('it-IT')}`}
          >{fmtUpdatedAt(task.updatedAt)}</div>
          {replyOptions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {replyOptions.map((opt, i) => (
                <button
                  key={i} disabled={busy}
                  onClick={() => answer(opt)}
                  className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
                >{opt}</button>
              ))}
            </div>
          )}
          {/* Le scelte della card: ci sono SEMPRE, anche quando l'agente non ha
              proposto niente. Nascono dallo stato (ramo consegnato o no), e sono
              le stesse azioni dei bottoni che stavano qui — dette per nome
              invece che come due icone ✓/✗. Il campo libero resta sotto. */}
          {/* `pendingText`: quello che hai già battuto qui sotto viaggia con
              «Rimanda indietro». Prima restava nella casella e l'agente
              ripartiva senza indicazione — stesso difetto del drawer, stessa
              riga di codice che lo causava (`review(reject)` senza commento). */}
          <TaskChoiceRow
            task={task} disabled={busy}
            onDone={choiceDone} onError={choiceFailed}
            onNeedText={() => freeTextRef.current?.focus()}
            pendingText={() => freeText}
          />
          <div className="flex items-center gap-1">
            <input
              ref={freeTextRef}
              value={freeText} disabled={busy}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); replyFree(); } }}
              placeholder={isAgentReview ? tr('board.task.replyPlaceholderShort') : '…oppure commenta'}
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
            />
            {/* DUE GESTI, DUE BOTTONI, e ognuno si chiama come il suo effetto.
                Qui lo spazio è quello che è, quindi le etichette sono corte:
                ma restano PAROLE, perché il bottone unico diceva «Commenta» e
                RIMANDAVA la consegna all'agent, e nessuna icona lo diceva. */}
            <button
              disabled={busy || !freeText.trim()} onClick={() => replyFree()}
              title={isAgentReview ? tr('board.task.sendBackReplyTitle') : 'Commenta'}
              data-testid="card-reply-send-back"
              className="flex items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" />{isAgentReview && <span>{tr('board.task.sendBackReply')}</span>}</button>
            {isAgentReview && (
              <button
                disabled={busy || !freeText.trim()} onClick={() => replyFree({ quiet: true })}
                title={tr('board.task.quietNoteTitle')}
                data-testid="card-reply-quiet-note"
                className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
              ><StickyNote className="h-3.5 w-3.5" /><span>{tr('board.task.quietNote')}</span></button>
            )}
          </div>
        </div>
      )}
      {/* Il perché il click non ha fatto niente, ATTACCATO al bottone che l'ha
          preso: ultima riga della card, subito sotto le sue scelte. Prima
          l'unico posto dove finiva era la barra rossa in cima al board, che con
          la colonna scrollata è fuori dallo schermo: il caso vero è «Approva»
          su un padre con sottotask aperti, e da lassù sembrava un bottone
          morto. La checklist dei figli è già disegnata sopra, quindi qui basta
          la frase: il rimedio si vede senza aprire niente. */}
      {error && (
        <div
          data-testid="card-action-error"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs leading-snug text-rose-300"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            aria-label="Chiudi l'errore"
            onClick={clearError}
            className="shrink-0 rounded p-0.5 hover:bg-white/10"
          ><X className="h-3 w-3" /></button>
        </div>
      )}
      {ctxMenu && (
        <ContextMenuPortal open x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpen(task.id); }}
            className={POPOVER_ITEM}
            // «Apri» da solo non diceva QUALE delle due superfici: questa è la
            // scheda, l'altra voce qui sotto è la sessione.
            title="Apri la scheda del task: descrizione, checklist, consegna, thread"
          ><ClipboardList className="h-3.5 w-3.5 text-app-text-secondary" /> Apri la scheda</button>
          {/* Stesso testo che copia il bottone del drawer (`taskCopyText`):
              titolo + descrizione. Qui è a portata di tasto destro perché il
              gesto — «prendo questo task e lo incollo altrove» — parte quasi
              sempre dalla card, senza aprire niente. */}
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); void copyText(taskCopyText(task)); }}
            className={POPOVER_ITEM}
          ><Copy className="h-3.5 w-3.5 text-app-text-secondary" /> Copia task</button>
          {canOpenSession && (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpenTopic!(task.assignedTopicId!); }}
              className={POPOVER_ITEM}
              title="Apri la sessione dell'agente: la chat dove sta lavorando (chiuderla NON la ferma)"
            ><MessageSquare className="h-3.5 w-3.5 text-app-text-secondary" /> Apri la sessione</button>
          )}
          {sessionEnded && (
            <span
              className={`${POPOVER_ITEM} cursor-default text-app-text-faint`}
              title="L'agente non è più vivo: la sua sessione non esiste più. Quello che ha fatto resta qui, sulla scheda."
            ><MessageSquare className="h-3.5 w-3.5" /> Sessione finita</span>
          )}
          {/* Solo quando c'è davvero un turno da tagliare: su una card ferma la
              voce sarebbe un bottone che risponde 409. `agentBusy` è la stessa
              domanda che accende il bottone «Ferma» del drawer, così le due
              superfici compaiono e spariscono insieme. */}
          {agentBusy && (
            <>
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem"
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); setCtxMenu(null); stop(); }}
                title={stopWord.title}
                className={POPOVER_ITEM}
              ><Square className="h-3.5 w-3.5 fill-current text-rose-400" /> {stopWord.label}</button>
            </>
          )}
          <div className={POPOVER_DIVIDER} />
          {archived ? (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); restore(); }}
              title={restoreWord.title}
              className={POPOVER_ITEM}
            ><ArchiveRestore className="h-3.5 w-3.5 text-app-text-secondary" /> {restoreWord.label}</button>
          ) : (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); archive(); }}
              title={dropWord.title}
              className={POPOVER_ITEM_DANGER}
            ><Trash2 className="h-3.5 w-3.5" /> {dropWord.label}</button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
});

/**
 * Live effort chip shown while a turn runs: model · execution-time · tokens,
 * ticking every second. The time is EXECUTION-ONLY: `baseMs` is the agent_ms
 * accumulated over PRIOR turns and we add only (now − turnStartedAt) for the
 * current turn — never the idle/queued/asleep gaps between turns (the server
 * anchors turnStartedAt at the actual turn start). Falls back to the static
 * agent_ms/agent_tokens chip the instant the turn ends.
 */
export function LiveEffortChip({ usage }: { usage: LiveUsage }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live effort chip: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = usage.baseMs + Math.max(0, Date.now() - usage.turnStartedAt);
  return (
    <span
      title={`In esecuzione · modello ${fmtModel(usage.model)}, ${fmtLive(ms)} di lavoro${usage.liveTokens ? `, ${usage.liveTokens.toLocaleString('it-IT')} token` : ''} (aggiornamento live)`}
      className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-sky-300 tabular-nums"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      {fmtModel(usage.model)} · ⏱ {fmtLive(ms)}{usage.liveTokens > 0 && ` · ${fmtTok(usage.liveTokens)}`}
    </span>
  );
}
