import { contextTokens, costTokens, partsFromTask } from '../../../../shared/token-cost';
import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reviewEvidence } from '../../lib/reviewEvidence';
import { AlertTriangle, ArchiveRestore, ArrowRightLeft, CircleSlash, ClipboardList, Copy, Cpu, GitBranch, Hourglass, Lock, MessageSquare, Plus, RotateCcw, Send, ShieldCheck, Square, Trash2, UserRound, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useToast } from '../Shared/Toast';
import { questionToProse } from '../../../../shared/question-prose';
import { isSettledParkedQuestion } from '../../../../shared/parked-question';
import { STATUS_LABEL, blockedByChip, boardApi, commentAuthorLabel, isAgentWorking, isProjectlessId, nothingDeliveredWins, parseQuestionBlock, reopenedChip, showsLandingDebt, subtaskWorkChip, systemDeliveryChip, waitingOnThisChip, whoCloses, type BoardTask, type TaskStatus, priorityAwaitingAgent } from '../../lib/board';
import { columnSlice, COLUMN_PAGE } from '../../lib/boardOrder';
import { cardCommentsFromRow, cardDetailNeed, isMachineVoice, selectCardComments, showsCardThread, type CardComments } from './cardComments';
import { useConfirm } from '../../hooks/useConfirm';
import { useLongPress, openContextMenuAt, type LongPressTarget } from '../../hooks/useLongPress';
import { useMobile } from '../../hooks/useMobile';
import { releaseTouchDrag } from './dndSensors';
import { MorphText } from '../Shared/MorphText';
import { PreviewMedia } from './PreviewMedia';
import type { DraftPreview } from './draftPreview';
import { DraftCard } from './DraftCard';
import { DeliveryFiles } from './DeliveryFiles';
import { isDeliverySheetPath } from '../../../../shared/media-kind';
import { TaskChoiceMenu, TaskChoiceRow } from './TaskChoiceRow';
import { LandingNotice } from './LandingNotice';
import { landingBand } from './landingBand';
import { useLandingTicket } from './useLandingTicket';
import { taskActionErrorMessage } from './taskActionError';
import { choiceForText, taskChoices, usableQuestionOptions } from './taskChoices';
import { taskChoiceState } from './taskChoices';
import { showsStoppedChip } from './stoppedChip';
import { sendBackDest, sendBackWord, taskActionWord } from './taskActionWords';
import { useT, useLocale } from '../../hooks/useT';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { PRIORITY_DOT, PRIORITY_LABEL, DISPATCH_CHIP, COMPACT_MD_CLS, COMMENTO_PIEGA_CHARS, RICHIESTA_PIEGA_CHARS, mediaPaneIdFor, type LiveUsage, type OpenTask } from './constants';
import { copyText } from '../../lib/clipboard';
import { canOpenTaskSession, shouldExplainMissingSession, type TaskSessionState } from '../../lib/taskSession';
import { fmtMs, fmtTok, fmtModel, fmtUpdatedAt, fmtAttesa, fmtUsd, taskCopyText } from './format';
import { StatusIcon, DispatchChip, QueueReasonChip, TaskIdChip, LabelChip } from './atoms';
import { LiveEffortChip, LiveToolLine, RETRY_NOW_MESSAGE, RetryWaitChip } from './CardLive';
import { taskHasWork, uncommittedChipCount } from './chipKey';
import { POPOVER_DIVIDER, POPOVER_ITEM, POPOVER_ITEM_DANGER } from '@/lib/popoverStyles';

// ── Column ────────────────────────────────────────────────────────────────
export function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, cardError, onCardError, onRefetch, onOpenTopic, resolveSession, tasksById, projectPathById, liveById, awaitingHuman, justMoved, justCreated, archived = false, draft }: {
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
  /** The card the floating composer is about to create HERE: drawn as a ghost
   *  at the top of the column while it is being written (see `DraftCard`). */
  draft?: DraftPreview;
}) {
  const tr = useT();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };
  // QUANTE card si disegnano. La regola (e il perché vale solo su Review e Done)
  // sta in `columnSlice`; qui c'è solo la memoria di quante ne hai chieste.
  const [shown, setShown] = useState(COLUMN_PAGE);
  const slice = useMemo(() => columnSlice(status, tasks, shown), [status, tasks, shown]);
  // Stable identity across the board's 4s live-usage tick: SortableContext gets a
  // fresh array only when the task set actually changes, not every render. Gli id
  // sono quelli DISEGNATI: un id senza nodo nel registro di dnd-kit è un
  // bersaglio che non esiste.
  const itemIds = useMemo(() => slice.rows.map((t) => t.id), [slice]);

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
  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-column-${status}`}
      // DOVE CADRÀ: `into`, perché la card entra DENTRO questa colonna. Il verde
      // scritto a mano era il disegno di questo file soltanto, mentre lo stesso
      // rilascio nel resto dell'app si dipinge con la regola unica di
      // `index.css` (vedi DROP_ACTIVE_ATTR in `lib/dragPreview`): la board
      // diceva «qui» in un colore che nessun'altra superficie usava.
      data-drop-active={isOver ? 'into' : undefined}
      className={`flex ${widthCls} shrink-0 flex-col rounded-lg border border-app-border bg-white/5 ${snapCls}`}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-app-text-heading">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        {/* Il TOTALE della colonna, non quante card se ne disegnano: sfogliare
            Done non deve accorciarne la storia. La testid esiste perché il
            numero è il solo posto in cui i due valori si potrebbero confondere. */}
        <span data-testid={`kanban-column-count-${status}`} className="rounded bg-white/10 px-1.5 text-xs text-app-text-secondary">{tasks.length}</span>
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
        {/* THE GHOST OF THE CARD BEING WRITTEN, in the column it will land in
            and at the top, where a new card lands. Outside the sortable list:
            it is not a card yet and nothing can drag it. */}
        {draft && <DraftCard draft={draft} />}
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {slice.rows.map((t) => (
            <Card
              key={t.id} task={t} onOpen={onOpen} showProject={showProject} onRefetch={onRefetch} onOpenTopic={onOpenTopic}
              error={cardError?.taskId === t.id ? cardError.message : null}
              onError={onCardError}
              sessionState={resolveSession?.(t.assignedTopicId) ?? 'unknown'}
              parentTitle={t.parentTaskId ? tasksById.get(t.parentTaskId)?.text : undefined}
              projectPath={projectPathById.get(t.projectId)}
              live={liveById.get(t.id)}
              // The live event OR the thread: the first dies with the process, the
              // second does not, and an unanswered question survives a restart.
              awaiting={awaitingHuman.has(t.id) || !!t.awaitingAnswer}
              justMovedTo={justMoved.get(t.id)}
              justCreated={justCreated.has(t.id)}
              archived={archived}
            />
          ))}
        </SortableContext>
        {/* La coda della colonna: quante card ci sono ancora e il gesto per
            tirarne su un'altra pagina. Si dice il numero perché una colonna
            tagliata in silenzio è una colonna che sembra vuota di storia. */}
        {slice.hidden > 0 && (
          <button
            onClick={() => setShown((n) => n + COLUMN_PAGE)}
            data-testid={`kanban-column-more-${status}`}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-app-border px-2 py-1.5 text-xs text-app-text-secondary hover:bg-white/5"
          >
            {tr('board.column.showMore', { n: Math.min(slice.hidden, COLUMN_PAGE), left: slice.hidden })}
          </button>
        )}
        {!canCreate ? null : adding ? (
          <div className="rounded-md border border-app-border bg-white/5 p-2">
            <textarea
              autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setText(''); setAdding(false); } }}
              className="w-full resize-none bg-transparent text-sm text-app-text outline-none" rows={2} placeholder={tr('board.column.newTaskPlaceholder')}
            />
            <div className="mt-1 flex justify-end gap-1">
              <button onClick={() => { setText(''); setAdding(false); }} className="rounded px-2 py-0.5 text-xs text-app-text-secondary hover:bg-white/10">{tr('board.column.cancel')}</button>
              <button onClick={submit} className="rounded bg-emerald-500/80 px-2 py-0.5 text-xs text-white hover:bg-emerald-500">{tr('board.column.add')}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-app-text-secondary hover:bg-white/5">
            <Plus className="h-3.5 w-3.5" /> {tr('board.column.add')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The long press on a card: the SAME menu the right button opens, and the
 * finger is the menu's from here on — the drag the board's `TouchSensor`
 * armed on that touch is released first, or it eats the tap on the menu item
 * (see `releaseTouchDrag`). Module-level on purpose: it closes over nothing,
 * so `useLongPress` keeps one callback for the life of the card.
 */
function openCardMenuAt(target: LongPressTarget): void {
  releaseTouchDrag(target.touched);
  openContextMenuAt(target);
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

  // Review context. The comment PAIR (`selectCardComments`) — the thread's last
  // word as a quick-reply with option buttons when it's a question block and
  // plain text otherwise, plus the human request it answers (the human must
  // never be asked Approva/Rimanda indietro blind, nor read an answer whose
  // question is off the card) — RIDES THE LIST: `task.recentComments`. It used
  // to be one full `GET /api/tasks/:id` per review card, and that detail loads
  // the entire thread.
  //
  // What still needs a GET is the direct CHILDREN, which a review card with
  // steps expands as the delivery checklist: subtasks never ride the board feed
  // (rootsOnly). `cardDetailNeed` decides, and it is that function the test
  // executes.
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
  // (KanbanBoardPane), quindi qui i due gesti convivono: vedi
  // `onCardTouchStart`, che e' il punto in cui si spartiscono il dito.
  const { isTouch } = useMobile();
  const cardLongPress = useLongPress(openCardMenuAt, { enabled: isTouch });
  /**
   * THE ONE TOUCH, SHARED BY HAND between the two gestures that want it.
   *
   * `{...listeners}` (dnd-kit's activators) and `{...cardLongPress.handlers}`
   * both carry an `onTouchStart`, and a JSX spread does not merge props: the
   * later one WINS. So the drag activator never reached the DOM, the
   * `PoliteTouchSensor` registered in KanbanBoardPane never saw a finger, and
   * on touch the only sensor left was the mouse one, fed by the click the
   * browser synthesises after `touchend`: a card could not be moved to another
   * column with a finger at all, silently.
   *
   * Composing them is enough because the two gestures exclude each other by
   * MOVEMENT, not by luck: past the 10px slop the long press cancels its own
   * timer and only the drag is left; on a still finger the menu opens at 500ms
   * and TAKES the finger — `openCardMenuAt` releases the drag the sensor had
   * armed on it at 200ms. Left alone, that drag outlived the menu: the card
   * stayed lifted until the finger came off, and dnd-kit's click guard ate a
   * tap for 50ms after the lift (see `releaseTouchDrag`). The other three
   * touch handlers exist on one side only, so their spread is not a collision.
   */
  const dragTouchStart = listeners?.onTouchStart;
  const onCardTouchStart = useCallback((e: React.TouchEvent<HTMLElement>) => {
    dragTouchStart?.(e);
    cardLongPress.handlers.onTouchStart(e);
  }, [dragTouchStart, cardLongPress.handlers]);
  const confirm = useConfirm();
  const tr = useT();
  const toast = useToast();
  // Numeri e date della card seguono la lingua scelta, non una fissata a mano.
  const locale = useLocale();
  // The context menu offers two of the same actions as the button row (stop,
  // archive): the words come from the same table, or the card goes back to
  // calling them two different things depending on where you press.
  const stopWord = taskActionWord('stop', tr);
  const dropWord = taskActionWord('drop', tr);
  // Stessa tavola dell'«Archivia» che sostituisce: una porta e il suo ritorno
  // non possono chiamarsi in due sistemi diversi.
  const restoreWord = taskActionWord('restore', tr);
  // Lo stallo dei sottotask parcheggiati È una domanda, e la fa il SISTEMA: la
  // card può non avere nessun topic legato (il padre era stato rilasciato prima
  // di finire fermo). Senza quel ramo la domanda arrivava in review muta — con
  // le due risposte scritte in un commento e nessun bottone per darle.
  // Entrambi i rami stanno in `showsCardThread`, che è anche il predicato con
  // cui il server decide a quali schede attaccare i commenti.
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  const showsQuestion = showsCardThread(task);
  const need = cardDetailNeed(task);
  useEffect(() => {
    if (need === 'none') { setThread(null); setChildren([]); return; }
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ comments, children: kids }) => {
        if (!alive) return;
        // `need === 'children'` = i commenti li ha già la riga: riscriverli da
        // qui vorrebbe dire farli lampeggiare a ogni giro di lista.
        setThread(need === 'thread' ? selectCardComments(comments) : null);
        setChildren(kids ?? []);
      })
      .catch(() => { if (alive) { setThread(null); setChildren([]); } });
    return () => { alive = false; };
    // Re-check when the task changes (a re-kick bumps updatedAt).
  }, [need, task.projectId, task.id, task.updatedAt]);
  // Il testo del corpo: l'anteprima della lista, o la descrizione intera quando
  // a rispondere è un server che l'anteprima non la manda.
  const descriptionText = task.descriptionPreview ?? task.description;
  // «Copia» vuole la descrizione INTERA, che la lista non porta più. Si chiede
  // quando il menu si APRE, non al click: `navigator.clipboard.writeText` deve
  // girare nello stesso task del gesto (in WebKit un `await` in mezzo perde il
  // permesso), quindi al momento del click il testo dev'essere già qui.
  const [fullDescription, setFullDescription] = useState<string | null | undefined>(undefined);
  // Si chiede ogni volta che c'è un'anteprima senza il testo dietro, anche
  // quando l'anteprima è già tutta la descrizione: dedurlo dalla lunghezza
  // vorrebbe dire scrivere qui il numero di caratteri del taglio del server, e
  // il giorno che quel numero cambia si copierebbe un testo tagliato senza che
  // niente lo dica. Una richiesta in più su un tasto destro non si sente.
  const wantsFullDescription = task.description === null && !!task.descriptionPreview;
  useEffect(() => {
    if (!ctxMenu || !wantsFullDescription || fullDescription !== undefined) return;
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ task: full }) => { if (alive) setFullDescription(full.description); })
      .catch(() => {});
    return () => { alive = false; };
  }, [ctxMenu, wantsFullDescription, fullDescription, task.projectId, task.id]);
  const copyTask = async (): Promise<void> => {
    const description = task.description ?? fullDescription;
    if (wantsFullDescription && description === undefined) {
      toast.error(tr('browser.menu.copyFailed'));
      return;
    }
    if (await copyText(taskCopyText({ text: task.text, description: description ?? null }))) {
      toast.success(tr('board.task.copyTextDone'));
    } else {
      toast.error(tr('browser.menu.copyFailed'));
    }
  };
  // La riga della lista comanda; il fetch è la ricaduta per un server vecchio.
  const rowThread = useMemo(() => cardCommentsFromRow(task), [task]);
  const lastComment = rowThread?.latest ?? thread?.latest ?? null;
  /** Chi parla non e' una persona ne' un agente: vedi `isMachineVoice`. */
  const notesOfMachine = lastComment ? isMachineVoice(lastComment) : false;
  const humanContext = rowThread ? rowThread.humanContext : thread?.humanContext ?? null;
  // Plain text: the context row is a single clamped line, so markdown blocks
  // would only leak their syntax into it.
  const humanContextText = humanContext ? stripMarkdown(humanContext.content) : '';
  // …e una domanda a cui i sottotask hanno gia' risposto muovendosi non e' piu'
  // una domanda: le sue risposte rapide rimetterebbero in coda o archivierebbero
  // un insieme vuoto. La card ha solo due numeri, quindi usa il predicato piu'
  // stretto — puo' lasciarne viva una risolta, mai spegnerne una viva. Vedi
  // `shared/parked-question.ts`.
  const pending = lastComment && !isSettledParkedQuestion(lastComment, task)
    ? parseQuestionBlock(lastComment.content)
    : null;
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
  const fail = (e: unknown, fallback: string) => onError(task.id, taskActionErrorMessage(e, tr, fallback));
  // Il ripiego, quando il server non manda una frase, nomina l'azione con la
  // PAROLA della tabella condivisa: dire «Approva non è riuscito» sotto un
  // bottone che si chiama «Va bene» rimetterebbe due nomi sulla stessa porta.
  const failedWord = (id: Parameters<typeof taskActionWord>[0]) => tr('board.card.actionFailed', { action: taskActionWord(id, tr).label });
  const clearError = () => onError(task.id, null);
  // Le scelte (`TaskChoiceRow`) passano di qui per la stessa ragione: il loro
  // messaggio arriva già con l'etichetta della voce premuta, e va tradotto e
  // appoggiato su QUESTA card. Un esito buono la ripulisce.
  const choiceFailed = (message: string) => onError(task.id, taskActionErrorMessage(message, tr));
  // Il campo si svuota anche qui: da quando «Rimanda indietro» porta con sé il
  // testo, lasciarlo nella casella dopo un esito buono lo farebbe sembrare mai
  // partito — e al secondo click ripartirebbe due volte.
  const choiceDone = () => { clearError(); setFreeText(''); onRefetch(); };
  /**
   * THE LANDING RECEIPT, which this card used to throw away.
   *
   * `boardApi.land` answers `202` with a ticket: the merge is QUEUED, and the
   * card does not move until main confirms it. Without keeping it, "queued",
   * "refused" and "landed" all looked the same, which is to say like nothing,
   * and a failed land left the card identical forever. Same hook as the
   * drawer: following one ticket in two ways is how the card ended up not
   * following it at all.
   */
  const { landing, setLanding } = useLandingTicket(task.projectId, task.id, onRefetch);
  const landingBanda = landingBand(landing);

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
  /**
   * ENTER IN THE FIELD = A BUTTON FROM THE ROW ABOVE, carrying what you wrote.
   *
   * The field no longer has a button of its own: it used to have «Rimanda» (an
   * exact twin of «Rimandalo avanti») and «Nota» (a comment that wakes nobody
   * up, that is, the one entry in a column of decisions that decided nothing).
   * With both gone, the keyboard cannot remain the only road to a gesture the
   * buttons do not offer: that would be the worst of all, an invisible
   * shortcut with an effect of its own.
   *
   * So Enter runs EXACTLY one of the buttons in the row above — but not «the
   * first one»: the one the sentence just typed BELONGS to. On a delivery that
   * never arrived that is «Rimandalo avanti», which carries the text with it.
   * On one with a branch the first button is «Landa su main», and a verdict has
   * no field to put a sentence in: writing a remark and pressing Enter merged
   * the branch and closed the task (b673a253). Which one it is is not rewritten
   * here: `choiceForText` says so — pure, tested, and living next to
   * `taskChoices`, which draws those buttons, so keyboard and click cannot
   * diverge.
   *
   * Outside review (nothing to decide) it stays what it was: a comment, which
   * on a card in progress the agent receives on the next turn.
   */
  const primaryChoiceWithText = async () => {
    const v = freeText.trim();
    if (!v || busy) return;
    const scelte = taskChoices(task, { t: tr });
    // NOT `scelte[0]`: the choice the SENTENCE belongs to. On two of the three
    // review shapes the first choice is a verdict — «Landa su main», «Approva»
    // — and running a verdict because someone typed is how a remark merged a
    // branch and closed its task (b673a253). See `choiceForText`.
    const prima = choiceForText(scelte);
    // No choice takes it (or the one that does only wants the focus in the
    // field, where we already are): then the text is a note, and that is the
    // only sensible thing to do with it.
    if (!prima || prima.needsText) { void steer(v, { quiet: true }); return; }
    setBusy(true); clearError();
    try {
      // `send-back` carries the instruction with it, the way the button does.
      if (prima.id === 'send-back') await boardApi.review(task.projectId, task.id, 'reject', v);
      else {
        // The others have no field to put a sentence in: it is left on the
        // card BEFORE acting, so the why stays written next to the effect
        // instead of being lost by pressing Enter.
        await boardApi.comment(task.projectId, task.id, v, { quiet: true });
        // `land` and `accept` are absent ON PURPOSE: `choiceForText` never
        // returns a verdict, so a sentence cannot merge or approve. Both keep
        // their own button, which is where an irreversible gesture belongs.
        if (prima.id === 'take-over') await boardApi.update(task.projectId, task.id, { status: 'in_progress', assignee: 'io' });
        else if (prima.id === 'unblock') await boardApi.update(task.projectId, task.id, { blockedByTaskId: null, status: 'todo' });
        else if (prima.id === 'stop') await boardApi.stop(task.projectId, task.id);
      }
      setThread(null); setFreeText(''); onRefetch();
    } catch (e) {
      fail(e, tr('board.card.actionFailed', { action: prima.label }));
    } finally { setBusy(false); }
  };
  const archive = async () => {
    // Archiviare un task con l'agent al lavoro gli taglia il turno (il server lo
    // stacca prima di archiviare, altrimenti resterebbe a girare per nessuno).
    // Il turno non torna indietro, quindi si chiede — ma solo quando c'è
    // davvero un agent da fermare: su una card ferma la domanda sarebbe rumore.
    if (isAgentWorking(task.dispatchState)) {
      const ok = await confirm({
        title: tr('board.card.archiveRunning'),
        confirmLabel: tr('board.card.archiveRunningConfirm'),
        body: <p>{tr('board.card.archiveRunningBody')}</p>,
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
    catch (e) { fail(e, tr('board.card.messageNotSent')); }
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
  // Le due domande, una volta sola: quanto e' COSTATO (il chip) e quanto
  // CONTESTO e' passato (il tooltip). La regola sta in `shared/token-cost.ts`.
  const parti = partsFromTask(task);
  const costo = costTokens(parti);
  const contesto = contextTokens(parti);
  const sessionEnded = shouldExplainMissingSession(sessionState);
  // The eyebrow row is now IDENTITY only: which project this card belongs to,
  // and the door to its session. Everything about the turn (state, model,
  // tokens, git) moved to the card's foot, so this row renders only when it
  // has something of its own to say.
  const showTopRow = (showProject && !unassigned) || canOpenSession || sessionEnded;
  const showPriority = !priorityAwaitingAgent(task) && task.priority !== 2;
  // THE CHECKLIST IS THE SAME IN EVERY COLUMN. It used to open only in review
  // and the other columns got a `3/7` chip instead: the same card changed
  // shape as it crossed a boundary, which is exactly what this card is being
  // straightened out for. The steps are what a task IS, in todo as much as in
  // review. The fallback chip stays for the card whose children the list has
  // not handed over yet.
  const checklist = children;
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
  /** Misurato: NIENTE. Vedi il chip piu' sotto per il perche' non e' un rosso. */
  const checksUnknown = task.checksState === 'unknown';
  // IL VERDE SI DICE, non si deduce dall'assenza del rosso.
  //
  // Prima esisteva solo `checksRed`: una card senza chip poteva voler dire
  // «controlli passati» oppure «nessuno li ha mai fatti girare», e sono due
  // situazioni opposte davanti allo stesso gesto. Chi approva deve sapere quale
  // delle due sta guardando, e il silenzio non lo dice.
  //
  // The fact EXISTS only after a run of the checks, so a second gate on the
  // status buys nothing: a card in todo has no `checksState`, and an approved
  // one that passed them keeps saying so. The `status === 'review'` that used
  // to be here made the green vanish the instant the card was closed, that is,
  // it changed what the card said without any fact changing.
  const checksGreen = task.checksState === 'pass';
  const checksRunning = task.checksState === 'running';
  // Un solo predicato per il chip e per la riga che lo contiene: due copie
  // dello stesso «questo chip c'è» sono precisamente il modo in cui la riga
  // finisce per non montarsi mentre il chip crede di esserci.
  // Il numero, non un booleano: dentro il chip serve il VALORE, e un flag
  // separato costringerebbe a un `!` che dice al compilatore «fidati» proprio
  // dove il dato può mancare. `null` = the measure was never recorded, which
  // is not a zero: a zero would say "looked, and it changed nothing".
  // Lo ZERO non passa di qui: un ramo senza commit ha il suo chip
  // (`senzaCommit`), e «0 file +0 -0» accanto direbbe due volte la stessa cosa
  // con la forma di una misura buona.
  const deliveryStat = task.deliveryFilesChanged || null;
  /**
   * THE GIT CHANGES WHILE THE AGENT IS STILL WRITING THEM.
   *
   * The delivery measure is born at the end of the turn: before that the card
   * said not one line about what was changing, and seeing it meant opening the
   * task and its "Modifiche" panel. But the diff route reads the LIVE WORKTREE
   * (`task-diff-range.ts`), so the data was already there: what was missing
   * was a place to ask for it. That place is now the chip next to the model,
   * and it only asks when opened, so no card costs a repository read.
   */
  const gitLive = deliveryStat === null && isAgentWorking(task.dispatchState);
  // COME E' STATO LAVORATO, quando una misura non c'e'.
  //
  // Misurato il 17/08: 33 card in review, 31 senza fotografia di consegna, 30
  // senza nemmeno una sessione. Tutte mostravano lo STESSO niente, e quel
  // niente voleva dire due cose opposte: «ci ha lavorato un agente sul
  // checkout condiviso, i commit ci sono ma stanno su main e non sono
  // attribuibili» oppure «questa card l'ha trascinata qui una mano».
  // Segnalato: «quelli in review sembrano solo i task spostati, ma una volta
  // in review dovrei vedere aggiornamenti, no?».
  //
  // Non si inventa una misura che non puo' esistere: si dice perche' non c'e'.
  // Il riassunto ripiegato/aperto vive PER CARD e non nel task: e' una scelta
  // di lettura, non un dato. Chi apre una card la ritrova aperta finche' la
  // board resta montata.
  const [commentoAperto, setCommentoAperto] = useState(false);
  /** Stessa natura: la richiesta umana citata sta ripiegata a tre righe finche'
   *  non la si apre, e la scelta vale per questa card e basta. */
  const [richiestaAperta, setRichiestaAperta] = useState(false);
  const evidenza = reviewEvidence(task);
  const lavoroInPlace = evidenza.kind === 'in-place';
  const spostataAMano = evidenza.kind === 'manual';
  // NIENTE CONSEGNATO, e la card lo dice dalla colonna. Prima questa situazione
  // portava il chip «Lavorata qui», che promette commit su main: su una card
  // dove l'agent non ha prodotto nulla e' una bugia che manda a cercare un
  // lavoro inesistente. Vedi `lib/reviewEvidence.ts`.
  // UNA SOLA CHIP PER LA NON-CONSEGNA: la regola sta in `lib/board.ts`
  // (`nothingDeliveredWins`), dove un test la raggiunge. Qui si applica.
  const senzaConsegna = evidenza.kind === 'empty' && nothingDeliveredWins(task.deliveredReason);
  // RAMO SENZA UN COMMIT: si dice PRIMA che qualcuno clicchi «Landa su main».
  // Non e' una consegna piccola, e' nessuna consegna — e quel land si
  // rifiutera', perche' i file non committati nel worktree bloccano il
  // riallineamento. Vedi `lib/reviewEvidence.ts` per la misura.
  const senzaCommit = evidenza.kind === 'uncommitted';
  // AND HOW MUCH WORK SITS IN THERE, when somebody counted it. "Branch with no
  // commit" says what is MISSING and stays silent on what is there: the same
  // words rode over a card that had produced nothing and over one holding two
  // finished files in its worktree, and those are the two opposite decisions
  // (a re-dispatch against one line asking for a commit). The number goes HERE,
  // in the chip that already talks about the git side, and not as one more
  // comment in the thread.
  const uncommittedCount = uncommittedChipCount(task.deliveryUncommittedFiles, senzaCommit);
  // DA QUANTO ASPETTA UNA RISPOSTA. La data di aggiornamento in review era
  // nascosta apposta - e faceva bene, perche' `updatedAt` si muove a ogni
  // commento e diceva «ora» su una card ferma da giorni. Questo invece e'
  // l'istante in cui la card e' ENTRATA in review, quindi risponde davvero.
  // Muto sotto l'ora: una richiesta appena arrivata non sta aspettando.
  const attesa = task.status === 'review' ? fmtAttesa(task.reviewAt) : null;
  // «Chiude il direttore»: oggi si monta solo con almeno un'etichetta, quindi
  // `task.labels.length` nell'OR lo copre PER CASO. Il giorno che `whoCloses`
  // rispondesse `conductor` senza etichette, quel chip sparirebbe in silenzio.
  // Dichiararlo qui costa una riga e toglie una dipendenza fortunata.
  const conductorCloses = task.status === 'review'
    && whoCloses(task.labels.map((l) => l.label), task.checksState) === 'conductor';
  // Solo in Review: lì la domanda è "cosa guardo?", e la risposta cambia se
  // nessun agent ha detto "fatto". Su una card done sarebbe archeologia (il
  // drawer la conserva comunque). La regola sta in `lib/board.ts` come le altre
  // due qui sotto: dentro il JSX nessun test unitario la raggiungeva.
  const systemDelivered = senzaConsegna ? null : systemDeliveryChip(task);
  // Il legame, non la lista: il chip nasce da `blockedByTaskId` + il bloccante
  // risolto dal server, così vale anche quando il bloccante non è fra i task
  // fetchati (sottotask, altro progetto, archiviato).
  const blockedChip = blockedByChip(task);
  // «Riaperta»: la card ERA in Done e non c'è più. Il fatto vive sulla card
  // (l'API lo dice), non solo nel thread — dalla colonna si vedeva solo il buco.
  const reopened = reopenedChip(task);
  // Quale famiglia di scelte disegna questa card (una sola, vedi taskChoices).
  const choiceState = taskChoiceState(task);
  /**
   * LA SCELTA CHE L'INVIO DEL CAMPO ESEGUE, disegnata sul tasto d'invio.
   *
   * Il campo libero della review non aveva nessun bottone: l'unica strada era
   * Invio da tastiera, cioè una scorciatoia che non si vede. Chi non la
   * conosceva scriveva l'indicazione e poi premeva il bottone grande, e finché
   * quello non portava il testo la card tornava all'agente MUTA — il difetto
   * che `sendBackText` ha chiuso a metà, perché il gesto restava invisibile.
   * Adesso l'invio c'è, e porta il GLIFO e il NOME della scelta che eseguirà
   * («Rimanda indietro», «Landa su main»…): non un secondo bottone con un
   * effetto suo, la stessa azione della riga sopra con dentro la frase.
   */
  // The send button names the action IT PERFORMS — the text's one, not the
  // first in the row: with `[0]` it promised «Landa su main» and sent back.
  const primaChoice = useMemo(() => choiceForText(taskChoices(task, { t: tr })), [task, tr]);
  // …e l'altra metà, che è il verso OPPOSTO: quanti aspettano QUESTA card.
  // Anche questo numero è un fatto del DB, non della lista fetchata — un
  // dipendente che è un sottotask o sta in un altro progetto non è fra le card,
  // ma aspetta lo stesso. Le due frasi non condividono una parola: vedi il
  // blocco «i due versi dell'attesa» in lib/board.ts.
  const waitingOnThis = waitingOnThisChip(task);
  // LA RIGA DEI CHIP ESISTE SE C'È ALMENO UN CHIP, e questo elenco è la lista
  // di quelli possibili: chi ne aggiunge uno e non lo scrive qui ottiene un
  // chip che non si monta MAI, con il dato giusto nel DB, giusto nella rotta e
  // giusto in mano al client. È successo con `deliveryStat` (16/08) ed è
  // costato tre giri di debug, perché ogni misura diceva che tutto funzionava.
  // `card-meta-row-completeness.test.ts` confronta questa riga con i chip
  // davvero disegnati sotto, così la prossima dimenticanza è un rosso e non
  // un'ora di indagine.
  const hasMetaRow = !!(blockedChip || reopened || waitingOnThis || task.parentTaskId || task.userCommentCount > 0 || task.planFirst || task.assignedTo || notLanded || checksRed || checksUnknown || checksGreen || checksRunning || systemDelivered || deliveryStat !== null || attesa || conductorCloses || lavoroInPlace || spostataAMano || senzaConsegna || senzaCommit || task.labels.length);

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      data-task-card={task.id}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      {...cardLongPress.handlers}
      // AFTER both spreads, and on purpose: this is the composed one (see
      // `onCardTouchStart`). Whoever moves it above them loses the board's
      // touch drag again, without a single error.
      onTouchStart={onCardTouchStart}
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
      {/* Eyebrow: WHICH project this card belongs to, and the door to its
          session. Nothing else.

          The agent cluster used to live here (dispatch state, model, tokens)
          and the card changed face from one column to the next: a turn's
          measure on top, content in the middle, chips at the bottom. The turn
          now has a FOOT of its own (state, model, git, last update), the same
          in every state, and this row is back to saying one thing. */}
      {showTopRow && (
        <div className="mb-1 flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-xs md:text-[11px] text-app-text-secondary">
            {showProject && !unassigned && (
              <>
                {projectPath && <ProjectFavicon path={projectPath} size={12} className="shrink-0" />}
                <span className="min-w-0 truncate font-medium">{projectLabel}</span>
              </>
            )}
            {/* Il `#` NON sta più qui. Nell'eyebrow leggeva come una proprietà
                del PROGETTO — «topics-app #» — mentre è l'identità di QUESTA
                card, e chi lo copia lo copia per parlare del task. Adesso apre
                il titolo, che è la cosa che nomina. */}
          </div>
          {canOpenSession && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenTopic!(task.assignedTopicId!); }}
              data-testid="card-open-session"
              className="shrink-0 rounded bg-white/10 p-1 text-app-text hover:bg-white/20"
              title={tr('board.task.openSessionTitle')}
            ><MessageSquare className="h-3 w-3" /></button>
          )}
          {/* La sessione c'era e non c'è più. Non si nasconde e non si apre il
              vuoto: si dice, spento, così il gesto mancante ha una ragione. */}
          {sessionEnded && (
            <span
              data-testid="card-session-gone"
              className="shrink-0 rounded bg-white/5 p-1 text-app-text-faint"
              title={tr('board.task.sessionGoneTitle')}
            ><MessageSquare className="h-3 w-3" /></span>
          )}
        </div>
      )}
      {/* Anteprima della consegna: screenshot (previewImage, allowlist media)
          reso come thumbnail sopra il titolo — la review parte guardando la
          cosa. Il click passa alla card (apre il drawer). object-top: di un
          full-page si vede la testata, non un centro anonimo. */}
      {/* LA SCHEDA DI CONSEGNA NON VA SULLA CARD, e non e' un ripensamento:
          e' la misura di cosa e' diventata. Era il rimedio a «9 card su 16 con
          il riquadro vuoto», e il ragionamento era buono — un silenzio vale
          come segnale solo se e' raro. Misurato oggi: **4 card su 10 in review
          mostrano una scheda**, cioe' il rimedio e' diventato la norma, e
          quello che si vede aprendo la board non e' piu' l'evidenza del
          lavoro ma un disegno che ripete la card.

          E ripete davvero: titolo, file toccati, righe aggiunte e tolte, ramo.
          Sono gli stessi quattro fatti che la card ha gia' scritti sopra, nel
          titolo e nel chip della consegna. Tre delle quattro non hanno nemmeno
          i numeri (delivery_files_changed vuoto) e dicono «Nessun codice
          consegnato»: il 60% della larghezza della card per ripetere il
          titolo e dichiarare un'assenza.

          Resta nel DRAWER, dove lo spazio non e' conteso e dove il riassunto
          della consegna e' cio' che si sta cercando. Sulla card torna il
          riquadro vuoto — che qui e' l'informazione giusta: «questa consegna
          non ha ancora un'evidenza da guardare». */}
      {task.previewImage && !isDeliverySheetPath(task.previewImage) && (
        <PreviewMedia
          path={task.previewImage}
          // Le ALTRE evidenze del thread: il carosello si naviga con la
          // rotella e il click apre il lightbox. Vuoto = una slide sola, e il
          // componente si comporta come prima.
          paths={task.previewImages}
          variant="card"
          // Il click nudo sulla card apre il drawer sul Thread; questo apre lo
          // stesso task con l'anteprima GIÀ in primo piano come tab.
          onOpenTab={() => onOpen(task.id, mediaPaneIdFor(task.previewImage!))}
        />
      )}
      {/* Title — full width; the priority rides INLINE before the text (only
          when hand-set and non-default), so urgency reads in the same glance
          as the title instead of down in a chip row. */}
      {/* I SEGNI E IL NOME, allineati PER COSTRUZIONE e non con un numero tarato.
          ═══════════════════════════════════════════════════════════════════
          Erano inline dentro il titolo con `align-middle`, e misurati stavano
          1,8px sotto il testo. Il motivo non e' l'allineamento: il chip e' alto
          18px su una riga di testo da 17, quindi e' LUI a definire la riga e il
          testo gli si muove attorno — nessun `vertical-align` converge, perche'
          spostare il chip sposta anche il riferimento (provati sette valori,
          tutti fra 1,3 e 2,3px).
          Qui i segni stanno in un gruppo alto ESATTAMENTE una riga di titolo
          (`h-[1.375em]` = `leading-snug`) e ci si centrano dentro; il titolo
          accanto ha la stessa altezza di riga e parte dallo stesso bordo, quindi
          i due centri coincidono senza che nessuno li tari. Il prezzo e' che un
          titolo lungo va a capo SOTTO se stesso invece che sotto i segni — che
          e' anche il motivo per cui i segni restano leggibili come un gruppo.
          UNA distanza sola (`gap-1.5`): prima erano 6px dopo la priorita' e 4px
          dopo il `#`, due misure per la stessa cosa nella stessa riga. */}
      {/* IL TITOLO RIEMPIE LA RIGA, e va a capo SOTTO I SEGNI.
          ═══════════════════════════════════════════════════════════════════
          La stesura precedente metteva i segni e il nome in due colonne flex:
          i centri coincidevano per costruzione (nessun numero tarato, ed e'
          la parte da tenere) ma il titolo diventava una COLONNA larga quanto
          lo spazio rimasto, quindi andava a capo incolonnato sotto se stesso.
          Su un titolo lungo la card leggeva come un paragrafo rientrato:
          «il titolo non va piu' a capo bene, ma e' incolonnato a partire dal
          cancelletto».
          Ora e' UNA riga di testo con i segni dentro (`inline-flex`), quindi
          la seconda riga parte dal bordo della card come qualunque testo che
          va a capo. L'allineamento verticale resta per costruzione: il gruppo
          dei segni e' alto esattamente una riga di titolo (`h-[1.375em]` =
          `leading-snug`) e si centra dentro di essa, cioe' la stessa
          aritmetica di prima applicata a un riquadro in linea invece che a
          una colonna.
          UNA distanza sola (`gap-1.5`): prima erano 6px dopo la priorita' e
          4px dopo il `#`, due misure per la stessa cosa nella stessa riga. */}
      <span className="block break-words leading-snug">
        {/* `align-top` e non `align-text-bottom`.
            Il gruppo e' alto ESATTAMENTE una line-box (`h-[1.375em]` =
            `leading-snug`), quindi il suo centro coincide con quello della
            line-box - ma solo se lo si allinea alla line-box, che e' cio' che
            fa `top`. `text-bottom` allinea le BASI del testo, e la base non e'
            il centro: la line-box e' 19,25px, il testo dentro ne occupa 17, e
            la meta' della differenza e' esattamente lo scarto che si vedeva.
            Misurato sulla card vera, sette valori a confronto:
              text-bottom -1,125   baseline -1,5   middle +1,813
              text-top    +1,125   bottom   +0,125   TOP  +0,125
            0,125px e' il sub-pixel del font, non un disallineamento. */}
        <span className="mr-1.5 inline-flex h-[1.375em] shrink-0 items-center gap-1.5 align-top">
          {showPriority && (
            <span
              title={tr('board.card.priorityTitle', { label: PRIORITY_LABEL[task.priority] ?? task.priority })}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs md:text-[10px] ${
                task.priority >= 3 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-app-text-secondary'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
              {PRIORITY_LABEL[task.priority] ?? task.priority}
            </span>
          )}
          <TaskIdChip id={task.id} />
        </span>
        {/* Il titolo RISCRITTO non viene sostituito: le lettere cambiate
            entrano una dietro l'altra (vedi `Shared/MorphText`). Riscrivere il
            nome di un task e' una cosa che succede spesso e sempre altrove —
            lo fa una persona dal drawer, o l'agente che lo ha preso in carico e
            gli da' un titolo vero — quindi chi guarda la board vedeva una card
            diversa senza sapere che fosse la stessa. A riposo il componente non
            aggiunge un solo nodo al DOM. */}
        <MorphText text={task.text} />
      </span>
      {/* Relational chips (blocker / parent / thread / plan / assignee): the
          row renders only when at least one is present.

          UNDER THE TITLE, BEFORE THE DESCRIPTION. They used to trail the body,
          and the body changed order depending on the column: the same fact had
          to be looked for in a different place. Title, how it stands (chips),
          what it holds (subtasks), what it asks (description): one reading,
          the same in every state. */}
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
              title={parentTitle ? tr('board.card.openParentNamedTitle', { title: parentTitle }) : tr('board.task.openParentCardTitle')}
              className="max-w-[9rem] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300 hover:bg-violet-500/25"
            >⤴ {parentTitle ?? tr('board.card.parent')}</button>
          )}
          {task.userCommentCount > 0 && (
            <span
              title={tr(task.userCommentCount === 1 ? 'board.card.yourMessagesOne' : 'board.card.yourMessagesMany', { n: task.userCommentCount })}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
            ><MessageSquare className="h-3 w-3 shrink-0" /> {task.userCommentCount}</span>
          )}
          {notLanded && (
            <span
              data-testid="card-not-landed"
              title={tr('board.card.notLandedTitle', {
                commit: task.deliveryCommit?.slice(0, 8) ?? '?',
                branch: task.deliveryBranch ? tr('board.card.notLandedBranch', { branch: task.deliveryBranch }) : '',
              })}
              className="flex max-w-full items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
              // Il RAMO sta nel testo, non solo nel `title`: su touch l'hover non
              // esiste, e senza il nome la card dice che c'è un problema ma non
              // dove sta il lavoro. `max-w-full` più il `flex-wrap` della riga:
              // il chip prende la sua riga invece di comprimere il nome, e
              // `truncate` resta solo per il caso estremo (nome intero nel DOM
              // e nel tooltip, colonna che non si allarga mai).
            ><AlertTriangle className="h-3 w-3 shrink-0" /> <span className="truncate">{tr('board.task.notOnMain')}{notLandedBranch ? ` · ${notLandedBranch}` : ''}</span></span>
          )}
          {/* QUANTO LAVORO C'È DENTRO, sulla card e non dietro un clic.
              La colonna review chiedeva «Approva» senza dire cosa si stesse
              approvando: nessun file, nessuna riga, nessun esito. Il diff
              esisteva solo aprendo il drawer, cioè una card alla volta - e una
              colonna che si legge solo aprendola non è un cruscotto, è un
              elenco di titoli.
              Solo in review: nelle altre colonne non c'è ancora una consegna da
              pesare. `null` (non misurato) non disegna niente, perché uno zero
              direbbe «non ha prodotto niente», che è un'altra affermazione. */}
          {/* `!= null` (due uguali, di proposito): copre null E undefined con lo
              stesso confronto. Un `!== null` secco lasciava passare l'undefined
              di un payload che quel campo non lo porta - ed e' costato un giro
              di debug, perche' il dato era giusto nel DB e giusto nel feed. */}
          {attesa && (
            <span
              data-testid="card-review-age"
              title={tr('board.card.reviewAgeTitle', {
                when: task.reviewAt ? new Date(task.reviewAt).toLocaleString(locale) : '',
              })}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-muted"
            ><Hourglass className="h-3 w-3 shrink-0" /> {tr('board.card.reviewAge', { t: attesa })}</span>
          )}
          {senzaCommit && (
            <span
              data-testid="card-uncommitted"
              title={tr('board.card.uncommittedTitle')}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><CircleSlash className="h-3 w-3 shrink-0" /> {uncommittedCount > 0
              ? tr('board.card.uncommittedFiles', { n: uncommittedCount })
              : tr('board.card.uncommitted')}</span>
          )}
          {senzaConsegna && (
            <span
              data-testid="card-nothing-delivered"
              title={tr('board.card.nothingDeliveredTitle')}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><CircleSlash className="h-3 w-3 shrink-0" /> {tr('board.card.nothingDelivered')}</span>
          )}
          {lavoroInPlace && (
            <span
              data-testid="card-worked-in-place"
              title={tr('board.card.inPlaceTitle')}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-muted"
            ><GitBranch className="h-3 w-3 shrink-0" /> {tr('board.card.inPlace')}</span>
          )}
          {spostataAMano && (
            <span
              data-testid="card-moved-by-hand"
              title={tr('board.card.movedByHandTitle')}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-muted"
            >{/* NON PIU' UNA MANO, e non e' una questione di gusto: segnalata come
                  «la vedo sgranata», e misurata lo e' davvero. A 12px il
                  viewBox 24 si comprime a scala 0,5, e `hand` e' l'icona piu'
                  DENSA dell'intero set della card: 45,7px di linea da stipare
                  in un lato di 12 (contro i 27 di questa, i 12,6 di un
                  `user-round`, i 2 comandi di `circle-slash`). Nessun tratto
                  piu' spesso lo ripara: il problema non e' lo spessore — 1px
                  CSS su dpr 2 fa 2px fisici, cioe' nitido — ma il DETTAGLIO
                  che non ci sta, cinque dita in dodici pixel.
                  Le due frecce dicono anche meglio cosa e' successo: la card
                  e' stata SPOSTATA, e chi l'ha spostata e' scritto accanto. */}
              <ArrowRightLeft className="h-3 w-3 shrink-0" /> {tr('board.card.movedByHand')}</span>
          )}
          {checksGreen && (
            <span
              data-testid="card-checks-green"
              title={tr('board.card.checksGreenTitle')}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-emerald-300"
            ><ShieldCheck className="h-3 w-3 shrink-0" /> {tr('board.card.checksGreen')}</span>
          )}
          {checksRunning && (
            <span
              data-testid="card-checks-running"
              title={task.checksProgress
                ? tr('board.card.checksRunningProgressTitle', {
                    done: task.checksProgress.done, total: task.checksProgress.total,
                  })
                : tr('board.card.checksRunningTitle')}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-muted"
            >
              <Hourglass className="h-3 w-3 shrink-0" />
              {/* A CHE PUNTO E', non solo «in corso». Segnalato: «vedo che c'e'
                  qualcosa in corso, ma se c'e' qualcosa in corso dovrebbe
                  esserci un progress». Il dato c'era gia' — `runReviewChecks`
                  espone `onProgress` e i comandi girano uno per uno — e non lo
                  leggeva nessuno.
                  Quando il progresso non e' noto (una corsa partita prima di
                  questo codice) si torna alla parola di prima, invece di
                  mostrare uno «0/0» che sembra una misura. */}
              {task.checksProgress
                ? tr('board.card.checksRunningProgress', {
                    done: task.checksProgress.done, total: task.checksProgress.total,
                  })
                : tr('board.card.checksRunning')}
              {task.checksProgress && (
                // La barra: due numeri si leggono, una barra si coglie senza
                // leggere. Larghezza fissa perche' in una riga di chip un
                // elemento che cresce col contenuto fa ballare i vicini.
                <span className="ml-0.5 h-1 w-6 overflow-hidden rounded-full bg-white/15" aria-hidden>
                  <span
                    /* NON `card-…`: quel prefisso e' riservato ai CHIP della
                     * fascia, e un cancello (`card-meta-row-completeness`)
                     * pretende che ognuno abbia una riga in `hasMetaRow` —
                     * giustamente, perche' un chip fuori da quella condizione
                     * non monta mai. Questa non e' un chip: e' il riempimento
                     * DENTRO il chip dei check, e la sua condizione e' gia'
                     * quella del chip che la contiene. */
                    data-testid="checks-progress-bar"
                    className="block h-full rounded-full bg-app-text-muted transition-all"
                    style={{ width: `${Math.round((task.checksProgress.done / task.checksProgress.total) * 100)}%` }}
                  />
                </span>
              )}
            </span>
          )}
          {/* NON MISURATI, e si deve leggere diverso da rosso. Ambra e non rosa:
              rosso dice «il codice e' rotto, non approvare», questo dice «non lo
              sappiamo» — e chi rivede decide diversamente nei due casi. Misurate
              il 18/08 sul DB vivo: 6 card su 15 marcate `fail` erano solo scadute
              al tetto dei 20 minuti, cioe' il 40% delle bocciature accusava un
              codice sano. */}
          {checksUnknown && (
            <span
              data-testid="card-checks-unknown"
              title={tr('board.card.checksUnknownTitle')}
              className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><Hourglass className="h-3 w-3 shrink-0" /> {tr('board.card.checksUnknown')}</span>
          )}
          {checksRed && (
            <span
              title={tr('board.card.checksRedTitle', { commands: (task.checks ?? []).filter((c) => !c.ok).map((c) => c.cmd).join(', ') || tr('board.card.checksRedUnknown') })}
              className="flex items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
            ><AlertTriangle className="h-3 w-3 shrink-0" /> {tr('board.card.checksRed')}</span>
          )}
          {task.planFirst && (
            <span
              title={tr('board.card.planTitle')}
              className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300"
            >{tr('board.card.plan')}</span>
          )}
          {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading">@{task.assignedTo}</span>}
          {/* Le etichette in coda alla riga: quelle di visibilità dicono CHI
              CHIUDE la card, le altre servono a leggere la board. */}
          {task.labels.map((l) => <LabelChip key={l.label} label={l.label} source={l.source} />)}
          {/* La CONSEGUENZA, detta dove si decide: una card invisibile con la
              barra verde per intero non aspetta Attilio. Solo in review — nelle
              altre colonne non c'è ancora niente da chiudere. */}
          {conductorCloses && (
            <span
              data-testid="card-conductor-closes"
              title={tr('board.card.conductorClosesTitle')}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-emerald-300"
            ><ShieldCheck className="h-3 w-3 shrink-0" /> {tr('board.card.conductorCloses')}</span>
          )}
          {/* I FILE MODIFICATI NON SONO PIU' UN CHIP QUI.
              Stavano in fondo a questa riga, e la posizione era gia' il
              risultato di una correzione — «per i file modificati li potremmo
              mettere in fondo, invece che mischiarli con le altre chip». Ma
              restavano un CONTEGGIO: dicevano quanto e mai cosa, e davanti a
              una consegna da rivedere «quali file ha toccato» e' la prima
              domanda. Adesso sono un dropdown a chip nel piede della card,
              a chip dropdown in the card's foot, next to the model: see
              `DeliveryFiles.tsx`. */}
          {/* THE WAYS OUT OF THE WAIT, on a blocked card, as ONE compact key at
              the end of the row: the same shape a working card already uses for
              its rare actions.
              They used to be a row of full buttons in the card's body, inside a
              container that stops propagation, and it was the LAST thing on the
              card: on a short card that row IS the geometric centre, so
              clicking the card in the middle did not open the drawer, it
              pressed «sblocca» and PATCHed the dispatch gate with no
              confirmation. Moving the row lower was not an option (nothing was
              below it), so what changes is the SIZE of the target.
              The row of buttons stays in the drawer, where you are already
              looking at the card on purpose. */}
          {choiceState === 'blocked' && (
            <TaskChoiceMenu
              task={task} disabled={busy} onDone={choiceDone} onError={choiceFailed}
              ariaLabel={tr('board.card.blockedActions')}
            />
          )}
        </div>
      )}
      {/* The checklist: the steps, in EVERY column and not only in review.
          Max 5 rows, the rest behind "Vedi tutti" (opens the drawer tree).
          The compact done/total chip stays as the fallback for a card whose
          children have not arrived yet.
          It sits between the chips and the description: the chips say how the
          card stands, the steps what it holds, the description what it asks. */}
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
              title={tr('board.card.openSubtaskTitle', { status: STATUS_LABEL[s.status] })}
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
              title={tr('board.card.fullChecklistTitle')}
              className="px-0.5 text-xs md:text-[11px] text-app-text-secondary hover:text-app-text"
            >+{checklist.length - 5}… {tr('board.card.seeAll')}</button>
          )}
        </div>
      ) : task.subtaskCount > 0 ? (
        <div className="mt-1">
          <span
            title={tr('board.card.subtasksDone', { done: task.subtaskDoneCount, total: task.subtaskCount })}
            className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
          >↳ {task.subtaskDoneCount}/{task.subtaskCount}</span>
        </div>
      ) : null}
      {/* Description preview — plain text, clamped (the full markdown lives in
          the drawer). The update time closes the body — but on a REVIEW card the
          review block below owns the tail, and prints the date itself after the
          agent's last word, so it must not be printed here as well.
          The gate used to be `!isAgentReview`, which is narrower than the block
          it defers to: the block renders on every review card, so a review card
          with no agent bound to it (a delivery nobody dispatched) printed the
          same date TWICE, one line under the other.
          `descriptionPreview` è ciò che la lista manda (240 caratteri: il
          riquadro ne mostra due righe); `description` è la ricaduta per un
          server più vecchio del client, che l'anteprima non la calcola. */}
      {descriptionText && (
        <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-app-text-secondary">{stripMarkdown(descriptionText)}</p>
      )}
      {/* OGNI card in review, non solo quelle di un agente. `showsQuestion`
          seleziona chi ha una PAROLA da mostrare (l'agente, o il sistema sui
          figli parcheggiati); le SCELTE invece nascono dallo stato e valgono
          anche per una consegna che nessun agente ha fatto. Tenerle sotto lo
          stesso gate lasciava quella card con la sola casella di testo, che è
          esattamente il difetto che `taskChoices` ha chiuso. */}
      {/* LO STOP AL CLICK STA SUI COMANDI, NON SU TUTTO IL BLOCCO.
          La card È il bottone che apre la scheda (`onClick` sulla radice), e
          questo blocco è la parte più alta di una card in review: con il freno
          sul contenitore, il gesto principale moriva su quasi tutta la
          superficie — testo dell'agente, richiesta citata, data e ogni pixel
          vuoto fra un comando e l'altro. Il freno serve alle SCELTE e alla
          casella (lì un click ha già il suo effetto), quindi è lì che sta. */}
      {task.status === 'review' && (
        <div className="mt-2 space-y-1.5">
          {/* The human request the answer below is answering, kept to ONE line.
              On a card that bounced back through review it is the rework note,
              and without it the answer arrives with its question missing. It is
              context, not content: muted, clamped, and quoted only when a real
              reply followed it (`selectCardComments`). No human word, no row:
              nothing empty is ever reserved here. */}
          {/* IL TESTO C'E' TUTTO, e se e' lungo si RIPIEGA — non si taglia.
              `truncate` teneva una riga sola e buttava il resto nel tooltip:
              su una richiesta di due frasi la card mostrava la prima meta' di
              una domanda, e chi rivedeva leggeva la risposta senza sapere a
              che cosa. Stesso pieghevole della parola dell'agente qui sotto,
              con una soglia piu' bassa perche' questa riga e' contesto. */}
          {showsQuestion && humanContextText && (
            <div className="border-l-2 border-sky-400/40 pl-1.5">
              <p
                data-testid="card-human-context"
                className={`break-words text-xs md:text-[11px] leading-relaxed text-app-text-muted ${richiestaAperta ? '' : 'line-clamp-3'}`}
                title={tr('board.card.yourRequest', { text: humanContextText })}
              >{humanContextText}</p>
              {humanContextText.length > RICHIESTA_PIEGA_CHARS && (
                <button
                  data-testid="card-human-context-toggle"
                  onClick={(e) => { e.stopPropagation(); setRichiestaAperta((v) => !v); }}
                  className="text-xs md:text-[10px] text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
                >
                  {richiestaAperta ? tr('board.card.commentLess') : tr('board.card.commentMore')}
                </button>
              )}
            </div>
          )}
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {/* CHI PARLA, il predicato in un posto solo.
              Il tag «SISTEMA» e il colore muted guardavano `kind === 'review-note'`,
              cioe' la specie MENO numerosa: 38 note su 345 in tre giorni. Le
              notifiche del sistema hanno `author: 'system'` con la kind di
              default, e sono «la specie piu' numerosa» (il commento in
              `cardComments.ts` la conta a 3.984 righe). Quando una di quelle
              veniva promossa a parola della card, la card la disegnava in
              `text-app-text-heading` — identica al riassunto di un agente, senza
              nessun segno che a parlare fosse la macchina. E' il difetto che il
              commit 2ded6eae4 dichiarava chiuso: chiuso per la specie rara,
              aperto per quella che arriva quasi sempre.
              La domanda ```question del sistema NON passa di qui: ha il suo ramo
              (`pending`, appena sotto), quindi non prende il tag e resta
              protagonista come deve. */}
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
              // RIPIEGATO SE E' TROPPO, non tagliato in silenzio.
              //
              // Il riassunto arriva intero (1200 caratteri), ed e' giusto: e'
              // cio' che si sta approvando. Ma misurato sulla board vera una
              // card sola arrivava a 871px, quasi una schermata, e otto card
              // facevano 4824px di colonna: per vedere la terza bisogna
              // scorrere oltre le prime due. Segnalato: «mostrare tutta la
              // risposta dell'AI senza troncarla, o magari mettere mostra di
              // piu' se davvero troppo alta».
              //
              // Non un `line-clamp` fisso: sotto le dieci righe non si ripiega
              // niente, perche' aprire un pieghevole per due righe e' attrito
              // senza guadagno. Il testo NON viene tagliato: e' tutto li',
              // basta un click - e chi ha ripiegato una card la ritrova
              // ripiegata, perche' lo stato vive per card.
              className={`text-xs leading-relaxed ${notesOfMachine ? 'text-app-text-muted' : 'text-app-text-heading'} ${COMPACT_MD_CLS} ${commentoAperto ? '' : 'line-clamp-[10]'}`}
              title={`${commentAuthorLabel(lastComment.author).label}: ${stripMarkdown(lastComment.content)}`}
            >
              {/* CHI PARLA, quando non e' una persona.
                  Una nota del sistema ha lo stesso aspetto del riassunto di una
                  consegna, e si legge come se fosse quello: «gli ultimi commenti
                  che devo da review non hanno senso, saranno messaggi di sistema».
                  Arriva qui solo quando e' l'UNICA voce del thread (vedi
                  `selectCardComments`), quindi il segno serve proprio nel caso in
                  cui non c'e' nient'altro con cui confrontarla. Anche il colore
                  scende a `muted`: e' contorno, non la parola della consegna. */}
              {/* IL CARTELLO «nessun riassunto» E' STATO TOLTO, e la ragione
                  e' la stessa per cui e' uscita la scheda di consegna: ripeteva
                  qualcosa che c'era gia'.

                  Visto a schermo (20/08, card 235afe11): una fascia ambra
                  MAIUSCOLA larga quanto la card che diceva «NESSUN RIASSUNTO
                  DELLA CONSEGNA: SOTTO C'E' SOLO LA CRONACA DELLA MACCHINA», e
                  subito sotto la cronaca stessa. Due righe per dire «quello che
                  segue non vale molto» prima di mostrarlo: piu' rumore di
                  quanto ne togliesse, su una card che ha gia' un titolo, un
                  chip di consegna e due bottoni.

                  L'informazione vera non manca — il dispatcher la scrive gia'
                  nel thread («Consegna senza riassunto: il turno e' finito
                  prima che l'agente commentasse»), con dentro anche il PERCHE',
                  che un cartello generico non ha. Quella nota e' `kind:
                  'service'`, quindi oggi la card la scarta: farla arrivare e'
                  il modo giusto di risolvere questo, e vale piu' di
                  un'etichetta che ripete il titolo di se' stessa.

                  Resta `latestIsPlumbing` in `cardComments.ts`: la decisione e'
                  giusta e provata, e serve a chi vorra' disegnarla meglio. Qui
                  si toglie solo il modo in cui la disegnavo io. */}
              {notesOfMachine && (
                <span
                  data-testid="card-comment-system-tag"
                  className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-1 py-px align-middle text-[10px] uppercase tracking-wide text-app-text-muted"
                ><Cpu className="h-2.5 w-2.5 shrink-0" /> {tr('board.card.systemNote')}</span>
              )}
              {/* IL RECINTO ```question NON ARRIVA MAI CRUDO AL MARKDOWN.
                  Qui ci finisce ogni parola che non e' «la domanda in fondo al
                  thread» (`pending`), e fra quelle c'e' anche una domanda che
                  i sottotask hanno gia' risolto: per il renderer ```…``` e' un
                  BLOCCO DI CODICE, quindi 300 caratteri di italiano diventavano
                  una riga sola con `overflow-x-auto`, da leggere scorrendo di
                  lato. Vedi `shared/question-prose.ts`. */}
              <ChatMarkdown components={{}}>{questionToProse(lastComment.content)}</ChatMarkdown>
            </div>
          ) : null}
          {/* Il pieghevole compare SOLO se c'e' davvero da ripiegare: la
              soglia guarda il testo, non l'altezza resa, perche' un'altezza
              misurata dopo il render farebbe saltare la card di un fotogramma.
              620 caratteri sono circa dieci righe nella colonna della board. */}
          {showsQuestion && !pending && lastComment && lastComment.content.length > COMMENTO_PIEGA_CHARS && (
            <button
              data-testid="card-comment-toggle"
              onClick={(e) => { e.stopPropagation(); setCommentoAperto((v) => !v); }}
              className="text-xs md:text-[10px] text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
            >
              {commentoAperto ? tr('board.card.commentLess') : tr('board.card.commentMore')}
            </button>
          )}
        </div>
      )}
      {/* THE AGENT'S PROGRESS NOTE on a card still in progress. The kickoff
          asks for a comment as soon as the work is framed, and the agent
          writes it; the card showed a stopwatch and the words stayed in the
          thread. Same clamp and fold as the review's word, no request pair:
          there is no answer to pair a request with yet. */}
      {task.status === 'in_progress' && showsQuestion && lastComment && (
        <div className="mt-2" data-testid="card-progress-word">
          <div
            className={`text-xs leading-relaxed text-app-text-heading ${COMPACT_MD_CLS} ${commentoAperto ? '' : 'line-clamp-[10]'}`}
            title={`${commentAuthorLabel(lastComment.author).label}: ${stripMarkdown(lastComment.content)}`}
          >
            <ChatMarkdown components={{}}>{questionToProse(lastComment.content)}</ChatMarkdown>
          </div>
          {lastComment.content.length > COMMENTO_PIEGA_CHARS && (
            <button
              data-testid="card-comment-toggle"
              onClick={(e) => { e.stopPropagation(); setCommentoAperto((v) => !v); }}
              className="text-xs md:text-[10px] text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
            >
              {commentoAperto ? tr('board.card.commentLess') : tr('board.card.commentMore')}
            </button>
          )}
        </div>
      )}
      {/* THE CARD'S FOOT: what is happening to the turn, and what it has cost
          so far. The same place in every column.
          ═══════════════════════════════════════════════════════════════════
          Dispatch state, model with time and tokens, git changes, last update:
          they are all measures OF THE TURN, and they were scattered. Two chips
          on top, the diff at the bottom, the date in two different spots
          depending on whether the card was in review. The same fact had to be
          hunted in a different place on every column.
          Here they stand together, at the end of the content and BEFORE the
          controls: the card reads top down (name, how it stands, what it asks)
          and closes with the measure of whoever is working it. The row is
          always there, because the last update always is: no state hides it. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="card-foot">
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
            title={tr('board.task.awaitingYouTitle')}
          >{tr('board.card.awaitingYou')}</span>
        ) : (live && task.dispatchState === 'working') ? null : task.queueReason ? (
          // Una card ferma in Todo dice PERCHÉ, e la ragione arriva già
          // scritta dal server. Vince sul chip di stato («in coda», «in
          // attesa»): sono la stessa informazione, ma quella è una parola
          // sola e uguale per sei motivi diversi.
          <QueueReasonChip reason={task.queueReason} />
        ) : (task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
          <DispatchChip state={task.dispatchState} error={task.dispatchError} deliveredBy={task.deliveredBy} hasWork={taskHasWork(task)} />
        ) : showsStoppedChip(task) ? (
          // Not on a done card: see `stoppedChip.ts`.
          <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300" title={task.dispatchError ?? undefined}>{tr('board.task.stopped')}</span>
        ) : null}
        {/* Il primo tratto del turno, quello in cui la card sembra ferma:
            l'agente sta leggendo e inquadrando, e il titolo che si sta per
            leggere è ancora quello buttato giù di fretta. Sta PRIMA del chip
            vivo perché è la fase, e il chip vivo è la misura. */}
        {live?.triage && !live.retry && task.dispatchState === 'working' && (
          <span
            data-testid="card-triage"
            title={tr('board.card.triageTitle')}
            className="shrink-0 whitespace-nowrap rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300"
          >{tr('board.card.triage')}</span>
        )}
        {/* THE WAIT BEFORE A RETRY takes the live chip's place. The turn is
            dead and the dispatcher is counting down; a stopwatch here was the
            board claiming work over a session that was not answering, on
            every card at once during a provider outage. */}
        {live?.retry && task.dispatchState === 'working' && (
          <RetryWaitChip retry={live.retry} disabled={busy} onRetryNow={() => steer(RETRY_NOW_MESSAGE)} />
        )}
        {live && !live.retry && task.dispatchState === 'working' ? (
          <LiveEffortChip usage={live} />
        ) : (task.model || task.agentMs > 0 || task.agentTokens > 0) ? (
          // The model always lives here, in the time/effort chip — never as a
          // second standalone chip. Before the agent has logged any time we
          // show just the model; once it runs we prepend it to the ⏱ effort,
          // matching the live chip (`Opus · ⏱ 2m · 1.2k tok`).
          <span
            // IL NUMERO E' QUANTO E' COSTATO, non quanti token sono passati.
            // `agentTokens` da solo lascia fuori la RILETTURA di cache, che e'
            // la quota dominante del consumo: il chip mostrava circa il 2,8%
            // del vero. La rilettura non vale nemmeno uno, pero': costa un
            // decimo, e sommarla intera farebbe sembrare enorme un turno che
            // e' stato economico. La regola sta in `shared/token-cost.ts`, e
            // la stessa la usano la dashboard e il piede di un messaggio.
            // «Quanto contesto e' passato» resta qui sotto, nel tooltip.
            title={(task.agentMs > 0 || costo > 0)
              ? tr('board.card.effortTitle', {
                work: fmtMs(task.agentMs),
                cost: costo ? tr('board.card.effortCost', { cost: costo.toLocaleString(locale) }) : '',
                spent: task.agentCostCents > 0 ? tr('board.card.effortSpent', { usd: fmtUsd(task.agentCostCents, locale) }) : '',
                cache: task.agentCacheReadTokens > 0
                  ? tr('board.card.effortCache', { context: fmtTok(contesto), cache: fmtTok(task.agentCacheReadTokens) })
                  : '',
                model: fmtModel(task.model),
              })
              : tr('board.card.modelTitle', { model: fmtModel(task.model) })}
            className="shrink-0 whitespace-nowrap rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-secondary"
          >{fmtModel(task.model)}{(task.agentMs > 0 || costo > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${costo > 0 ? ` · ${fmtTok(costo)}` : ''}`}{/* THE DOLLARS, when the card has a priced spend: the token figure is the
              cost-weighted volume, this is what it came to. */}{task.agentCostCents > 0 && <span data-testid="card-spend"> · {fmtUsd(task.agentCostCents, locale)}</span>}</span>
        ) : null}
        {/* THE GIT CHANGES, next to the model that is writing them.
            Closed it is a chip like the others; open it is a list that drops
            under it, not a surface that takes the whole card. The full diff
            stays in the task, where there is room to read it. */}
        {(deliveryStat !== null || gitLive) && (
          <DeliveryFiles
            projectId={task.projectId}
            taskId={task.id}
            files={deliveryStat}
            insertions={task.deliveryInsertions ?? 0}
            deletions={task.deliveryDeletions ?? 0}
            commit={task.deliveryCommit ?? null}
            live={gitLive}
          />
        )}
        {/* The last update closes the row, on the right: it is the weakest of
            the four measures and does not belong among the others. */}
        <span
          className="ml-auto text-xs md:text-[10px] text-app-text-muted"
          title={tr('board.card.lastUpdate', { when: new Date(task.updatedAt).toLocaleString(locale) })}
        >{fmtUpdatedAt(task.updatedAt)}</span>
      </div>
      {/* WHAT IT IS DOING RIGHT NOW: the tool the session is running and for
          how long. A 14-minute stopwatch did not tell a unit suite that has
          been running nine minutes from an agent that is stuck; the answer was
          in the chat, which is what the board was meant to spare. One line,
          under the measures, muted: a fact about the minute, not the card. */}
      {live?.lastTool && !live.retry && task.dispatchState === 'working' && (
        <LiveToolLine tool={live.lastTool} />
      )}
      {/* SET ASIDE, AND WHY. A parked card (failed, blocked, stopped, waited
          out) kept its reason in the chip's tooltip, invisible on touch, and
          offered no gesture: the way back was guessing that a drag to Todo
          restarts it. The reason is printed, and the choice row makes the
          same PATCH the drag makes. Stop on the CONTROLS only: the reason is
          part of the card, and the card is the button that opens the drawer. */}
      {choiceState === 'parked' && (
        <div className="mt-1.5 space-y-1.5">
          {task.dispatchError && (
            <p
              data-testid="card-dispatch-error"
              className="line-clamp-3 break-words text-xs md:text-[11px] leading-snug text-app-text-muted"
              title={task.dispatchError}
            >{task.dispatchError}</p>
          )}
          <div onClick={(e) => e.stopPropagation()}>
            <TaskChoiceRow task={task} disabled={busy} onDone={choiceDone} onError={choiceFailed} />
          </div>
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
              placeholder={tr('board.card.steerPlaceholder')}
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => steer(freeText)}
              title={tr('board.card.steerSendTitle')}
              className="flex shrink-0 items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
            <TaskChoiceMenu
              task={task} disabled={busy} onDone={choiceDone} onError={choiceFailed}
              ariaLabel={tr('board.card.turnActions')}
            />
          </div>
        </div>
      )}
      {/* The review's EXITS: the choices, and the field that says why. They
          sit below the card's foot because they are CONTROLS, and controls
          come after everything you read in order to decide. */}
      {task.status === 'review' && (
        <div className="mt-2 space-y-1.5">
          {replyOptions.length > 0 && (
            <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
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
          <div onClick={(e) => e.stopPropagation()}>
            <TaskChoiceRow
              task={task} disabled={busy}
              onDone={choiceDone} onError={choiceFailed}
              onNeedText={() => freeTextRef.current?.focus()}
              pendingText={() => freeText}
              onLanding={setLanding}
            />
          </div>
          {/* IL CAMPO DA' UN'INDICAZIONE ALLE SCELTE QUI SOPRA. Non ha un
              bottone suo, e non e' una mancanza: e' cio' che resta dopo aver
              tolto due doppioni.

              «Rimanda» se n'e' andato perche' chiamava `review('reject', testo)`
              — la stessa identica cosa di «Rimandalo avanti» due centimetri
              sopra, che da quando porta `pendingText` si prende pure lo stesso
              testo. «Nota» lo segue per una ragione diversa e piu' semplice: un
              commento che non risveglia nessuno non e' una decisione di review,
              e in una colonna dove OGNI cosa e' una decisione era l'unica voce
              che non faceva avanzare niente. Segnalato: «se uno vuole fare una
              nota lo mette il backlog».

              Il gesto quieto NON sparisce dal prodotto: vive nel drawer, dove
              si scrive per esteso e si vede il thread (`task-reply-quiet-note`).
              Qui la card resta quello che deve essere in review: un elenco di
              uscite, e una riga per dire perche'. */}
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              ref={freeTextRef}
              value={freeText} disabled={busy}
              onChange={(e) => setFreeText(e.target.value)}
              // Enter = the choice from the row above this text belongs to,
              // with the text inside. It is the same thing the button next to
              // it does, so the keyboard is not a second road: it is the same
              // one. Never a verdict (see `choiceForText`).
              onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); void primaryChoiceWithText(); } }}
              // `{sendBack}` va INTERPOLATO col nome vero del bottone qui
              // sopra: su una card che nessuno ha consegnato non si chiama
              // «Rimanda indietro» ma «Rimandalo avanti», e un placeholder che
              // nomina un bottone inesistente e' peggio di uno generico.
              placeholder={isAgentReview
                ? tr('board.task.replyPlaceholderShort', { sendBack: sendBackWord(sendBackDest(task), tr).label })
                : tr('board.card.commentPlaceholder')}
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
            />
            {/* L'INVIO SI VEDE. È la stessa azione del primo bottone qui sopra,
                con dentro la frase appena scritta: stessa icona, e il tooltip
                la nomina per esteso, così non c'è da indovinare dove va a
                finire quello che si sta scrivendo. Acceso solo con del testo
                dentro: senza, l'azione la offre già il bottone della riga. */}
            <button
              data-testid="card-reply-send"
              disabled={busy || !freeText.trim()}
              onClick={() => void primaryChoiceWithText()}
              title={primaChoice
                ? tr('board.card.replySendTitle', { action: primaChoice.label })
                : tr('board.card.steerSendTitle')}
              aria-label={primaChoice
                ? tr('board.card.replySendTitle', { action: primaChoice.label })
                : tr('board.card.steerSendTitle')}
              className="flex shrink-0 items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      )}
      {/* The land is QUEUED, not done. The band sits here, under the choices,
          because it is the answer to the button just pressed. It goes away by
          itself when the round closes well; when the merge is REFUSED it stays,
          with the reason, and the card is still here to try again. */}
      {landingBanda && (
        <div onClick={(e) => e.stopPropagation()}>
          <LandingNotice band={landingBanda} testId="card-landing" compact />
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
          {/* 16x16 (p-0.5 + h-3): under the 24px the repo gives itself, and
              the bounding box IS the target. `tap-expand` is safe here because
              the only thing to its left is the error text, not a command. */}
          <button
            aria-label={tr('board.task.closeError')}
            onClick={clearError}
            className="tap-expand shrink-0 rounded p-0.5 hover:bg-white/10 coarse:p-1.5"
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
            title={tr('board.task.openCardTitle')}
          ><ClipboardList className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.task.openCard')}</button>
          {/* Stesso testo che copia il bottone del drawer (`taskCopyText`):
              titolo + descrizione. Qui è a portata di tasto destro perché il
              gesto — «prendo questo task e lo incollo altrove» — parte quasi
              sempre dalla card, senza aprire niente. */}
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); void copyTask(); }}
            className={POPOVER_ITEM}
          ><Copy className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.card.copyTask')}</button>
          {canOpenSession && (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpenTopic!(task.assignedTopicId!); }}
              className={POPOVER_ITEM}
              title={tr('board.task.openSessionTitle')}
            ><MessageSquare className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.task.openSession')}</button>
          )}
          {sessionEnded && (
            <span
              className={`${POPOVER_ITEM} cursor-default text-app-text-faint`}
              title={tr('board.task.sessionGoneTitle')}
            ><MessageSquare className="h-3.5 w-3.5" /> {tr('board.task.sessionGone')}</span>
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
