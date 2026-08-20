/**
 * KanbanBoardPane — lean, Master-free task board (human surface).
 *
 * Rebuilt after the Master/Board subsystem was removed (42e92c1d): no Crown/lead,
 * no proposal cards, no autopilot. Five columns, drag between columns to change
 * status, a detail drawer with the comment thread, and a human review gate on the
 * Review column (approve → done / reject → in_progress). Talks only to the
 * project-scoped board API (client/src/lib/board.ts).
 */
import { useT } from '../../hooks/useT';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { PoliteKeyboardSensor, PoliteMouseSensor, PoliteTouchSensor } from './dndSensors';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AlertTriangle, Archive, Bot, Check, ChevronDown, ChevronRight, Search, Settings, Tag, Target, UploadCloud, X } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { Spinner } from '../Shared/Spinner';
import { getProvidersSnapshotState, subscribeProvidersSnapshot } from '../../lib/providersSnapshotStore';
import { currentTaskTarget, reflectTaskOpen, reflectTaskClose, subscribePopstateTask } from '../../lib/openTaskLink';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { useBoardFeed } from '../../hooks/useBoardFeed';
import {
  boardApi, boardIdForPath, isProjectlessId, showsLandingDebt, TASK_STATUSES, UNASSIGNED_PROJECT_ID,
  CLOSER_LABELS, KIND_LABELS, STATUS_LABEL,
  type BoardProjectRef, type BoardTask, type TaskStatus, type BoardSettings, type TaskLabel,
  type PublishProject, type DiffBundle,
} from '../../lib/board';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { GlobalCapControl } from './GlobalCapControl';
import { applyPendingWrites, groupByStatus, manualStatusTarget, planDrop, type DropPlan, type OrderScope } from '../../lib/boardOrder';
import { COLUMN_FLASH_MS, landedInColumn, statusSnapshot } from '../../lib/columnFlash';
import { useBoardMotion } from './useBoardMotion';
import { scrollDelta } from '../../lib/scrollDelta';
import { resolveProjectRefs, useBoardProjects } from '../../lib/boardProjectsStore';
import { ProjectPickerBody } from './ProjectPicker';
import { ProjectTaskCounts } from './atoms';
import { countsSummary, projectTaskCounts } from '../../lib/projectTaskCounts';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { Tooltip } from '../Shared/Tooltip';
import { homeTilde } from '../../lib/homeTilde';
import { UnifiedDiff } from './UnifiedDiff';
import { useConfirm } from '../../hooks/useConfirm';
import { CREATED_FLASH_MS, PRIORITY_DOT, PRIORITY_ORDER, PRIORITY_LABEL, type LiveUsage, type OpenTask } from './constants';
import { boardCollision } from './format';
import { FloatingTaskComposer } from './FloatingTaskComposer';
import { Column } from './Card';
import { taskActionErrorMessage } from './taskActionError';
import { taskActionWord } from './taskActionWords';
import { TaskDetail } from './TaskDetail';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import { GlobalOnlySettingsPanel } from './BoardSettingsSections';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { MISSIONS, type Mission } from '../../lib/missions';
import { useDevInstall } from '../../hooks/useDevInstall';

/** Identità stabile per «nessuna scrittura in volo»: una Map nuova a ogni render
 *  rifarebbe il memo che sovrappone le patch, e con lui tutte le colonne. */
const EMPTY_WRITES: ReadonlyMap<string, Partial<BoardTask>> = new Map();

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** Deep-link a task's bound agent tab into focus (wired to handleTopicClick). */
  onOpenTopic?: (topicId: string) => void;
  /**
   * Consegna una MISSIONE alla sessione laterale del progetto: apre la chat
   * accanto alla board e le mette il testo davanti. Restituisce il motivo per
   * cui non si è potuto fare, o `null` se è andata.
   *
   * Assente = niente missioni: la board generale non ha UN progetto di cui
   * parlare, e senza quello la sessione laterale non esiste.
   */
  onStartMission?: (mission: Mission) => string | null;
}

/**
 * LA CONSEGNA, IN UN CONTROLLO SOLO.
 *
 * Prima erano due bottoni adiacenti: «N non su main» (rosso) e «Pubblica M»
 * (ambra). Due numeri grandi, due colori d'allarme, la stessa frase implicita
 * — «c'è del lavoro che non è ancora arrivato dove deve» — e nessuno dei due
 * che dicesse in cosa differisce dall'altro. «14 non su main mi sembra uguale a
 * Pubblica» (Attilio, 13/08): letti da fuori erano lo stesso allarme scritto
 * due volte.
 *
 * Sono invece i DUE GRADINI della stessa scala, e adesso stanno nello stesso
 * pannello, in quest'ordine:
 *
 *   1. NON SU MAIN — task chiusi la cui consegna non risulta unita. Il lavoro
 *      esiste su un ramo e nessuno lo sta guardando. Si apre il task per
 *      landarlo, o per scoprire perché quel lavoro non c'è.
 *   2. SU MAIN, NON PUBBLICATO — commit che main ha e `origin` no. Qui il
 *      lavoro c'è, manca solo il push (e il deploy dove è configurato).
 *
 * Il bottone porta i due numeri con due glifi diversi, non due pastiglie nude:
 * il triangolo è un problema da guardare, la nuvola è un'azione da fare. E resta
 * SEMPRE in barra, anche a zero, perché «Pubblica» è anche il posto dove si va a
 * verificare che non ci sia niente da pubblicare.
 */
function DeliveryControl({ unlanded, onOpen }: { unlanded: BoardTask[]; onOpen: (id: string) => void }) {
  const tr = useT();
  const [projects, setProjects] = useState<PublishProject[] | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffBundle | 'loading' | 'error'>>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirm();
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
    const shown = p.commits.slice(0, 8);
    const more = p.commits.length > 8 ? p.commits.length - 8 : 0;
    const ok = await confirm({
      title: tr('board.publish.confirmTitle', { name: p.name }),
      confirmLabel: tr('board.publish.confirmLabel', { n: p.ahead }),
      body: (
        <div className="space-y-2">
          <p>{tr('board.publish.confirmBodyStart', { n: p.ahead })}<span className="font-mono">origin/{p.branch}</span>{tr('board.publish.confirmBodyEnd')}</p>
          <ul className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-[11px]">
            {shown.map((c) => (
              <li key={c.hash} className="truncate">• {c.subject} ({c.hash}, {c.author})</li>
            ))}
          </ul>
          {more > 0 && <p className="text-app-text-secondary">{tr('board.publish.andMore', { n: more })}</p>}
        </div>
      ),
    });
    if (!ok) return;
    setBusy(p.projectId); setMsg(null);
    try {
      const r = await boardApi.publish(p.projectId);
      setMsg(r.ok ? tr('board.publish.done', { name: p.name }) : `${p.name}: ${r.error ?? tr('board.publish.error')}`);
      refresh();
    } catch (e) { setMsg(`${p.name}: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };
  // Il tono del bottone segue il gradino più grave che ha qualcosa da dire: un
  // lavoro che non è su main è un problema (rosa), un commit da pubblicare è
  // un'azione pronta (ambra), niente dei due è riposo (neutro).
  const tone = unlanded.length > 0
    ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
    : total > 0
      ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
      : 'bg-white/10 text-app-text-secondary hover:bg-white/15';
  const title = [
    unlanded.length > 0 ? tr('board.delivery.unlandedTitle', { n: unlanded.length }) : null,
    total > 0 ? tr('board.delivery.toPublishTitle', { n: total }) : tr('board.delivery.nothingTitle'),
  ].filter(Boolean).join(' · ');
  return (
    <>
      <button
        ref={btnRef}
        data-testid="delivery-badge"
        onClick={() => { setOpen((s) => !s); refresh(); }}
        title={title}
        /* h-6 come i chip dei filtri: 24px è il minimo WCAG 2.2 AA per un
           bersaglio, ed è quanto una riga di 36px può dare. */
        className={`flex h-6 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${tone}`}
      >
        <span>{tr('board.toolbar.delivery')}</span>
        {unlanded.length > 0 && (
          <span data-testid="delivery-unlanded-count" className="flex items-center gap-0.5 rounded bg-rose-500/25 px-1 font-medium tabular-nums text-rose-200">
            <AlertTriangle className="h-3 w-3 shrink-0" />{unlanded.length}
          </span>
        )}
        {total > 0 && (
          <span data-testid="delivery-publish-count" className="flex items-center gap-0.5 rounded bg-amber-500/25 px-1 font-medium tabular-nums text-amber-200">
            <UploadCloud className="h-3 w-3 shrink-0" />{total}
          </span>
        )}
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} align="right" minWidth={384} className="max-h-[70vh] w-96 overflow-y-auto" unmanagedFocus>
          {/* GRADINO 1 — il lavoro che non è nemmeno arrivato su main. Sta in
              cima perché è l'unico dei due che segnala un GUASTO: un task
              chiuso il cui lavoro non risulta da nessuna parte. */}
          {unlanded.length > 0 && (
            <div className="border-b border-app-border pb-1">
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-rose-300/90">
                {tr('board.unlanded.title')}
              </div>
              {unlanded.map((t) => (
                <button
                  key={t.id}
                  data-testid="unlanded-item"
                  onClick={() => { setOpen(false); onOpen(t.id); }}
                  className={`${POPOVER_ITEM} !items-start`}
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[t.priority] ?? PRIORITY_DOT[2]}`} />
                  <span className="min-w-0 flex-1 truncate text-left">{t.text}</span>
                </button>
              ))}
              <p className="px-3 pb-1 pt-1 text-[11px] leading-snug text-app-text-muted">
                {tr('board.unlanded.blurb')}
              </p>
            </div>
          )}
          {/* GRADINO 2 — su main, ma non ancora fuori. */}
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.publish.toPublish')}</div>
          {/* COSA SUCCEDE DOPO IL PUSH, detto PRIMA del clic e non in un
              tooltip: su questo repo main e' spedito, quindi «Pubblica» non e'
              un salvataggio — fa uscire una release che arriva all'auto-updater
              di chiunque abbia Topics aperta. Chi preme sta decidendo una
              pubblicazione, e nessuna schermata gliela nominava: diceva solo
              quali commit sarebbero usciti.
              Compare solo quando c'e' qualcosa da pubblicare: su una lista
              vuota sarebbe un avviso su un gesto che nessuno sta per fare. */}
          {pending.length > 0 && (
            <p
              data-testid="publish-consequence"
              title={tr('board.publish.consequenceTitle')}
              /* amber-300/80 su tema chiaro dava 1,24:1 misurato sui pixel:
                 un avviso che non si legge non e' un avviso. Stessa taratura
                 dei segnali della status bar (amber-800 chiaro / amber-400
                 scuro, 6,04 e 11,52), che l'ha gia' pagata una volta. */
              className="px-3 pb-1 text-[11px] leading-snug text-amber-800 dark:text-amber-400"
            >
              {tr('board.publish.consequence')}
            </p>
          )}
          <div className="p-1 pt-0">
            {pending.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-app-text-muted">{tr('board.publish.nothing')}</div>
            ) : pending.map((p) => {
              const isOpen = expanded === p.projectId;
              return (
                <div key={p.projectId} className="rounded">
                  <div className="flex items-center gap-1.5 px-1 py-1 hover:bg-white/5">
                    <button
                      onClick={() => toggleExpand(p.projectId, isOpen)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={isOpen ? tr('board.unlanded.hide') : tr('board.unlanded.show')}
                    >
                      {isOpen ? <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" /> : <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />}
                      <span className="min-w-0 flex-1 truncate text-[12px] text-app-text">{p.name}<span className="ml-1 text-[11px] text-app-text-muted">{p.ahead} commit · {p.branch}</span></span>
                    </button>
                    <button disabled={busy === p.projectId} onClick={() => doPublish(p)} className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30 disabled:opacity-50">{busy === p.projectId ? '…' : 'Pubblica'}</button>
                  </div>
                  {isOpen && (
                    <ul className="mb-1 ml-4 space-y-0.5 border-l border-app-border pl-2">
                      {p.commits.map((c) => (
                        <li key={c.hash} className="flex items-baseline gap-1.5 text-[11px] leading-tight">
                          <code className="shrink-0 text-app-text-muted">{c.hash}</code>
                          <span className="min-w-0 flex-1 truncate text-app-text-heading" title={c.subject}>{c.subject}</span>
                          <span className="shrink-0 text-app-text-faint">{c.author} · {c.when}</span>
                        </li>
                      ))}
                      {p.commits.length >= 50 && <li className="text-[10px] text-app-text-faint">{tr('board.publish.truncated')}</li>}
                    </ul>
                  )}
                  {isOpen && (
                    <div className="mb-1.5 ml-4 border-l border-app-border pl-2">
                      <div className="mb-0.5 text-[9px] uppercase tracking-wide text-app-text-faint">{tr('board.publish.diffTitle')}</div>
                      {diffs[p.projectId] === 'loading' && <div className="text-[11px] text-app-text-muted">{tr('board.publish.loadingDiff')}</div>}
                      {diffs[p.projectId] === 'error' && <div className="text-[11px] text-red-400">{tr('board.publish.diffError')}</div>}
                      {diffs[p.projectId] && typeof diffs[p.projectId] === 'object' && (
                        <UnifiedDiff bundle={diffs[p.projectId] as DiffBundle} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {msg && <div className="mt-0.5 border-t border-app-border px-2 py-1.5 text-[11px] text-app-text-secondary">{msg}</div>}
          </div>
      </Menu>
    </>
  );
}

/**
 * LE CARTELLE DI LAVORO — il numero che diceva soltanto sé stesso.
 *
 * Era un `<span>` con dentro «7 worktree» e la spiegazione nel `title`: un
 * numero nudo in una barra non dice di cosa è, e «worktree» è una parola che
 * chi guarda la board non ha nessun motivo di conoscere. Qui diventa un
 * comando: l'etichetta dice la cosa in italiano, e il click apre l'unico posto
 * che risponde alle due domande vere — che cosa sono, e come si liberano.
 *
 * Dentro ci sta anche il GC («Pulisci landati») col suo esito, che prima erano
 * due elementi in più IN BARRA, sempre presenti, per un'azione che si fa una
 * volta ogni tanto. La barra ci guadagna lo spazio, e la spiegazione ci
 * guadagna il posto giusto: accanto al bottone che la mette in pratica.
 *
 * I due accumuli restano DUE numeri distinti, ed è il punto: un branch landato
 * libera la sua cartella, ma una cartella tenuta perché il task è ancora aperto
 * non ha nessun branch da landare. Con un numero solo non si capisce quale dei
 * due sta crescendo — ed è cresciuto in silenzio fino a ~40 cartelle il 21/07.
 */
function WorktreeControl({ count, branches, gcRunning, gcResult, onGc }: {
  count: number;
  branches: { total: number; orphan: number; onOpenTasks: number } | null;
  gcRunning: boolean;
  gcResult: string | null;
  onGc: () => void;
}) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  const orphan = branches?.orphan ?? 0;
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="worktree-count-badge"
        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${orphan > 0
          ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
          : 'bg-white/10 text-app-text-secondary hover:bg-white/20'}`}
      >{tr('board.worktree.count', { n: count })}{orphan > 0 && <span className="tabular-nums">{tr('board.worktree.orphanBranches', { n: orphan })}</span>}</button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={320}>
        <div className="space-y-1.5 px-3 py-2.5 text-[11px] leading-snug text-app-text-secondary">
          <p className="text-[12px] font-medium text-app-text-heading">{tr('board.worktree.countOpen', { n: count })}</p>
          <p>{tr('board.worktree.whatStart')}<span className="font-mono">git worktree</span>{tr('board.worktree.whatEnd')}</p>
          {branches && branches.total > 0 && (
            <p data-testid="worktree-branches-line">
              {tr('board.worktree.branchesStart')}<span className="text-app-text-heading">{tr('board.worktree.branchesCount', { n: branches.total })}</span>{tr('board.worktree.branchesMid')}
              {branches.orphan > 0 && <> <span className="text-amber-300">{branches.orphan}</span>{tr('board.worktree.branchesOrphan')}</>}
              {branches.onOpenTasks > 0 && <>{tr('board.worktree.branchesOpen', { n: branches.onOpenTasks })}</>}
            </p>
          )}
          <p className="text-app-text-muted">{tr('board.worktree.twoPiles')}</p>
        </div>
        <div className="flex items-center gap-2 border-t border-app-border px-3 py-2">
          <button
            onClick={onGc}
            disabled={gcRunning}
            className="shrink-0 rounded bg-white/10 px-2 py-1 text-[11px] text-app-text-secondary hover:bg-white/20 disabled:opacity-50"
            data-testid="worktree-gc-button"
          >{tr(gcRunning ? 'board.worktree.gcRunning' : 'board.worktree.gc')}</button>
          <span className="text-[10px] leading-snug text-app-text-muted">
            {tr('board.worktree.gcHint')}
          </span>
        </div>
        {gcResult && (
          <p className="border-t border-app-border px-3 py-1.5 text-[11px] leading-snug text-app-text-secondary" data-testid="worktree-gc-result">{gcResult}</p>
        )}
      </Menu>
    </>
  );
}

/**
 * IL CARICO, DETTO COME UNA FRASE.
 *
 * La versione precedente diceva «Carico critico · max 1», e nessuna delle due
 * metà si spiegava da sola: «carico critico» è un fatto sulla macchina che non
 * chiede niente a chi legge, e «max 1» sembra un LIMITE imposto mentre è un
 * CONSIGLIO — due cose molto diverse per chi le legge in una barra. La
 * spiegazione c'era, ma stava nel `title`: su un telefono non esiste, e col
 * mouse va cercata. Un tooltip non è una spiegazione.
 *
 * Quindi due regole:
 *
 * 1. **Compare solo quando c'è qualcosa da fare.** Il chip vive sullo SCARTO
 *    fra gli agent che stanno girando (`running`, dal dispatcher) e quelli che
 *    la macchina regge adesso (`recommended`). Scarto ≤ 0 → niente chip, anche
 *    con la macchina in ginocchio: se non c'è niente da fermare, un allarme è
 *    solo rumore. È anche il motivo per cui `running` è stato aggiunto alla
 *    capacità: senza, «max N» non poteva sapere se c'era uno scarto.
 * 2. **Quello che si vede è già l'azione, in due parole.** «Fermane 2», non un
 *    aggettivo e non una frase. La barra è una fila di controlli, non un posto
 *    dove si legge: «Macchina carica: meglio fermare 2 agent» erano trentotto
 *    caratteri che spingevano fuori i filtri dei progetti, e la parte che
 *    contava era il numero. Il verbo resta perché un numero da solo non dice
 *    cosa farne. Il dettaglio (CPU, core, perché) sta nel popover, apribile col
 *    dito, che dice anche che è un consiglio e non un tetto.
 *
 * La sonda (ogni 15s) è quella dello store del tetto globale, non una seconda
 * per chip: la stessa lettura serve il chip, il menu del titolo e il pannello
 * delle impostazioni.
 */
function LoadAdviceChip() {
  const tr = useT();
  const cap = useGlobalDispatchCap().capacity;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!cap) return null;
  const over = (cap.running ?? 0) - cap.recommended;
  if (over <= 0) return null; // niente da fermare → niente chip
  // La CPU che la FLOTTA sta bruciando è il segnale onesto (dispatch-capacity.ts):
  // il load average della macchina intera parla soprattutto delle app di chi sta
  // al computer, e usarlo qui coloravamo di rosso un Mac che sta benissimo.
  const oltreQuota = cap.oursCores != null && cap.budgetCores > 0 && cap.oursCores >= cap.budgetCores;
  const severe = oltreQuota || over >= 2 || (cap.oursCores == null && cap.cores > 0 && cap.load1 / cap.cores >= 1.3);
  const cls = severe
    ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/25'
    : 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/25';
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="load-advice-chip"
        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium ${cls}`}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {tr('board.load.stopN', { n: over })}
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288}>
        <div className="space-y-1.5 px-3 py-2.5 text-[11px] leading-snug text-app-text-secondary">
          <p className="text-[12px] font-medium text-app-text-heading">
            {tr('board.load.headline', { running: cap.running ?? 0, recommended: cap.recommended })}
          </p>
          {cap.oursCores != null ? (
            <p>
              {tr('board.load.cores', { ours: cap.oursCores.toFixed(1), budget: cap.budgetCores.toFixed(0), total: cap.cores })}
            </p>
          ) : (
            <p>{tr('board.load.loadAvg', { load: cap.load1.toFixed(1), cores: cap.cores })}</p>
          )}
          <p className="text-app-text-muted">{cap.reason}</p>
          <p>{tr('board.load.adviceStart')}<span className="text-app-text-heading">{tr('board.load.adviceWord')}</span>{tr('board.load.adviceEnd')}</p>
        </div>
      </Menu>
    </>
  );
}

/**
 * LE MISSIONI — l'unico comando che la board ha verso la sessione laterale.
 *
 * Tre cose, e sono tutte deliberate:
 *
 * 1. **Non è una superficie sulla board.** È un bottone che apre un menu e
 *    consegna il testo a una chat di progetto NORMALE, quella che c'è già. La
 *    versione precedente (5f39a2c1) faceva l'opposto — un chip dentro il
 *    composer, cioè dentro il punto da cui nasce ogni card, che cambiava il
 *    significato dell'intera riga — ed è il motivo per cui è stata bocciata.
 * 2. **Fuori dallo sviluppo non esiste** (`useDevInstall`): non è nascosto, non
 *    è disabilitato, non è renderizzato. Chi usa Topics per lavorare non deve
 *    trovarsi un pannello di governo della sua board.
 * 3. **La barra si legge PRIMA di scegliere** (`doneWhen` sotto ogni nome): è
 *    ciò che distingue una missione da un prompt, e metterla solo dentro il
 *    testo vorrebbe dire sceglierla senza sapere quando finisce.
 */
function MissionsMenu({ onStart }: { onStart: (m: Mission) => void }) {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="missions-button"
        title={tr('board.toolbar.missionsTitle')}
        className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${open ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/10'}`}
      ><Target className="h-3 w-3 shrink-0" /><span className="hidden sm:inline">{tr('board.toolbar.missions')}</span></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={330}>
        <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
          {tr('board.mission.toProject')}
        </div>
        {MISSIONS.map((m) => (
          <button
            key={m.id}
            data-testid={`mission-${m.id}`}
            onClick={() => { setOpen(false); onStart(m); }}
            className={`${POPOVER_ITEM} flex-col !items-start gap-0.5 py-1.5`}
          >
            <span className="font-medium text-app-text">{m.name}</span>
            <span className="text-[11px] leading-snug text-app-text-secondary">{m.summary}</span>
            <span className="text-[11px] leading-snug text-app-text-muted">{tr('board.mission.doneWhen', { what: m.doneWhen })}</span>
          </button>
        ))}
      </Menu>
    </>
  );
}

/** Machine-wide dispatch settings, reachable from EVERY board header (incl. the
 *  general board): the global auto-dispatch switch + the ONE concurrency cap
 *  enforced across ALL boards. The cap block is `GlobalCapControl`, the same
 *  component the board settings panel mounts: one store, one writer, and a
 *  change made here shows up there without a reload. Per-board overrides still
 *  live in the project board's ⚙ inline panel. */
function GlobalSettingsMenu() {
  const tr = useT();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [autoDispatch, setAutoDispatch] = useState<boolean | null>(null);
  const load = () => {
    boardApi.getGlobalDispatch().then(setAutoDispatch).catch(() => { /* keep last */ });
  };
  const toggleAuto = async (v: boolean) => {
    setAutoDispatch(v);
    try { await boardApi.setGlobalDispatch(v); } catch { load(); }
  };
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        title={tr('board.dispatchSettings')}
        className={`-ml-1 flex items-center bg-transparent p-0 ${open ? 'text-app-text' : 'text-app-text-muted hover:text-app-text-heading'}`}
      ><ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={288} unmanagedFocus>
        <div className="space-y-2.5 px-3 py-2.5 text-xs text-app-text-heading">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.dispatch.allBoards')}</p>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5 text-app-text-secondary" /> {tr('board.settings.autoDispatch')}</span>
            <input type="checkbox" checked={!!autoDispatch} onChange={(e) => toggleAuto(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
          </label>
          <div className="border-t border-app-border-subtle pt-2">
            <GlobalCapControl />
          </div>
        </div>
      </Menu>
    </>
  );
}

interface BoardFilters {
  priority: number[]; assignedTo: string[]; text: string; projectId: string[]; labels: TaskLabel[];
}

interface FilterPanelProps {
  filters: BoardFilters;
  onFiltersChange: (filters: BoardFilters) => void;
  tasks: readonly BoardTask[];
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
      className={POPOVER_ITEM}
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
  const tr = useT();
  const prioBtnRef = useRef<HTMLButtonElement>(null);
  const asgBtnRef = useRef<HTMLButtonElement>(null);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const [prioOpen, setPrioOpen] = useState(false);
  const [asgOpen, setAsgOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const lblBtnRef = useRef<HTMLButtonElement>(null);
  const [lblOpen, setLblOpen] = useState(false);

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
  const toggleLabel = (l: TaskLabel) => {
    const updated = filters.labels.includes(l) ? filters.labels.filter((x) => x !== l) : [...filters.labels, l];
    onFiltersChange({ ...filters, labels: updated });
  };
  const reset = () => onFiltersChange({ priority: [], assignedTo: [], text: '', projectId: [], labels: [] });

  const assignees = Array.from(new Set(tasks.map((t) => t.assignedTo).filter(Boolean) as string[])).sort();

  // ── Progetto: LO STESSO selettore del composer ────────────────────────────
  // Prima questo filtro era un widget a parte che dell'indice progetti non
  // sapeva nulla: niente ricerca, niente icone, e come nome l'id della board
  // con l'hash tagliato via (`topics-app-4f2c` → «topics-app»), che assomiglia
  // al nome vero ma non lo è. Ora la lista passa per `resolveProjectRefs`, che
  // risolve nome e `path` — e senza `path` non c'è icona — dallo stesso indice
  // che alimenta il chip del composer e il «Sposta su…» del drawer.
  const projectIndex = useBoardProjects(mode === 'all');
  const taskProjectIds = useMemo(() => Array.from(new Set(tasks.map((t) => t.projectId))), [tasks]);
  // I task «senza progetto» sono di DUE specie (`_none` e la board catch-all
  // `generale-<hash>`), ma per chi filtra sono una cosa sola: una riga, che
  // accende e spegne entrambi gli id.
  const projectlessIds = useMemo(() => taskProjectIds.filter(isProjectlessId), [taskProjectIds]);
  // Quanti task, e in che stato. Il nome da solo non dice se quel progetto stia
  // aspettando qualcuno o non abbia niente di aperto, ed è la domanda che si fa
  // chi guarda una board generale con dodici progetti.
  const projectCounts = useMemo(
    () => projectTaskCounts(tasks, (t) => (isProjectlessId(t.projectId) ? UNASSIGNED_PROJECT_ID : t.projectId)),
    [tasks],
  );
  /**
   * Il contenuto del tooltip di un filtro. Prima era una riga sola dentro un
   * `title=` nativo: il sistema operativo la mostrava dopo un secondo abbondante
   * e senza struttura. Segnalato: «passando sui filtri dovrebbe dare un minimo
   * di informazioni sul progetto, magari anche la location».
   *
   * Tre cose, in ordine di quanto servono: il NOME (che nel chip è troncato a
   * 13rem), DOVE STA su disco (l'unica cosa che distingue due progetti chiamati
   * uguale in cartelle diverse), e come stanno i task.
   */
  const countsTitle = (p: BoardProjectRef) => {
    const c = projectCounts[p.projectId];
    return (
      <div className="space-y-1">
        <div className="font-medium">{p.name}</div>
        {p.path ? (
          // Monospazio e a capo sul percorso: un path lungo su una riga sola
          // diventa illeggibile, ed è proprio il dato che si viene a cercare.
          <div className="break-all font-mono text-[10px] text-app-text-muted">{homeTilde(p.path)}</div>
        ) : (
          // Perché non c'è: senza questa riga il tooltip di un progetto sparito
          // sembra solo un tooltip a cui manca un pezzo.
          <div className="text-[10px] text-app-text-faint">{tr('board.filter.projectUnknown')}</div>
        )}
        {c && <div className="text-[10px] text-app-text-muted">{countsSummary(c, STATUS_LABEL)}</div>}
      </div>
    );
  };
  const projectOptions = useMemo(() => {
    const refs = resolveProjectRefs(taskProjectIds.filter((id) => !isProjectlessId(id)), projectIndex);
    return projectlessIds.length
      ? [{ projectId: UNASSIGNED_PROJECT_ID, name: 'Senza progetto', path: '' }, ...refs]
      : refs;
  }, [taskProjectIds, projectlessIds, projectIndex]);
  const showProjects = mode === 'all' && projectOptions.length > 0;
  // Gli id che la riga «Senza progetto» rappresenta davvero.
  const idsFor = (p: BoardProjectRef) =>
    (p.projectId === UNASSIGNED_PROJECT_ID && projectlessIds.length ? projectlessIds : [p.projectId]);
  const selectedProjectIds = useMemo(() => {
    const sel = new Set(filters.projectId);
    // La riga sintetica si accende se è acceso uno QUALSIASI dei suoi id.
    if (projectlessIds.some((id) => sel.has(id))) sel.add(UNASSIGNED_PROJECT_ID);
    return Array.from(sel);
  }, [filters.projectId, projectlessIds]);
  const toggleProject = (p: BoardProjectRef) => {
    const ids = idsFor(p);
    const on = ids.some((id) => filters.projectId.includes(id));
    const updated = on
      ? filters.projectId.filter((x) => !ids.includes(x))
      : [...filters.projectId, ...ids.filter((id) => !filters.projectId.includes(id))];
    onFiltersChange({ ...filters, projectId: updated });
  };
  // Le RIGHE accese (non gli id: «Senza progetto» ne rappresenta due). Un solo
  // progetto filtrato → il chip lo MOSTRA (icona + nome), invece di dire
  // «Progetto ·1» e costringere ad aprire il menu per sapere quale.
  const pickedProjects = useMemo(
    () => projectOptions.filter((p) => selectedProjectIds.includes(p.projectId)),
    [projectOptions, selectedProjectIds],
  );
  const soleProject = pickedProjects.length === 1 ? pickedProjects[0]! : null;

  const anyActive = filters.priority.length + filters.assignedTo.length + filters.projectId.length + filters.labels.length + (filters.text ? 1 : 0) > 0;

  // ── I PROGETTI NELLO SPAZIO CHE AVANZA ────────────────────────────────────
  //
  // Il menu resta la porta canonica (ha la ricerca, e regge cento progetti),
  // ma finché nella riga c'è larghezza libera i progetti stanno FUORI, come
  // filtri a un click. La regola è che la barra non si deforma mai per farceli
  // stare: niente a capo (spingerebbe giù la board), niente compressione fino
  // all'illeggibile. Chi non entra torna dietro il chip «Progetto».
  //
  // Il conto si fa sulla geometria vera, non su una stima di caratteri: i chip
  // sono TUTTI renderizzati in una riga `nowrap` dentro un contenitore che
  // occupa lo spazio residuo, e quelli il cui bordo destro cade oltre il bordo
  // del contenitore diventano `invisible`. Due proprietà, ed è per questo che
  // il modo è questo:
  //   · `visibility:hidden` tiene la posizione, quindi le misure dei chip
  //     precedenti non cambiano quando l'ultimo sparisce — nessun ciclo in cui
  //     nascondere un chip libera lo spazio che lo rifà comparire.
  //   · il contenitore ha `min-w-0` + `overflow-hidden`, quindi la sua larghezza
  //     MINIMA è zero: quando la riga è affollata collassa a 0, nessun chip
  //     entra, e non allarga la barra di un pixel. È lo stesso motivo per cui
  //     un chip a metà non si vede mai: sotto il taglio è invisibile, non
  //     tagliato.
  //   · la riga dei chip è ASSOLUTA (`w-max`), e questo non è un dettaglio di
  //     stile: un figlio in flusso con `basis-0` contribuisce lo stesso la sua
  //     larghezza MAX-CONTENT al calcolo intrinseco del genitore, e il genitore
  //     qui sta dentro una barra che scorre. Misurato: con la riga in flusso, a
  //     1000px la barra eccedeva di 243px — cioè i chip si prendevano lo spazio
  //     invece di aspettare quello che avanza, ed è esattamente il difetto che
  //     questa striscia esiste per non avere. Fuori flusso contribuisce zero, e
  //     la striscia riceve SOLO ciò che resta.
  const stripRef = useRef<HTMLDivElement>(null);
  const stripRowRef = useRef<HTMLDivElement>(null);
  const [inlineProjects, setInlineProjects] = useState(0);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!showProjects || !strip) { setInlineProjects(0); return; }
    const measure = () => {
      const row = stripRowRef.current;
      if (!row) return;
      const avail = strip.clientWidth;
      let fit = 0;
      // I CHIP, non i figli della riga. Da quando ogni chip è avvolto nel
      // `Tooltip`, i figli diretti sono wrapper `display: contents`: per il
      // layout non esistono (ed è il motivo per cui si usa `contents`), ma nel
      // DOM ci sono e hanno `offsetWidth` ZERO. La misura li vedeva larghi
      // nulla, concludeva che ci stavano tutti, e i chip in eccesso finivano
      // oltre il bordo destro invece che dentro il menu. `querySelectorAll`
      // sul testid salta i wrapper e misura ciò che si vede davvero.
      for (const chipEl of Array.from(row.querySelectorAll<HTMLElement>('[data-testid^="project-filter-chip-"]'))) {
        // +0.5: le larghezze sono frazionarie, e un mezzo pixel di
        // arrotondamento non è un chip che non ci sta.
        if (chipEl.offsetLeft + chipEl.offsetWidth <= avail + 0.5) fit++;
        else break;
      }
      setInlineProjects((n) => (n === fit ? n : fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    ro.observe(stripRowRef.current!);
    return () => ro.disconnect();
  }, [showProjects, projectOptions]);

  // Same chip look the composer uses for its model/priority/project pickers.
  // Explicit h-6 (not py-*) so the search <input> — which renders taller from
  // its UA line-height — sits at the exact same height as these buttons.
  const chip = (active: boolean) =>
    `flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${
      active ? 'bg-black/15 text-app-text dark:bg-white/15' : 'bg-black/5 text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
    }`;
  const menuHeader = 'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted';

  return (
    /* `grow` e NON `flex-1`: la riga dei filtri deve arrivare fino al gruppo di
       destra quando c'è spazio, ma la sua base resta il CONTENUTO. Con
       `flex-1` (base 0) una barra affollata la calcolava larga zero e i suoi
       stessi chip finivano a disegnarsi sopra i comandi accanto — la striscia
       dei progetti si guadagnava lo spazio togliendolo ai filtri veri. */
    <div className="flex min-w-0 grow items-center gap-1.5">
      {/* Search — always visible */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-app-text-secondary" />
        <input
          value={filters.text}
          onChange={(e) => onFiltersChange({ ...filters, text: e.target.value })}
          placeholder={tr('board.filter.searchPlaceholder')}
          aria-label={tr('board.filter.searchLabel')}
          className="h-6 w-28 rounded-md bg-black/5 pl-6 pr-1.5 text-[11px] leading-none text-app-text outline-none placeholder:text-app-placeholder focus:bg-black/10 dark:bg-white/5 dark:focus:bg-white/10 sm:w-40"
        />
      </div>

      {/* Priority — chip + Menu (multi-select, no "auto") */}
      <button ref={prioBtnRef} onClick={() => setPrioOpen(true)} title={tr('board.filter.priorityTitle')} className={chip(filters.priority.length > 0)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-app-text-faint" />
        {tr('board.task.priority')}{filters.priority.length > 0 && <span className="tabular-nums text-app-text-secondary">·{filters.priority.length}</span>}
        <ChevronDown className="h-3 w-3 text-app-text-muted" />
      </button>
      <Menu open={prioOpen} anchorRef={prioBtnRef} onClose={() => setPrioOpen(false)} minWidth={170} role="listbox">
        <p className={menuHeader}>{tr('board.task.priority')}</p>
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
          <button ref={asgBtnRef} onClick={() => setAsgOpen(true)} title={tr('board.filter.assigneeTitle')} className={chip(filters.assignedTo.length > 0)}>
            Assegnatario{filters.assignedTo.length > 0 && <span className="tabular-nums text-app-text-secondary">·{filters.assignedTo.length}</span>}
            <ChevronDown className="h-3 w-3 text-app-text-muted" />
          </button>
          <Menu open={asgOpen} anchorRef={asgBtnRef} onClose={() => setAsgOpen(false)} minWidth={170} role="listbox">
            <p className={menuHeader}>{tr('board.filter.assignee')}</p>
            {assignees.map((a) => (
              <FilterOption key={a} selected={filters.assignedTo.includes(a)} onClick={() => toggleAssignedTo(a)} label={`@${a}`} />
            ))}
          </Menu>
        </>
      )}

      {/* Progetto — chip + LO STESSO ProjectPickerBody del composer, in
          modalità multi-selezione: il menu non si chiude a ogni clic perché un
          filtro si costruisce a più scelte. */}
      {showProjects && (
        <>
          <button
            ref={projBtnRef} onClick={() => setProjOpen(true)}
            data-testid="filter-project-chip"
            title={soleProject ? tr('board.filter.projectNamed', { name: soleProject.name }) : tr('board.filter.projectTitle')}
            className={`${chip(filters.projectId.length > 0)} min-w-0 max-w-[11rem]`}
          >
            {soleProject && <ProjectFavicon path={soleProject.path} size={12} />}
            <span className="min-w-0 truncate">{soleProject ? soleProject.name : tr('common.project')}</span>
            {!soleProject && pickedProjects.length > 0 && (
              <span className="tabular-nums text-app-text-secondary">·{pickedProjects.length}</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
          </button>
          <Menu open={projOpen} anchorRef={projBtnRef} onClose={() => setProjOpen(false)} minWidth={230} role="listbox" unmanagedFocus>
            <ProjectPickerBody
              projects={projectOptions}
              selectedIds={selectedProjectIds}
              onPick={toggleProject}
              busy={false}
              listLabel={tr('common.project')}
              counts={projectCounts}
            />
          </Menu>
        </>
      )}

      {/* Etichette — chip + Menu. Il caso d'uso che le ha fatte nascere si
          compone qui: «visibile» acceso mentre si guarda la colonna Review è
          esattamente la lista che un umano deve guardare. */}
      <button
        ref={lblBtnRef} onClick={() => setLblOpen(true)}
        data-testid="filter-labels-chip"
        title={tr('board.filter.labelsTitle')}
        className={chip(filters.labels.length > 0)}
      >
        <Tag className="h-3 w-3 shrink-0" />
        {filters.labels.length === 1 ? filters.labels[0] : tr('board.filter.labels')}
        {filters.labels.length > 1 && <span className="tabular-nums text-app-text-secondary">·{filters.labels.length}</span>}
        <ChevronDown className="h-3 w-3 text-app-text-muted" />
      </button>
      <Menu open={lblOpen} anchorRef={lblBtnRef} onClose={() => setLblOpen(false)} minWidth={200} role="listbox">
        <p className={menuHeader}>{tr('board.filter.whoCloses')}</p>
        {CLOSER_LABELS.map((l) => (
          <FilterOption
            key={l} selected={filters.labels.includes(l)} onClick={() => toggleLabel(l)} label={l}
            title={l === 'visibile'
              ? tr('board.filter.labelVisibleTitle')
              : l === 'decisione'
                ? tr('board.filter.labelDecisionTitle')
                : tr('board.filter.labelInvisibleTitle')}
          />
        ))}
        <p className={menuHeader}>{tr('board.filter.kind')}</p>
        {KIND_LABELS.map((l) => (
          <FilterOption key={l} selected={filters.labels.includes(l)} onClick={() => toggleLabel(l)} label={l} />
        ))}
      </Menu>

      {/* Reset — only when something is active */}
      {anyActive && (
        <button onClick={reset} title={tr('board.filter.reset')} className="rounded p-0.5 text-app-text-muted hover:bg-white/10 hover:text-app-text">
          <X className="h-3 w-3" />
        </button>
      )}

      {/* I PROGETTI NELLO SPAZIO CHE AVANZA — vedi `useLayoutEffect` sopra. */}
      {showProjects && (
        <div ref={stripRef} className="relative ml-1.5 h-6 min-w-0 grow basis-0 overflow-hidden" data-testid="project-filter-strip">
          <div ref={stripRowRef} className="absolute inset-y-0 left-0 flex w-max flex-nowrap items-center gap-1.5 [&>*]:shrink-0">
            {projectOptions.map((p, i) => {
              const on = selectedProjectIds.includes(p.projectId);
              const shown = i < inlineProjects;
              return (
                // Il `key` sta sul Tooltip: è lui il figlio della lista ora.
                <Tooltip key={p.projectId} content={countsTitle(p)}>
                <button
                  onClick={() => toggleProject(p)}
                  aria-hidden={!shown}
                  tabIndex={shown ? 0 : -1}
                  data-testid={`project-filter-chip-${p.projectId}`}
                  className={`${chip(on)} max-w-[13rem] ${shown ? '' : 'invisible'}`}
                >
                  {p.path ? <ProjectFavicon path={p.path} size={12} /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-app-text-faint" />}
                  <span className="min-w-0 truncate">{p.name}</span>
                  {projectCounts[p.projectId] && <ProjectTaskCounts counts={projectCounts[p.projectId]!} />}
                  {on && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function KanbanBoardPane({ projectPath, global = false, onMessage, onOpenTopic, onStartMission }: Props) {
  const tr = useT();
  const projectId = useMemo(() => (projectPath ? boardIdForPath(projectPath) : ''), [projectPath]);
  // The project/all toggle only makes sense inside a project window. The global
  // pane has no project, so it locks to 'all'.
  const canToggle = !!projectPath && !global;
  // La scheda del task esiste sempre; la SESSIONE dell'agente no. Risolto una
  // volta qui e distribuito già deciso a card e drawer, così nessuno dei due
  // deve iscriversi all'indice dei topic. Vedi `lib/taskSession.ts`.
  const resolveSession = useTaskSessionResolver();
  // Per-board dispatch settings only exist for a single project (the global board
  // aggregates many), so the gear only shows inside a project window.
  const hasProject = !!projectPath && !global;
  // Le missioni sono una superficie interna: esistono solo in un'installazione
  // di sviluppo, e solo dentro un progetto (la board generale non ha UNA
  // sessione laterale di cui parlare).
  const devInstall = useDevInstall();
  const canRunMissions = hasProject && devInstall && !!onStartMission;
  // 'project' = this project only · 'all' = the global cross-project board.
  const [mode, setMode] = useState<'project' | 'all'>(canToggle ? 'project' : 'all');
  const [error, setError] = useState<string | null>(null);
  // L'errore di UNA card sta sulla card, non nella barra qui sopra: quella vive
  // in cima al pannello, mentre la card che ha rifiutato il click può essere
  // dieci righe più giù in una colonna scrollata. Ne teniamo uno solo, l'ultimo:
  // due card non falliscono nello stesso istante, e un errore per card che non
  // scade mai diventerebbe arredamento.
  const [cardError, setCardError] = useState<{ taskId: string; message: string } | null>(null);
  const onCardError = useCallback((taskId: string, message: string | null) => {
    setCardError((prev) => (message ? { taskId, message } : prev?.taskId === taskId ? null : prev));
  }, []);
  // A move that did NOT land where it was aimed says so here. Not an error
  // (nothing failed) and not a toast (it belongs to the board it happened on):
  // one line under the toolbar.
  //
  // It is cleared when the NEXT gesture starts, not when the next one ends: a
  // drag that gets cancelled, or lands on a card that vanished under the
  // fingers, used to leave the previous drop's blue line on screen explaining a
  // move that was no longer the last one. And it is cleared again if the write
  // fails, because by then the line claims a destination the card never
  // reached, right next to the red error saying so.
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Quale tab del task mettere davanti all'apertura, quando ad aprirlo è stato
  // un gesto mirato (il bottone «apri in una tab» sull'anteprima della card).
  // Si azzera a ogni altra apertura: vale per QUEL click, non è uno stato.
  const [pendingPaneId, setPendingPaneId] = useState<string | null>(null);
  const openTask = useCallback<OpenTask>((id, focusPaneId) => {
    setSelectedId(id);
    setPendingPaneId(focusPaneId ?? null);
  }, []);
  const columnsScrollRef = useRef<HTMLDivElement>(null);
  // Mobile-only affordance: the toolbar strip below scrolls horizontally with
  // a hidden scrollbar, so without a visible cue the actions past the right
  // edge are only discoverable by swiping blind. Tracks live scroll position
  // to fade out once the strip reaches its end.
  const toolbarScrollRef = useRef<HTMLDivElement>(null);
  const [toolbarOverflowRight, setToolbarOverflowRight] = useState(false);
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
    /** Etichette in AND — «solo le visibili in review» è questo più la colonna. */
    labels: TaskLabel[];
  }
  const storageKey = `board:filters-${mode === 'all' ? 'all' : projectId}`;
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      // `labels` è arrivato dopo: un filtro salvato da una versione precedente
      // non ce l'ha, e senza il default `filters.labels.length` esploderebbe al
      // primo render su ogni board già usata.
      const parsed = stored ? JSON.parse(stored) : null;
      return { priority: [], assignedTo: [], text: '', projectId: [], labels: [], ...(parsed ?? {}) };
    } catch { return { priority: [], assignedTo: [], text: '', projectId: [], labels: [] }; }
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

  // L'ARCHIVIO È UNA VISTA, non una colonna: stessa board, stesse colonne, ma
  // popolate da `?archived=1`. Sta nello stato della pane e non nei `filters`
  // perché non è un filtro sull'insieme già scaricato — è un'altra fetch, ed è
  // l'unico modo di rivedere una card archiviata (prima non ce n'era nessuno).
  // Solo su una board di progetto: il feed globale è `listAll`, che di archivio
  // non parla.
  const [showArchived, setShowArchived] = useState(false);
  // Le righe non le legge più questa pane: le legge `useBoardFeed`, che in
  // modalità 'all' NON fetcha affatto (il feed globale ha già un proprietario,
  // `useGlobalBoard`) e in modalità progetto raffredda la raffica e scarta le
  // risposte superate. Vedi l'intestazione dell'hook per i numeri.
  const {
    tasks: feedTasks, loading, refetch, patchTask, beginDrag, endDrag, flushDeferredRead,
  } = useBoardFeed({ mode, projectId, showArchived, onError: setError });

  // LE SCRITTURE ANCORA IN VOLO, sopra qualunque lista atterri.
  //
  // La lettura parcheggiata durante il drag riparte solo quando la PATCH ha
  // risposto (vedi `dropTo`), ma non è l'unica lettura possibile: un evento WS
  // di un altro client, un ritorno di visibilità, o il proprietario del feed
  // globale che risponde a qualcun altro possono far atterrare una lista NEL
  // MEZZO della scrittura. Quella lista è vecchia di un drop, e senza questo
  // strato la card tornerebbe indietro fino alla lettura successiva.
  // Le voci si tolgono quando la PATCH ha finito: da lì in poi il server sa.
  const [pendingWrites, setPendingWrites] = useState<ReadonlyMap<string, Partial<BoardTask>>>(EMPTY_WRITES);
  const tasks = useMemo(() => applyPendingWrites(feedTasks, pendingWrites), [feedTasks, pendingWrites]);

  // ── Un task appena NATO ────────────────────────────────────────────────────
  // Scrivevi nel composer, quello si svuotava, e la card atterrava in fondo a
  // una colonna che spesso non stavi guardando: nessun modo di sapere QUALE
  // card fosse, né se ce ne fosse una. Due segnali distinti, e apposta con due
  // regole diverse:
  //
  //  · il LAMPO risponde a «è nato un task»: vale per chiunque l'abbia creato,
  //    quindi la sorgente è l'evento WS `task:created` — anche quando arriva da
  //    un agent o dall'MCP, su un'altra macchina.
  //  · lo SCORRIMENTO risponde a «l'ho appena scritto io»: muove la board sotto
  //    gli occhi di chi guarda, e farlo per una creazione altrui vorrebbe dire
  //    strappargli via la colonna che stava leggendo. Quindi lo arma SOLO il
  //    ritorno della POST fatta da questo client, mai il broadcast.
  //
  // Il broadcast torna indietro anche a chi ha creato: `flashCreated` è
  // idempotente finché il lampo è acceso, così l'eco non riarma il timer e non
  // allunga la durata.
  const [justCreated, setJustCreated] = useState<Set<string>>(() => new Set());
  const createdFlashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flashCreated = useCallback((id: string) => {
    if (createdFlashTimers.current.has(id)) return; // già acceso: non riarmare
    setJustCreated((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    createdFlashTimers.current.set(id, setTimeout(() => {
      createdFlashTimers.current.delete(id);
      setJustCreated((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, CREATED_FLASH_MS));
  }, []);
  // Smontando la pane a lampo acceso i timer resterebbero appesi a chiamare un
  // setState su un componente che non c'è più.
  useEffect(() => {
    const timers = createdFlashTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);
  /** La card che questo client vuole vedere: creata QUI, non ancora inquadrata. */
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  /** Spegne la sorveglianza «la card resta fuori dal composer» (vedi sotto). */
  const keepClearRef = useRef<(() => void) | null>(null);
  useEffect(() => () => keepClearRef.current?.(), []);
  /** Creazione partita da questa finestra: lampo + la board ci va sopra. */
  const onCreatedHere = useCallback((taskId?: string) => {
    if (taskId) { flashCreated(taskId); setScrollTarget(taskId); }
    refetch();
  }, [flashCreated, refetch]);

  // Live updates. In 'all' mode any task event is relevant; in 'project' mode
  // only events for this project (or project-less broadcasts) trigger a refetch.
  // board:settings keeps the header pill honest when another client toggles it.
  //
  // Che il refetch sia una raffica sola, che la risposta superata non vinca e
  // che le righe restino ferme mentre una card è in mano lo garantisce
  // `useBoardFeed`: qui si dice solo QUANDO rileggere.
  // Live per-turn usage (model · execution-time · tokens) keyed by task id,
  // fed by `task:usage-live` and dropped when the turn ends. Drives the ticking
  // chip on working cards; the persisted agent_ms/agent_tokens take over after.
  const [liveUsage, setLiveUsage] = useState<Map<string, LiveUsage>>(new Map());
  // «Questo task aspetta TE», mentre il turno e' ancora vivo: un pannello di
  // domanda o un permesso aperti a meta' turno. Transitorio come liveUsage, e
  // per una ragione in piu': l'attesa vive nelle mappe in memoria del server, e
  // a server riavviato NON esiste piu'. Persisterla in dispatch_state la farebbe
  // sopravvivere a cio' che la sostiene — ed e' gia' costata un task congelato.
  const [awaitingHuman, setAwaitingHuman] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string; settings?: BoardSettings; autoDispatch?: boolean; task?: BoardTask;
        taskId?: string; turnStartedAt?: number; baseMs?: number; liveTokens?: number; model?: string | null;
        triage?: boolean; waiting?: boolean };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        if (mode === 'all' || m.projectId === undefined || m.projectId === projectId) refetch();
        // Il lampo è il segnale «è nato un task», e non ha un autore
        // privilegiato: qui passano anche le creazioni remote (agent, MCP, un
        // altro device), che sono proprio quelle che altrimenti comparirebbero
        // in silenzio. L'eco della propria POST rientra da qui ed è innocua.
        if (m.type === 'task:created' && typeof m.task?.id === 'string'
          && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
          flashCreated(m.task.id);
        }
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
          n.set(m.taskId!, { turnStartedAt: m.turnStartedAt ?? Date.now(), baseMs: m.baseMs ?? 0, liveTokens: m.liveTokens ?? 0, model: m.model ?? null, triage: m.triage === true });
          return n;
        });
      }
      if (m.type === 'task:awaiting-human' && typeof m.taskId === 'string'
        && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
        setAwaitingHuman((prev) => {
          const has = prev.has(m.taskId!);
          if (m.waiting === has) return prev; // nessun cambio: niente re-render
          const n = new Set(prev);
          if (m.waiting) n.add(m.taskId!); else n.delete(m.taskId!);
          return n;
        });
      }
      if (m.type === 'board:settings' && m.projectId === projectId && m.settings) setSettings(m.settings);
      // Global switch flipped anywhere (any board, any client) → this pill too.
      // E anche le CARD: da quando ognuna porta la ragione per cui è ferma
      // (`queueReason`, risolta dal server), l'interruttore è un ingrediente di
      // quella frase. Senza il refetch le card resterebbero a «ferma · dispatch
      // spento» dopo che l'hai riacceso — nessuna riga di task è cambiata,
      // quindi nessun `task:updated` arriva a correggerle, e la board direbbe
      // una bugia proprio nell'istante in cui la guardi per vedere l'effetto.
      if (m.type === 'board:dispatch' && typeof m.autoDispatch === 'boolean') {
        setDispatchOn(m.autoDispatch);
        refetch();
      }
    });
  }, [onMessage, projectId, refetch, mode, flashCreated]);

  // Wake-up refresh: a window coming back from sleep/background has yesterday's
  // board (WS events happened while it slept) — and the live "ci sta mettendo"
  // Ticker recomputes from Date.now(), so a stale 'working' card reads hours of
  // agent work that never happened. Any return to visibility refetches.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refetch]);

  // Task chiusi la cui consegna NON risulta su main (verdetto dell'audit
  // periodico). Deliberatamente NON filtrato dai filtri di header: è un allarme
  // sull'integrità della board, non una vista.
  const unlandedTasks = useMemo(
    () => tasks.filter(showsLandingDebt),
    [tasks],
  );

  // Quanti CHECKOUT vivi tiene questo progetto.
  //
  // Il chip «non su main» (accanto a Pubblica) conta i BRANCH non landati;
  // questo conta le cartelle. Sono due accumuli diversi e si spostano
  // separatamente: un branch landato libera il suo worktree, ma un worktree
  // tenuto perche' il task e' ancora aperto non ha nessun branch da landare.
  // Con un numero solo non si capisce quale dei due sta crescendo — ed e'
  // cresciuto in silenzio fino a ~40 worktree il 21/07. Li mostra
  // `WorktreeControl`, che li tiene distinti e li spiega a parole.
  const [worktreeCount, setWorktreeCount] = useState(0);
  const [gcRunning, setGcRunning] = useState(false);
  /** Rami locali non su main: quanti, e quanti non li reclama nessun task. */
  const [branchInv, setBranchInv] = useState<{ total: number; orphan: number; onOpenTasks: number } | null>(null);
  const [gcResult, setGcResult] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath || global) { setWorktreeCount(0); return; }
    let alive = true;
    const load = () => {
      fetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { worktrees?: unknown[] } | null) => {
          if (alive && Array.isArray(b?.worktrees)) setWorktreeCount(b.worktrees.length);
        })
        .catch(() => {});
    };
    load();
    // Il GC gira ogni 30 minuti e i dispatch creano worktree in continuazione:
    // un conteggio letto una volta sola al mount invecchia sotto gli occhi.
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [projectPath, global]);

  // I RAMI non su main, col task che li reclama.
  //
  // Il chip «N non su main» conta solo i task CHIUSI: un ramo di un task
  // ancora in backlog — o di nessun task — non compariva da nessuna parte. È
  // così che quattro rami con lavoro fatto sono rimasti invisibili per
  // settimane, mentre la board riproponeva come «da fare» cose già scritte lì
  // dentro. Il numero che conta è quello degli ORFANI: nessuno li reclamerà.
  useEffect(() => {
    if (!projectPath || global) { setBranchInv(null); return; }
    let alive = true;
    fetch(`/api/worktrees/branches?project_path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { summary?: { total: number; orphan: number; onOpenTasks: number } } | null) => {
        if (alive && b?.summary) setBranchInv(b.summary);
      })
      // Un progetto che non è un repo git risponde 500: nessun inventario, e va
      // bene — non è un errore da mostrare, è un progetto senza rami.
      .catch(() => {});
    return () => { alive = false; };
  }, [projectPath, global]);

  // «Pulisci landati»: anticipa la passata del GC invece di aspettarne una.
  //
  // Non è più permissivo dell'automatico — è la STESSA passata, che reapa solo
  // ciò che è provabilmente sicuro. Per questo l'esito deve dire anche quanti
  // ne ha TENUTI e perché: un «0 ripuliti» secco farebbe sembrare rotto un
  // bottone che sta facendo la cosa giusta.
  const runGc = useCallback(async () => {
    setGcRunning(true);
    setGcResult(null);
    try {
      const r = await fetch('/api/worktrees/gc', { method: 'POST' });
      const b = (await r.json()) as { summary?: { reaped?: number; landed?: number; freed?: number; kept?: number; slimmed?: number; slimmedBytes?: number; keptReasons?: Record<string, number> } };
      const sm = b?.summary;
      if (!sm) { setGcResult('Il GC non ha risposto'); return; }
      const motivi = Object.entries(sm.keptReasons ?? {}).sort((a, b2) => b2[1] - a[1]).slice(0, 2)
        .map(([m, n]) => `${n}× ${m}`).join('; ');
      // `liberati` è la voce che oggi fa quasi tutto il lavoro (cartella via,
      // branch conservato): senza, la passata che ne libera 77 direbbe «0
      // ripuliti, 0 landati» e sembrerebbe non aver fatto niente.
      //
      // Lo stesso vale per gli `snelliti`: una passata che tiene TUTTI i
      // worktree può comunque aver liberato qualche giga di `node_modules`, e
      // senza questa voce direbbe solo «0, 0, 0, N tenuti».
      const snelliti = (sm.slimmed ?? 0) > 0
        ? `, ${sm.slimmed} snelliti (${Math.round((sm.slimmedBytes ?? 0) / 1_048_576)} MB)`
        : '';
      setGcResult(
        `${sm.reaped ?? 0} ripuliti, ${sm.freed ?? 0} liberati (branch salvo), ${sm.landed ?? 0} landati${snelliti}, ${sm.kept ?? 0} tenuti`
        + (motivi ? `: ${motivi}` : ''),
      );
      // Il conteggio accanto deve riflettere la passata appena fatta.
      if (projectPath) {
        const rr = await fetch(`/api/worktrees?project_path=${encodeURIComponent(projectPath)}&status=ready`);
        if (rr.ok) {
          const bb = (await rr.json()) as { worktrees?: unknown[] };
          if (Array.isArray(bb.worktrees)) setWorktreeCount(bb.worktrees.length);
        }
      }
    } catch {
      setGcResult('Il GC non ha risposto');
    } finally {
      setGcRunning(false);
    }
  }, [projectPath]);

  // `kanbanOrder` è una chiave PER BOARD: nella board generale i numeri vengono
  // da sequenze indipendenti e non si confrontano. Lo scope lo dice al
  // comparatore (e a `planDrop`, che lì non scrive posizioni).
  const orderScope: OrderScope = mode === 'all' ? 'cross-project' : 'board';

  const byStatus = useMemo(() => {
    const visible = tasks.filter((t) => {
      // Apply filters: all active conditions must match (AND logic).
      if (filters.priority.length > 0 && !filters.priority.includes(t.priority)) return false;
      if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(t.assignedTo || '')) return false;
      if (filters.text && !t.text.toLowerCase().includes(filters.text.toLowerCase())) return false;
      if (filters.projectId.length > 0 && !filters.projectId.includes(t.projectId)) return false;
      // AND, come gli altri: «bugfix E visibile» è una lista sola, non due.
      if (filters.labels.length > 0) {
        const on = new Set(t.labels.map((l) => l.label));
        if (!filters.labels.every((l) => on.has(l))) return false;
      }
      return true;
    });
    return groupByStatus(visible, orderScope);
  }, [tasks, filters, orderScope]);

  /**
   * LA FIRMA DELLE COLONNE, e serve al movimento.
   *
   * Il lampo dice DOVE guardare, ma non lega le due posizioni: una card che
   * cambia stato spariva da una colonna e riappariva in un'altra nello stesso
   * fotogramma. Adesso ci VIAGGIA, e le vicine le fanno spazio (vedi
   * `useBoardMotion` e `lib/boardFlight`).
   *
   * Questa stringa e' il segnale che qualcosa PUO' essersi mosso: chi c'e', in
   * che colonna, in che ordine. Non basta guardare `tasks`, perche' la board
   * ri-renderizza ogni 4 secondi per far girare i contatori delle card al
   * lavoro, e ogni giro costerebbe una misura di tutti i rettangoli.
   */
  const motionKey = useMemo(
    () => TASK_STATUSES.map((s) => byStatus[s].map((t) => t.id).join(',')).join('|'),
    [byStatus],
  );
  // Le card che hanno appena cambiato COLONNA, e in quale sono arrivate: il
  // lampo prende il colore di quella colonna, quindi qui serve la destinazione,
  // non solo l'elenco. Si guarda `tasks` (la lista grezza), non `byStatus`: un
  // filtro attivo può nascondere la card, e il lampo non deve dipendere da cosa
  // si sta guardando — quando riappare l'ha già consumato, che è giusto, ma la
  // transizione resta registrata una volta sola.
  //
  // Vale per OGNI via di spostamento, perché nessuna passa di qui direttamente:
  // il trascinamento, l'approvazione dal drawer, un agente che consegna e un
  // altro device finiscono tutti nello stesso refetch. Il confronto è con lo
  // stato precedente (vedi `lib/columnFlash`), non con la freschezza di una data.
  const [justMoved, setJustMoved] = useState<Map<string, TaskStatus>>(() => new Map());
  const prevStatusRef = useRef<Map<string, TaskStatus> | null>(null);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const landed = landedInColumn(prevStatusRef.current, tasks);
    prevStatusRef.current = statusSnapshot(tasks);
    if (landed.size === 0) return;
    setJustMoved((prev) => {
      const next = new Map(prev);
      // Due passaggi in meno di 2,4 s (todo → in corso → review, un agente
      // veloce): vince l'ULTIMO, ed è giusto — il colore che si vede è quello
      // della colonna dove la card è adesso, non di quella da cui è ripartita.
      for (const [id, status] of landed) next.set(id, status);
      return next;
    });
    for (const [id] of landed) {
      clearTimeout(flashTimers.current.get(id));
      flashTimers.current.set(id, setTimeout(() => {
        flashTimers.current.delete(id);
        setJustMoved((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, COLUMN_FLASH_MS));
    }
  }, [tasks]);
  // Smontando la pane a lampo acceso i timer resterebbero appesi a chiamare un
  // setState su un componente che non c'è più.
  useEffect(() => {
    const timers = flashTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  // …e portare Done DOVE SI GUARDA. Il lampo da solo non bastava: nel layout
  // normale — sidebar più cinque colonne, con Review più larga delle altre —
  // Done sta oltre il bordo destro. Misurato: a 1600×900 il bordo destro della
  // card appena chiusa cadeva a 2195px, cioè quasi 600 fuori dalla finestra. La
  // card arrivava, lampeggiava e si spegneva senza che nessuno la vedesse.
  //
  // Si scorre la riga delle colonne per la sua PROPRIA `scrollLeft`, mai
  // `element.scrollIntoView()`: la sua risalita automatica degli antenati può
  // uscire da questa preoccupazione (orizzontale) e portarsi dietro un antenato
  // verticale — vedi la nota sull'effetto della selezione qui sopra.
  //
  // Solo per DONE, anche adesso che il lampo vale per ogni colonna: gli altri
  // passaggi li fa quasi sempre la mano di chi guarda (un drag finisce dove
  // l'occhio è già), mentre chiudere si fa da un bottone e la colonna in cui la
  // card atterra è dall'altra parte della board. Inseguire ogni transizione
  // vorrebbe dire strappare via la colonna che si sta leggendo a ogni evento di
  // un agente.
  useEffect(() => {
    if (![...justMoved.values()].includes('done')) return;
    // rAF: l'effetto parte nello stesso commit in cui la card entra in colonna,
    // e il rettangolo di Done va misurato a layout fatto.
    const raf = requestAnimationFrame(() => {
      const container = columnsScrollRef.current;
      const col = container?.querySelector('[data-testid="kanban-column-done"]');
      if (!container || !col) return;
      const cRect = container.getBoundingClientRect();
      const dRect = col.getBoundingClientRect();
      if (dRect.left >= cRect.left && dRect.right <= cRect.right) return; // già in vista
      container.scrollBy({ left: dRect.right - cRect.right, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [justMoved]);

  // …e lo stesso all'altro capo: la card appena creata va PORTATA A SCHERMO.
  // Il lampo da solo non basta per la nascita ancora meno che per la chiusura —
  // un task nuovo prende `kanban_order = max + 1`, cioè atterra in FONDO alla
  // colonna, che su una colonna piena è già fuori dal corpo scrollabile; e se la
  // colonna di destinazione è a sua volta oltre il bordo della riga, la card
  // nasce, lampeggia e si spegne in un pezzo di DOM che nessuno sta guardando.
  //
  // DUE assi, DUE contenitori distinti, ed è il punto: la riga delle colonne
  // scorre in orizzontale, il corpo della colonna in verticale. `scrollIntoView`
  // li farebbe entrambi da sola — ma anche parecchi altri, risalendo gli
  // antenati fin dove non deve (vedi la nota sull'effetto della selezione).
  // Quindi ognuno per la sua `scrollBy`, con il delta calcolato da `scrollDelta`.
  //
  // In orizzontale si inquadra la COLONNA, non la card: sono `snap-center` e
  // portare a filo la sola card lascerebbe la colonna tagliata a metà. In
  // verticale la card, che è esattamente ciò che si vuole leggere.
  useEffect(() => {
    if (!scrollTarget) return;
    // La card entra nel DOM solo quando il refetch ha rimpiazzato `tasks`: fino
    // ad allora questo effetto non trova niente e riprova al giro dopo. Se un
    // filtro attivo la tiene fuori, non arriva nessun giro — ci pensa la
    // scadenza qui sotto a non lasciare un bersaglio appeso.
    if (!tasks.some((t) => t.id === scrollTarget)) return;
    // DUE frame, non uno. L'effetto parte nello stesso commit in cui la card
    // entra in colonna, e i rettangoli vanno letti a layout FATTO — ma il primo
    // frame non basta: la card esiste già e la colonna sta ancora assestando la
    // propria altezza (chip, anteprime, il resto del contenuto della card che
    // prende posto). Misurato lì, il rettangolo era ~55px più in alto del vero,
    // lo scorrimento partiva corto di altrettanto e la card si fermava dietro al
    // composer una volta su due — un rosso a intermittenza che non parlava del
    // meccanismo ma di QUANDO lo si era interrogato. Il secondo frame legge
    // numeri che non si muovono più, e lo scorrimento morbido parte una volta
    // sola dalla posizione giusta.
    let raf2 = 0;
    // Vive OLTRE questo effetto: la sorveglianza qui sotto continua dopo che
    // `setScrollTarget(null)` ha fatto ripulire l'effetto, quindi il suo
    // spegnimento sta in un ref e non nel cleanup del turno.
    const raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => {
      const row = columnsScrollRef.current;
      const card = row?.querySelector(`[data-task-card="${CSS.escape(scrollTarget)}"]`);
      setScrollTarget(null);
      if (!row || !card) return;
      const cardRect = card.getBoundingClientRect();
      const column = card.closest('[data-testid^="kanban-column-"]');
      if (column) {
        const rowRect = row.getBoundingClientRect();
        const colRect = column.getBoundingClientRect();
        const dx = scrollDelta({ start: rowRect.left, end: rowRect.right }, { start: colRect.left, end: colRect.right });
        if (dx !== 0) {
          // Quanto scorrere non è «il minimo per rientrare»: la riga è un
          // carosello `snap-x snap-mandatory`, e i suoi punti di riposo sono le
          // colonne CENTRATE. Chiedendo il minimo, lo snap corregge di sua
          // iniziativa verso il punto più vicino — che è la colonna ACCANTO — e
          // quella appena inquadrata torna fuori, tagliata dal lato da cui era
          // arrivata. Quindi si chiede direttamente una posizione che lo snap
          // accetta: la colonna al centro. `scrollDelta` qui decide SE muoversi,
          // non di quanto. Una colonna più larga della riga (Review in una pane
          // stretta) non ha un centro utile: lì vale il minimo, e lo snap si
          // rilassa da solo perché nessun punto di riposo la conterrebbe.
          const centered = (colRect.left + colRect.right - rowRect.left - rowRect.right) / 2;
          row.scrollBy({ left: colRect.width >= rowRect.width ? dx : centered, behavior: 'smooth' });
        }
      }
      const body = card.closest('[data-testid^="kanban-column-body-"]');
      if (body) {
        const bodyRect = body.getBoundingClientRect();
        // Il fondo UTILE della colonna non è il suo bordo inferiore. Il composer
        // («Descrivi un task per l'agent…») è un overlay ancorato in basso
        // sull'area della board, e la fascia che copre è esattamente dove un
        // task nuovo atterra: prende `kanban_order = max + 1`, quindi va in
        // fondo alla colonna. Fermarsi al bordo mette la card appena creata
        // DIETRO al riquadro in cui l'hai scritta — rettangolo giusto, e non la
        // vedi. È lo stesso motivo per cui il corpo colonna porta `pb-16`.
        //
        // Il composer si MISURA invece di ricopiarne l'altezza in una costante:
        // cresce col testo, si alza quando è a fuoco, e sparisce del tutto in
        // alcuni stati (`hidden`, drawer a tutto schermo sotto lg) — un numero
        // fisso sarebbe sbagliato in tutti e tre i casi. Nascosto ha un rect di
        // zeri, ed è l'unico caso da scartare: `height > 0`.
        //
        // NIENTE test di sovrapposizione orizzontale, per quanto sembri la cosa
        // giusta da fare. Qui siamo in un rAF che parte quando la card entra nel
        // DOM: lo scorrimento orizzontale è stato CHIESTO due righe sopra, ma è
        // morbido e non è ancora avvenuto, quindi la colonna sta ancora dov'era
        // — fuori schermo, che è tutto il motivo per cui la stiamo spostando.
        // Un `compRect.left < bodyRect.right` letto in quell'istante confronta
        // il composer con una posizione che sta per non esistere più e risponde
        // sempre «non si sovrappongono»: misurato, la card tornava esattamente a
        // `bordo - 8`, cioè dietro al composer. E la domanda è comunque oziosa,
        // perché la colonna la stiamo CENTRANDO — cioè portando esattamente
        // dove il composer, anche lui centrato, sta.
        const usableBottom = () => {
          const composer = document.querySelector('[data-testid="board-task-composer"]');
          const compRect = composer?.getBoundingClientRect();
          const covers = !!compRect && compRect.height > 0;
          return covers ? Math.min(body.getBoundingClientRect().bottom, compRect.top) : body.getBoundingClientRect().bottom;
        };
        // Un filo di margine: appoggiata al bordo la card è tecnicamente in
        // vista e sembra tagliata.
        const dy = scrollDelta({ start: bodyRect.top, end: usableBottom() }, { start: cardRect.top, end: cardRect.bottom }, 8);
        if (dy !== 0) body.scrollBy({ top: dy, behavior: 'smooth' });
        // …e poi si RESTA liberi, perché il composer che abbiamo appena misurato
        // non ha ancora l'altezza che avrà. Il gesto che crea la card è un invio
        // DAL composer: quello si svuota, la sua textarea torna a una riga e
        // subito dopo riprende il fuoco e si riapre (`min-h-[4.5rem]`, più il
        // mezzo passo di `-translate-y-2`) con una transizione di 200ms. I due
        // frame di attesa qui sopra cadono dentro quella transizione, non dopo:
        // misurato, il bordo superiore del composer passava da 625 a 578 — 47px
        // di fascia coperta in più — e la card, parcheggiata correttamente sopra
        // al 625 di allora, finiva dietro al riquadro in cui l'avevi scritta.
        // La corsa non c'entrava: `pb-36` lasciava ancora 91px di scorrimento
        // inutilizzato.
        //
        // Quindi la posizione non si decide una volta sola: si ricontrolla a
        // ogni cambio di misura di composer e card, finché dura il lampo. Solo
        // in DISCESA (`d > 0`): risalire vorrebbe dire riprendersi lo
        // scorrimento che intanto ha fatto chi guarda.
        const ro = new ResizeObserver(() => {
          const c = card.getBoundingClientRect();
          const d = scrollDelta({ start: body.getBoundingClientRect().top, end: usableBottom() }, { start: c.top, end: c.bottom }, 8);
          if (d > 0) body.scrollBy({ top: d, behavior: 'smooth' });
        });
        const composerEl = document.querySelector('[data-testid="board-task-composer"]');
        if (composerEl) ro.observe(composerEl);
        ro.observe(card);
        keepClearRef.current?.();
        let stop = 0 as unknown as ReturnType<typeof setTimeout>;
        keepClearRef.current = () => { clearTimeout(stop); ro.disconnect(); keepClearRef.current = null; };
        stop = setTimeout(() => keepClearRef.current?.(), CREATED_FLASH_MS);
      }
    }); });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  }, [scrollTarget, tasks]);
  // Un bersaglio che non atterra (filtro attivo, creazione in un'altra board)
  // non resta armato per sempre: scorrere mezzo minuto dopo sarebbe uno
  // strattone che non risponde a niente di quello che stai facendo ORA.
  useEffect(() => {
    if (!scrollTarget) return;
    const t = setTimeout(() => setScrollTarget(null), CREATED_FLASH_MS);
    return () => clearTimeout(t);
  }, [scrollTarget]);

  // Task lookup by id for the parent chip ("⤴ epic…"). Best effort: a parent
  // not in the current fetch just shows the generic label.
  //
  // Il chip «in attesa di» NON passa più di qui: il bloccante lo risolve il
  // server (`task.blockedBy`), perché questa lista è un progetto solo,
  // `rootsOnly`, non archiviati — e un bloccante fuori da quel taglio faceva
  // sparire il chip da una card che il dispatcher teneva ferma comunque.
  const tasksById = useMemo(() => {
    const m = new Map<string, BoardTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Project path index, only needed in the cross-project board (per-card
  // favicon — task.projectId is a one-way hash, ProjectFavicon needs a path).
  // Dallo store CONDIVISO: card, filtro e composer devono vedere lo stesso
  // indice nello stesso istante, altrimenti l'icona compare su una superficie
  // e non sull'altra a seconda di chi ha fetchato prima.
  const projectIndex = useBoardProjects(mode === 'all');
  const projectPathById = useMemo(
    () => new Map((projectIndex ?? []).map((p) => [p.projectId, p.path])),
    [projectIndex],
  );

  /**
   * Persist a drop: status and/or position, optimistically. Routed by the
   * task's OWN projectId so it works identically in the global board.
   *
   * `plan.renumber` c'è solo nel caso raro in cui l'interstizio frazionario si
   * è esaurito (vedi `lib/boardOrder`): allora la colonna va riscritta a interi,
   * N patch invece di una. Si spedisce PRIMA la colonna e poi la card
   * trascinata, così se una scrittura cade a metà la card non resta l'unica
   * spostata in un ordine che non le corrisponde più; un errore qualsiasi
   * rifetcha e la verità torna dal server.
   */
  const dropTo = useCallback(async (task: BoardTask, plan: DropPlan) => {
    // A redirected drop onto a card that is already where the redirect sends it
    // has nothing to write: the plan exists only to carry the notice. Niente da
    // scrivere = niente da aspettare, quindi la lettura parcheggiata parte qui.
    if (Object.keys(plan.patch).length === 0 && !plan.renumber?.length) { flushDeferredRead(); return; }
    for (const r of plan.renumber ?? []) patchTask(r.id, { kanbanOrder: r.kanbanOrder });
    patchTask(task.id, plan.patch); // optimistic
    // Le stesse patch, ma marcate IN VOLO: `patchTask` scrive nella lista di
    // adesso, questo strato le riappoggia su quelle che arriveranno prima che il
    // server confermi (vedi `pendingWrites`).
    const inFlight = new Map<string, Partial<BoardTask>>();
    for (const r of plan.renumber ?? []) inFlight.set(r.id, { kanbanOrder: r.kanbanOrder });
    inFlight.set(task.id, plan.patch);
    setPendingWrites((prev) => new Map([...prev, ...inFlight]));
    try {
      // `renumber` esiste solo nello scope `board` (nella board generale la
      // posizione non si scrive affatto), quindi le card riscritte sono per
      // costruzione dello STESSO progetto della trascinata.
      for (const r of plan.renumber ?? []) {
        await boardApi.update(task.projectId, r.id, { kanbanOrder: r.kanbanOrder });
      }
      await boardApi.update(task.projectId, task.id, plan.patch);
      onCardError(task.id, null);
    } catch (e) {
      // The notice was written before the PATCH (it explains the GESTURE, and
      // waiting for the round trip would make it arrive late). If the write
      // failed the card is where it was, so the notice is now false: it goes,
      // and the error speaks alone.
      setDropNotice(null);
      // E parla SULLA CARD. Trascinare in Done un padre con figli aperti è lo
      // stesso rifiuto del bottone Approva: il refetch riporta la card al suo
      // posto, e il perché la aspetta lì invece che in cima al pannello, dove
      // con la colonna scrollata non lo leggeva nessuno.
      onCardError(task.id, taskActionErrorMessage(e, 'spostamento non riuscito'));
      refetch();
    } finally {
      // La scrittura ha risposto (bene o male): da qui in poi comanda il
      // server, quindi lo strato ottimistico si toglie e SOLO ADESSO parte la
      // lettura che il drag aveva parcheggiato. Mandarla prima significava
      // chiedere lo stato a chi non l'aveva ancora ricevuto, e riprendersi in
      // risposta la colonna di partenza.
      setPendingWrites((prev) => {
        const next = new Map(prev);
        for (const id of inFlight.keys()) next.delete(id);
        return next.size === 0 ? EMPTY_WRITES : next;
      });
      flushDeferredRead();
    }
  }, [patchTask, refetch, onCardError, flushDeferredRead]);

  const [activeId, setActiveId] = useState<string | null>(null);
  // Il movimento della board si aggancia qui: misura le colonne quando la firma
  // cambia e anima chi si e' spostato. Mentre una card e' IN MANO non anima
  // niente (comanda dnd-kit, che sta gia' muovendo gli stessi nodi), e la card
  // appena lasciata la salta del tutto, perche' e' gia' arrivata dov'e' col
  // dito: vedi `skipFlight` in `onDragEnd`.
  const skipFlight = useBoardMotion(columnsScrollRef, motionKey, activeId === null);
  // Hide the floating "Descrivi un task" composer while the human is typing in
  // a field that SITS ON IT: a card's quick-reply / "Scrivi all'agent" box,
  // which opens low in a column, right under the composer.
  //
  // Il gate è ristretto alle COLONNE della board. Prima il listener era su
  // `window` e il predicato «un campo qualsiasi ha il fuoco»: mettere il cursore
  // nella chat di un'altra pane, in un terminale o in una ricerca faceva sparire
  // il composer di qua — un focus-out dalla board non sovrappone proprio niente.
  const [typingElsewhere, setTypingElsewhere] = useState(false);
  useEffect(() => {
    const sync = () => {
      const el = document.activeElement as HTMLElement | null;
      const isField = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      // Solo i campi DENTRO il carosello delle colonne si sovrappongono al
      // composer. Il composer stesso e i menu portalati su <body> ne sono fuori
      // per costruzione, quindi non serve escluderli a mano.
      const inColumns = !!el && !!columnsScrollRef.current?.contains(el);
      setTypingElsewhere(isField && inColumns);
    };
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => { window.removeEventListener('focusin', sync); window.removeEventListener('focusout', sync); };
  }, []);
  // Mouse: pick a card up after a 4px drag. Touch: require a 200ms press-and-hold
  // (with an 8px slop) before a drag starts, so a horizontal swipe scrolls the
  // snap carousel instead of yanking the card under the finger.
  // Tastiera: spazio/invio afferra la card, le frecce la spostano, spazio molla,
  // Esc annulla. Senza questo sensore riordinare una colonna era possibile SOLO
  // col mouse — cambiare stato no (il selettore nel drawer c'è), ma la posizione
  // dentro la colonna non era raggiungibile in nessun altro modo.
  // Sensori SORDI ai campi e ai comandi: un click nell'input di risposta non
  // deve diventare un trascinamento (vedi `dndSensors.ts` per il perché).
  const sensors = useSensors(
    useSensor(PoliteMouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(PoliteTouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(PoliteKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragStart = useCallback((e: DragStartEvent) => {
    // Le righe si congelano qui e si scongelano in `endDrag`: fin quando la card
    // è in mano nessuna rilettura (di questa pane o dello store condiviso) può
    // rifare le colonne sotto il puntatore.
    beginDrag();
    setActiveId(String(e.active.id));
    // A new gesture retires the previous one's explanation, whatever this drag
    // turns out to do (including being cancelled, or ending on a card that is
    // no longer in the list).
    setDropNotice(null);
  }, [beginDrag]);
  // Cosa produce un drop sta in `lib/boardOrder` — puro e testato (bun:test):
  // qui resta solo il raccordo fra dnd-kit e la PATCH.
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    // Questa card non viaggia al prossimo giro: il dito l'ha appena portata
    // dov'e', e farla ripartire da dov'era per rifare il tragitto da sola
    // sarebbe l'unica animazione che contraddice il gesto di chi guarda.
    skipFlight(String(e.active.id));
    // Scongela le righe, e SOLO quello: la lettura che il drag ha parcheggiato
    // partirebbe prima della PATCH del drop e risponderebbe con lo stato di
    // partenza — la card tornava nella colonna di prima per un giro di rete
    // intero. La rilascia `dropTo`, quando la scrittura ha risposto.
    endDrag();
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) { flushDeferredRead(); return; }
    const plan = planDrop({
      task,
      overId: e.over ? String(e.over.id) : null,
      byStatus,
      // I numeri li decide la colonna INTERA, non quella filtrata: vedi
      // `planDrop`. Con un filtro attivo erano la stessa lista, e la
      // rinumerazione riscriveva 1..N sopra le card nascoste.
      //
      // Si raggruppa QUI e non in un memo del render: serve una volta per drop,
      // e un memo lo ricalcolerebbe a ogni arrivo di righe — cioè nel percorso
      // caldo che questa tornata sta cercando di alleggerire.
      byStatusAll: groupByStatus(tasks, orderScope),
      scope: orderScope,
    });
    // The card did not land where the hand let it go: say it, or the gesture
    // reads as a bug. `onDragStart` already cleared the previous one, so this
    // only ever adds.
    if (plan?.redirectedFrom === 'in_progress') setDropNotice(tr('board.drop.inProgressRedirected'));
    // Nessun piano = nessuna scrittura da aspettare: la lettura parcheggiata
    // non ha più niente dietro cui mettersi in fila.
    if (plan) dropTo(task, plan); else flushDeferredRead();
  }, [tasks, byStatus, dropTo, endDrag, flushDeferredRead, orderScope, skipFlight, tr]);
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;
  /**
   * COSA HO IN MANO, in parole: la riga di contesto e i badge che la scheda di
   * trascinamento porta sotto al titolo (il `DragOverlay` in fondo al render).
   *
   * Si calcola qui e non dentro il JSX perché mentre la card è in mano questa
   * pane ridisegna a ogni movimento del puntatore, e `resolveProjectRefs`
   * ricostruirebbe l'indice dei progetti a ogni fotogramma per leggere un nome
   * solo.
   */
  const dragPreview = useMemo(() => {
    if (!activeTask) return null;
    // Il progetto SOLO dove distingue qualcosa. Su una board di progetto
    // sarebbe la stessa parola su ogni card, cioè rumore. Il nome lo dà
    // `resolveProjectRefs`, lo stesso indice condiviso da cui lo prendono il
    // filtro e la card: un id senza progetto (`isProjectlessId`) non ha nome da
    // mostrare, esattamente come la card che non disegna il chip.
    const progetto = mode === 'all' && !isProjectlessId(activeTask.projectId)
      ? resolveProjectRefs([activeTask.projectId], projectIndex)[0]?.name ?? null
      : null;
    // La colonna di partenza è il fatto che il titolo non dice mai. Trascinando
    // fra cinque colonne, «da dove viene» è metà di quello che serve sapere.
    const subtitle = [STATUS_LABEL[activeTask.status], progetto].filter(Boolean).join(' · ');
    // Tre al massimo, priorità per prima perché è l'unica che c'è sempre. Le
    // etichette sono già la parola che si legge (`shared/task-labels`: il
    // vocabolario È il testo), e restano nell'ordine in cui le disegna la card,
    // così l'anteprima non racconta una card diversa da quella che hai preso.
    // Oltre il terzo badge la scheda cresce più di quanto dica.
    //
    // `filter(Boolean)` copre una priorità fuori scala, che nella mappa dei
    // nomi non ha nessuna voce e lascerebbe un badge senza testo.
    const badges = [
      PRIORITY_LABEL[activeTask.priority],
      ...activeTask.labels.map((l) => l.label),
    ].filter(Boolean).slice(0, 3);
    return { subtitle, badges };
  }, [activeTask, mode, projectIndex]);

  const create = useCallback(async (status: TaskStatus, text: string) => {
    // A task can't be created directly in Done — land it in Todo instead.
    // In Progress is the same story for a different reason (`manualStatusTarget`):
    // a task being born has no agent by definition, so writing it straight into
    // In Progress creates it already stuck. This is the second of the three
    // doors, and it is the worst of them, because a card that was never
    // dispatched has nothing on it to explain why nobody picks it up.
    const aim = manualStatusTarget(status === 'done' ? 'todo' : status, null);
    // L'id arriva dalla POST, non dal broadcast: è quello che distingue «l'ho
    // creato io» da «è comparso», e solo il primo autorizza a muovere la board.
    try {
      const created = await boardApi.create(projectId, { text, status: aim.status });
      if (aim.redirectedFrom === 'in_progress') setDropNotice(tr('board.drop.inProgressRedirected'));
      onCreatedHere(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'create failed'); }
  }, [projectId, onCreatedHere, tr]);

  // Il task che il drawer mostra quando l'id NON è nel feed. Il feed è
  // `rootsOnly` — le colonne mostrano le radici, gli step vivono nell'albero del
  // genitore — quindi un id di SOTTOTASK non ci sarà mai, e `tasks.find(...)` da
  // solo restituiva `undefined`: il click su uno step CHIUDEVA il drawer invece
  // di aprirlo, e un deep-link `/task/<id-di-sottotask>` restava appeso per
  // sempre. Lo risolve `boardApi.resolve`, la porta unica «da un id al suo task,
  // a qualunque profondità».
  const [outsider, setOutsider] = useState<BoardTask | null>(null);
  const selected = tasks.find((t) => t.id === selectedId)
    || (outsider && outsider.id === selectedId ? outsider : null);

  // L'id che il drawer deve mostrare: la selezione, o il deep-link ancora in
  // volo. Uno solo dei due è valorizzato nel caso normale.
  const wantId = selectedId ?? pendingSelect;
  const inFeed = !!wantId && tasks.some((t) => t.id === wantId);

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

  // Un id fuori dal feed passa comunque: la porta unica lo risolve e il drawer
  // si apre. Rigira a ogni cambio di `tasks` — la board rifetcha su ogni evento
  // `task:*`, quindi è anche il battito che tiene fresco `updatedAt` (il `bump`
  // con cui il drawer ricarica il suo thread) per un task che nel feed non c'è.
  const resolvedRef = useRef<{ id: string; feed: readonly BoardTask[] } | null>(null);
  useEffect(() => {
    if (!wantId) { setOutsider(null); resolvedRef.current = null; return; }
    if (inFeed) return; // il feed ce l'ha: nessuna porta da aprire
    // Una sola richiesta per (id, feed): sciogliere il deep-link cambia
    // `pendingSelect`, e senza questo la rifarebbe subito a vuoto.
    if (resolvedRef.current?.id === wantId && resolvedRef.current.feed === tasks) return;
    resolvedRef.current = { id: wantId, feed: tasks };
    // Vero solo se stiamo sciogliendo un deep-link, non un click su uno step:
    // `topics:task-opened` rilascia l'intento di fuoco della board, e va emesso
    // per quello e basta.
    const deepLink = pendingSelect === wantId;
    let alive = true;
    boardApi.resolve(wantId)
      .then((t) => {
        if (!alive) return;
        if (t) {
          setOutsider(t);
          if (deepLink) {
            setSelectedId(wantId);
            setPendingSelect(null);
            window.dispatchEvent(new CustomEvent('topics:task-opened'));
          }
          return;
        }
        // Quell'id non esiste: chiudere è l'unica risposta onesta — restare
        // appesi in attesa di un task che non arriverà è il guasto di prima.
        // E il vicolo cieco va DETTO: `topics:task-opened` non significa «il
        // drawer si è aperto», significa «la corsa del deep-link è finita».
        // Senza questa riga l'intento di fuoco restava armato e riportava la
        // finestra sulla board a ogni mutazione dello store, per tutta la
        // sessione.
        if (deepLink) {
          setPendingSelect(null);
          window.dispatchEvent(new CustomEvent('topics:task-opened'));
        }
        setSelectedId((s) => (s === wantId ? null : s));
      })
      .catch(() => {
        resolvedRef.current = null; /* trasporto caduto: il prossimo refetch riprova */
        // Il refetch riproverà ad aprire il drawer, ma l'intento di fuoco no:
        // quello si rilascia comunque, perché una rete caduta non è una buona
        // ragione per tenere l'utente inchiodato alla board.
        if (deepLink) window.dispatchEvent(new CustomEvent('topics:task-opened'));
      });
    return () => { alive = false; };
    // `outsider` fuori dalle dipendenze di proposito: lo SCRIVE questo effetto.
  }, [wantId, inFeed, tasks, pendingSelect]);

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
    // Depend on selectedId (primitive), NOT the `selected` object: its reference
    // churns on every board refetch while the id is what actually gates the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [global, selectedId, pendingSelect]);

  // Back/forward drive the drawer from history: the value-equality guard in
  // reflect* means setting the selection here won't re-push a duplicate entry.
  useEffect(() => {
    if (!global) return;
    return subscribePopstateTask((target) => setSelectedId(target?.taskId ?? null));
  }, [global]);

  useEffect(() => {
    const el = toolbarScrollRef.current;
    if (!el) return;
    const update = () => {
      setToolbarOverflowRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tasks, filters, mode, unlandedTasks.length]);

  if (loading) {
    // L'anello dell'app, non la rotella lucide: qui sta caricando la BOARD
    // intera, ed è l'attesa di un blocco (vedi `Spinner.tsx` per la divisione
    // dei due). `Loader2` resta dove serve, cioè nelle righe e nei bottoni.
    return <div className="flex h-full items-center justify-center"><Spinner size="md" /></div>;
  }

  return (
    // `reveal-in`: la board non compare di scatto al posto dell'anello. Il
    // nodo nasce quando `loading` si spegne, quindi la dissolvenza parte una
    // volta sola, al montaggio, e non a ogni ridisegno. Solo opacita': muovere
    // le colonne mentre appaiono le farebbe leggere come se stessero arrivando
    // da qualche parte, e non arrivano da nessuna parte.
    <div className="reveal-in relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally.
          On phone the toolbar is too dense to fit — it becomes a single
          horizontally-scrollable strip (no wrap, hidden scrollbar) so nothing is
          clipped; on desktop it sits inline with the trailing actions ml-auto'd.
          The fade+chevron below is the mobile-only affordance that the strip
          continues past the right edge — it tracks live scroll position and
          disappears once fully scrolled. */}
      <div className="relative shrink-0 border-b border-app-border">
      <div ref={toolbarScrollRef} data-testid="board-toolbar" className="flex items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:px-3">
        {canToggle ? (
          <>
            <button
              onClick={() => setMode('project')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'project' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >{tr('board.toolbar.thisProject')}</button>
            <button
              onClick={() => setMode('all')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'all' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >{tr('board.toolbar.allProjects')}</button>
          </>
        ) : (
          <span className="text-xs font-semibold text-app-text">{tr('board.toolbar.general')}<span className="hidden sm:inline">{tr('board.toolbar.generalSuffix')}</span></span>
        )}
        <GlobalSettingsMenu />
        <LoadAdviceChip />
        <WorktreeControl
          count={worktreeCount}
          branches={branchInv}
          gcRunning={gcRunning}
          gcResult={gcResult}
          onGc={runGc}
        />
        {/* `grow`: la barra dei filtri è anche il posto in cui vive lo spazio
            libero della riga. Quando ce n'è, i progetti ci diventano chip; se
            manca, la striscia resta a zero e restano nel menu — senza che i
            filtri veri perdano un pixel (vedi la nota dentro `InlineFilters`). */}
        <div className="ml-2 flex min-w-0 grow items-center">
          <InlineFilters filters={filters} onFiltersChange={setFilters} tasks={tasks} mode={mode} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === 'all' && <span className="hidden text-[11px] text-app-text-muted sm:inline">{tr('board.allProjectsCount', { n: tasks.length })}</span>}
          {/* (Qui stava il chip delle sessioni Claude avviate a mano in un
              terminale, col suo «Continua qui» che le adottava in una topic.
              Tolto su richiesta di Attilio il 13/08: in barra era un numero che
              non chiedeva niente a chi lo leggeva, e il gesto che valeva era
              nascosto dentro il popover. Il censimento resta lato server: lo
              legge il dispatcher per avvertire quando si sta per landare su un
              repo dove qualcun altro sta lavorando.) */}
          {/* Auto-dispatch on/off lives in GlobalSettingsMenu now — no duplicate pill. */}
          {canRunMissions && (
            <MissionsMenu onStart={(m) => setError(onStartMission!(m))} />
          )}
          {/* UN controllo per i due gradini della consegna: «non su main» e «su
              main ma non pubblicato». Erano due bottoni adiacenti, e da fuori si
              leggevano come lo stesso allarme scritto due volte. */}
          <DeliveryControl unlanded={unlandedTasks} onOpen={setSelectedId} />
          {/* L'archivio, accanto alle impostazioni: un interruttore, come la
              lente degli archiviati in sidebar. Acceso = la board mostra ciò che
              è stato archiviato, e da lì lo si può riportare indietro. */}
          {hasProject && mode === 'project' && (
            <button
              data-testid="board-archived-toggle"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className={`rounded p-1 ${showArchived ? 'bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-white/5'}`}
              title={showArchived ? tr('board.archive.hide') : tr('board.archive.show')}
            ><Archive className="h-3.5 w-3.5" /></button>
          )}
          {/* On EVERY board, project or not. Without a project there are no
              per-board rows, but the machine-wide cap still applies here — and
              gating this button on `hasProject` is what left the general board
              with the ▾ as its only way to see the limit. */}
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={`rounded p-1 ${showSettings ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            title={tr('board.toolbar.dispatchSettings')}
          ><Settings className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {toolbarOverflowRight && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-app-bg to-transparent sm:hidden"
          data-testid="toolbar-overflow-affordance"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
        </div>
      )}
      </div>
      {error && <div className="shrink-0 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">{error}</div>}
      {dropNotice && (
        <div data-testid="board-drop-notice" className="shrink-0 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300">{dropNotice}</div>
      )}
      {/* La striscia dice DUE cose, e la seconda è quella che mancava: dove sta
          il gesto. Un archivio in cui si guarda soltanto è il punto da cui
          siamo partiti. */}
      {showArchived && mode === 'project' && (
        <div data-testid="board-archived-banner" className="flex shrink-0 items-center gap-2 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200">
          <Archive className="h-3.5 w-3.5 shrink-0" />
          <span>{tr('board.archive.banner', { count: tasks.length, restore: taskActionWord('restore', tr).label })}</span>
          <button onClick={() => setShowArchived(false)} className="ml-auto rounded px-2 py-0.5 text-amber-100 hover:bg-white/10">{tr('board.archive.hide')}</button>
        </div>
      )}
      {showSettings && (hasProject ? (
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
      ) : (
        <GlobalOnlySettingsPanel
          dispatchOn={dispatchOn}
          onToggleDispatch={toggleDispatch}
          onClose={() => setShowSettings(false)}
        />
      ))}
      {/* Board area + drawer share a flex row: an open (narrow) drawer SHRINKS
          the columns viewport instead of covering it, so every column stays
          reachable through the row's own horizontal scroll — nothing is ever
          "cut" behind the drawer. Wide mode opts back into absolute takeover
          (the drawer positions itself; out of flow, the board re-expands). */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); endDrag(); flushDeferredRead(); setDropNotice(null); }}>
            <div ref={columnsScrollRef} className="flex h-full min-w-0 snap-x snap-mandatory scroll-smooth gap-2 overflow-x-auto px-2 py-3 sm:gap-3 sm:px-3">
              {TASK_STATUSES.map((status) => (
                <Column
                  key={status}
                  status={status}
                  tasks={byStatus[status]}
                  onOpen={openTask}
                  onCreate={(text) => create(status, text)}
                  canCreate={mode === 'project' && !showArchived}
                  showProject={mode === 'all'}
                  cardError={cardError}
                  onCardError={onCardError}
                  onRefetch={refetch}
                  onOpenTopic={onOpenTopic}
                  resolveSession={resolveSession}
                  tasksById={tasksById}
                  projectPathById={projectPathById}
                  liveById={liveUsage}
                  awaitingHuman={awaitingHuman}
                  justMoved={justMoved}
                  justCreated={justCreated}
                  archived={showArchived}
                />
              ))}
            </div>
            {/* Portal to <body>: the overlay is position:fixed, and a transformed
                ancestor (pane translateX, FLIP animations) would re-anchor fixed
                positioning to itself — the ghost card then renders far from the
                pointer. On body there is no transform above it, ever. */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeTask && dragPreview ? (
                  // QUESTA È L'ANTEPRIMA DEL CONTRATTO (`lib/dragPreview`), e
                  // per questo porta `data-drag-preview`: chi legge il DOM, e i
                  // test, la trovano qui con lo stesso attributo che marca ogni
                  // altra superficie trascinabile dell'app.
                  //
                  // Il nodo però lo disegna dnd-kit, e la board NON chiama
                  // `startTouchDragPreview`. Per due ragioni, entrambe misurate.
                  // La prima: questo fantasma esiste già e segue il puntatore da
                  // solo, quindi una seconda scheda sotto lo stesso dito sarebbe
                  // il «si vede doppio» contro cui il contratto mette in
                  // guardia. La seconda: la board si trascina anche da TASTIERA
                  // (`PoliteKeyboardSensor`), e lì l'evento che apre il gesto è
                  // un `KeyboardEvent` senza `clientX`/`clientY`. Una scheda
                  // montata con quelle coordinate resterebbe piantata a 0,0
                  // mentre la card si muove altrove. È la stessa scelta già
                  // presa in `Sidebar/PinnedTile` e `Sidebar/PinnedTiles`:
                  // quando la superficie disegna già l'anteprima con la cosa
                  // VERA, quella vince sul nodo generico e il contratto si
                  // adotta marcandola.
                  //
                  // Cosa mostra, oltre al titolo: la colonna di partenza (più il
                  // progetto quando la board le tiene tutte insieme) e i badge
                  // di priorità ed etichette. Vedi il memo `dragPreview`.
                  <div
                    data-drag-preview=""
                    className="w-64 rounded-md border border-app-border bg-surface p-2.5 text-sm text-app-text shadow-xl"
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[activeTask.priority] ?? PRIORITY_DOT[2]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="leading-snug">{activeTask.text}</div>
                        {dragPreview.subtitle && (
                          <div className="mt-1 truncate text-[11px] text-app-text-muted">{dragPreview.subtitle}</div>
                        )}
                        {dragPreview.badges.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {dragPreview.badges.map((b) => (
                              <span key={b} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-app-text-secondary">{b}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          {/* New-task composer, anchored to the board AREA (centered on the
              visible columns). SEMPRE montato: quello che ci hai scritto dentro
              non deve evaporare perché hai guardato altrove o hai aperto un
              task. Si nasconde soltanto quando qualcosa gli sta davvero sopra —
              un campo aperto in una colonna, o (sotto lg) il drawer del task,
              che lì è un overlay a tutto schermo. Su desktop il drawer è un
              fratello in-flow accanto alle colonne: non lo copre, resta. */}
          <FloatingTaskComposer
            projectId={projectId}
            global={mode === 'all'}
            onCreated={onCreatedHere}
            onError={setError}
            hidden={typingElsewhere}
            hiddenBelowLg={!!selected}
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
            onOpenTask={openTask}
            onOpenTopic={onOpenTopic}
            sessionState={resolveSession(selected.assignedTopicId)}
            focusPaneId={pendingPaneId ?? undefined}
            /* Apertura automatica nel workspace: SOLO dalla board globale, che
               è una superficie a sé. Dentro una finestra di progetto la board è
               una pane di quella stessa finestra, e promuovere lì il risultato
               vorrebbe dire togliere spazio al drawer che stai leggendo — e
               rifare lo split a ogni card. Il bottone «Apri nel workspace»
               resta comunque, in entrambi i casi. */
            autoOpenInWorkspace={global}
          />
        )}
      </div>
    </div>
  );
}
