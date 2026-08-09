import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { ChevronRight, FolderTree, GitBranch, CirclePlay, RefreshCw, PanelLeftOpen, PanelLeftClose, FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { RAISED_CONTROL, ROW_ACTION_BOX, TAB_GAP_CLASS } from '../../lib/selectionStyles';
import { ScriptRunner } from './ScriptRunner';
import { FileExplorer, type FileExplorerHandle } from './FileExplorer';
import { useScripts } from '../../hooks/useScripts';
import { useGitStatus } from '../../hooks/useGitStatus';
import { isRecentFailure } from '../../lib/processFailure';
import { DRAG_SLOP_PX } from '../../hooks/useGridResize';
import type { WSMessage } from '../../types';
import { useHoverReveal } from '../../hooks/useHoverReveal';

// Git is heavy (diff rendering) — keep lazy
const GitChanges = lazy(() => import('./GitChanges').then(m => ({ default: m.GitChanges })));

interface ProjectSidebarProps {
  projectPath: string;
  /** Header label override — the task title for a task workspace (whose path
   *  basename is an opaque `<id8>`). Falls back to the path's folder name. */
  displayName?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenFile?: (path: string) => void;
  onWSMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onOpenProcessLog?: (processId: string, scriptName: string) => void;
  /**
   * DOVE VA LA BARRA CHIUSA: dentro la riga delle tab, non accanto a essa.
   *
   * «Facciamo diventare la sidebar chiusa direttamente parte della tabbar
   * progetto, in linea e non disposte verticalmente ma orizzontalmente, usando
   * il design a card e riportando anche titolo progetto, così da togliere linea
   * laterale inutile quando collassata» (Attilio, 09/08).
   *
   * Chiusa, questa colonna era una rail verticale da 40px col suo `border-r`:
   * una seconda superficie accanto alla riga di chrome, con una tinta sua e un
   * filo che scendeva per tutta l'altezza della finestra per contenere tre
   * icone. Adesso i suoi comandi vivono NELLA barra, in fila con le tab e con la
   * loro stessa grammatica — e la colonna, chiusa, non esiste proprio.
   *
   * Arriva come NODO e non come ref perché il nodo lo crea `ProjectWindow` una
   * volta sola (`document.createElement`) e `GroupLayout` lo aggancia dentro la
   * prima barra: esiste già al primo render, quindi il portale ha subito dove
   * scrivere e non c'è il fotogramma in cui la rail vecchia lampeggia prima di
   * sparire. Assente (`undefined`) = nessun ospite: si torna alla rail
   * verticale, che resta l'unico modo di riaprire la colonna.
   */
  inlineSlot?: HTMLElement;
}

type SectionId = 'files' | 'git' | 'processes';

/** La colonna di partenza: 224px, cioè il vecchio `w-56` cablato. */
const DEFAULT_SIDEBAR_W = 224;
/** Sotto, l'albero dei file diventa illeggibile; sopra, mangia la finestra. */
const MIN_SIDEBAR_W = 160;
const MAX_SIDEBAR_W = 560;

/**
 * Sotto questa altezza una sezione aperta non mostra nulla: è solo chrome.
 *
 * PER SEZIONE, perché le due non hanno lo stesso chrome. Git ne ha molto:
 * misurato, 32px di intestazione + 31 della riga di commit + 67 di piede
 * (Remotes e Cronologia) = 130, prima ancora di una riga di contenuto. Col
 * vecchio minimo unico di 96 il pannello non conteneva nemmeno se stesso, e a
 * cedere era la sezione Cronologia: schiacciata a 1px sui suoi 33 naturali,
 * cioè una fessura con dentro un'intestazione tagliata. 160 = quei 130 più una
 * riga di file, che è la promessa che questo minimo fa.
 *
 * Processi non ha piede: per lui 96 resta giusto.
 */
const MIN_USEFUL_H: Record<'git' | 'processes', number> = { git: 160, processes: 96 };
const DEFAULT_HEIGHTS: Record<'git' | 'processes', number> = { git: 200, processes: 150 };

/**
 * Un'icona della rail collassata, con la sua pastiglia.
 *
 * La rail è larga 40px: qui non ci sta una parola, ci sta un numero. La regola
 * è che ogni bottone porti AL PIÙ un sovrapposto — pastiglia numerica oppure
 * punto, mai entrambi — e che tutto il resto (il ramo, il conteggio esteso, il
 * perché) viva nel `title`, che è l'unico posto in cui c'è spazio davvero.
 */
function RailButton({
  icon: Icon,
  active,
  onClick,
  title,
  badge = null,
  tone = 'primary',
  dot = false,
  inline = false,
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: number | null;
  tone?: 'primary' | 'success' | 'danger';
  dot?: boolean;
  /**
   * IN FILA CON LE TAB, e allora il box lo detta la riga.
   *
   * Nella rail verticale il bottone stava in una colonna da 40 e `w-7 h-7`
   * andava bene su ogni schermo. Dentro la barra delle tab no: là la misura è
   * quella della tab che gli sta accanto ({@link ROW_ACTION_BOX}, 36 col dito e
   * 28 col mouse), o il comando respira diverso dalla sua vicina — è
   * esattamente il difetto appena tolto dal «+» e dal tasto che riapre la
   * colonna. L'anello della pastiglia segue: `ring-app-chrome` sulla rail,
   * dove il fondo è il chrome opaco; nella barra il fondo è il vetro, e
   * l'anello prende il colore della card.
   */
  inline?: boolean;
}) {
  const toneClass = tone === 'danger'
    ? 'bg-red-500 text-white'
    : tone === 'success'
      ? 'bg-emerald-500 text-white'
      : 'bg-primary text-white';
  const ring = inline ? 'ring-app-bg-elevated' : 'ring-app-chrome';
  if (inline) {
    return (
      <button
        onClick={onClick}
        title={title}
        aria-label={title}
        aria-expanded={active}
        className={`relative ${ROW_ACTION_BOX} flex items-center justify-center rounded-lg edge-lit transition-colors flex-shrink-0 ${
          active ? 'text-primary bg-primary/10' : `${RAISED_CONTROL} text-app-text`
        }`}
      >
        <Icon size={16} />
        {badge !== null && badge > 0 && (
          <span className={`absolute -top-1 -right-1 min-w-[15px] h-[15px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none tabular-nums ring-2 ${ring} ${toneClass}`}>
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {badge === null && dot && (
          <span className={`absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full ring-2 ${ring} ${toneClass}`} />
        )}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      // Acceso qui significa «questa sezione è APERTA»: è la stessa cosa che
      // dice l'evidenziazione, e a barra chiusa è l'unica anteprima di cosa
      // troverai riaprendola. Per questo restano accese anche tutte e tre.
      aria-expanded={active}
      className={`relative w-7 h-7 flex items-center justify-center rounded transition-colors ${
        active
          ? 'text-primary bg-primary/10'
          : 'text-app-text-muted hover:text-app-text-hover hover:bg-black/5 dark:hover:bg-white/5'
      }`}
    >
      <Icon size={16} />
      {badge !== null && badge > 0 && (
        // `ring` del colore della rail: senza, la pastiglia appoggiata
        // sull'icona si confonde col tratto sottostante e il numero perde il
        // bordo. Con l'anello resta leggibile anche sovrapposta.
        <span
          className={`absolute -top-1 -right-1 min-w-[15px] h-[15px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none tabular-nums ring-2 ring-app-chrome ${toneClass}`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {badge === null && dot && (
        <span className={`absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full ring-2 ring-app-chrome ${toneClass}`} />
      )}
    </button>
  );
}

export function ProjectSidebar({
  projectPath,
  displayName,
  collapsed,
  onToggleCollapse,
  onOpenFile,
  onWSMessage,
  onOpenProcessLog,
  inlineSlot,
}: ProjectSidebarProps) {
  const tr = useT();
  // I quattro comandi dell'intestazione «Files» (nuovo file, nuova cartella,
  // chiudi tutto, ricarica) non hanno un altro percorso col dito, e sono UNO
  // per pannello — non uno per riga —, quindi senza puntatore si vedono
  // (`touch: 'shown'`) invece di restare bersagli invisibili sull'header.
  const filesHeaderReveal = useHoverReveal('files', { touch: 'shown' });
  // Project name = the display override (task title) or the path's folder name.
  const projectName = displayName || projectPath.split('/').filter(Boolean).pop() || 'Project';
  // Auto-collapse on mobile
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // On mobile, start collapsed but allow toggling (renders as overlay)
  const effectiveCollapsed = collapsed;
  // Le chiavi portano il PROGETTO. Erano globali — `sidebar-sections` e
  // `project-sidebar-bottom-heights` secche — quindi due progetti affiancati si
  // scambiavano apertura e altezze, e ciò che avevi stretto su uno arrivava
  // stretto sull'altro senza averlo mai toccato lì.
  const SECTIONS_KEY = `sidebar-sections:${projectPath}`;
  const HEIGHTS_KEY = `project-sidebar-bottom-heights:${projectPath}`;
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() => {
    try {
      const saved = sessionStorage.getItem(SECTIONS_KEY) ?? sessionStorage.getItem('sidebar-sections');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { files: true, git: false, processes: false };
  });

  // Persist expanded sections across page refreshes
  useEffect(() => {
    try { sessionStorage.setItem(SECTIONS_KEY, JSON.stringify(expandedSections)); } catch {}
  }, [SECTIONS_KEY, expandedSections]);

  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Running process count for the Processes header badge (shared hook — no duplicate polling)
  const { scripts, runningCount } = useScripts({ projectPath, onMessage: onWSMessage });
  // La regola del «fallimento vero» sta in `lib/processFailure`, condivisa con
  // la lista dei processi: due copie della stessa soglia divergono al primo che
  // la tocca.
  const failedCount = scripts.filter(sp => isRecentFailure(sp)).length;

  // Stato git — dalla sidebar, non dal pannello. È questa la superficie che
  // sopravvive al collasso: GitChanges è lazy e SMONTATO quando la sezione è
  // chiusa, quindi se i numeri della rail dipendessero da lui sarebbero fermi
  // all'ultima volta che qualcuno ha aperto il pannello. Qui c'è anche l'unico
  // punto dell'albero che ha in mano `onWSMessage`: passarlo accende il push
  // `git:status` del watcher server-side per TUTTI i consumer del progetto
  // (store condiviso in useGitStatus), pannello e decorazioni dei file inclusi.
  const { gitStatus, notGit } = useGitStatus({ projectPath, onMessage: onWSMessage });
  const git = gitStatus && !notGit
    ? { branch: gitStatus.branch, fileCount: gitStatus.files?.length ?? 0, ahead: gitStatus.ahead ?? 0, behind: gitStatus.behind ?? 0 }
    : null;

  const toggleSection = (section: SectionId) => {
    setExpandedSections(prev => {
      const opening = !prev[section];
      // Aprire una sezione deve SEMPRE mostrare qualcosa. Git e Processi hanno
      // un'altezza in pixel salvata, e il minimo di trascinamento era 32px —
      // cioè esattamente l'altezza dell'intestazione: una sezione stretta fin
      // laggiù si «apriva» su zero pixel di contenuto e sembrava rotta (il
      // chevron ruotava e non compariva niente). Se l'altezza salvata non
      // lascia spazio, si riapre alla misura di partenza.
      if (opening && (section === 'git' || section === 'processes')) {
        setBottomHeights(h => (h[section] >= MIN_USEFUL_H[section] ? h : { ...h, [section]: DEFAULT_HEIGHTS[section] }));
      }
      return { ...prev, [section]: opening };
    });
  };

  // ── Larghezza della barra ────────────────────────────────────────────────
  // Per progetto, come apertura e altezze: un albero di file profondo e uno
  // piatto non vogliono la stessa colonna, e la misura giusta è quella che hai
  // scelto lì.
  const WIDTH_KEY = `project-sidebar-width:${projectPath}`;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = sessionStorage.getItem(WIDTH_KEY);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(n)) return Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, n));
    } catch {}
    return DEFAULT_SIDEBAR_W;
  });
  useEffect(() => {
    try { sessionStorage.setItem(WIDTH_KEY, String(sidebarWidth)); } catch {}
  }, [WIDTH_KEY, sidebarWidth]);

  // ── Bottom sections (Git, Processes) — anchored at bottom with pixel heights ──
  // Files fills remaining space (flex-1). Git/Processes pinned at bottom.
  const [bottomHeights, setBottomHeights] = useState<Record<'git' | 'processes', number>>(() => {
    try {
      const saved = sessionStorage.getItem(HEIGHTS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return { ...DEFAULT_HEIGHTS };
  });

  useEffect(() => {
    try { sessionStorage.setItem(HEIGHTS_KEY, JSON.stringify(bottomHeights)); } catch {}
  }, [HEIGHTS_KEY, bottomHeights]);

  const widthDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const dragRef = useRef<{
    section: 'git' | 'processes';
    otherSection?: 'git' | 'processes';
    startY: number;
    startHeight: number;
    otherStartHeight?: number;
  } | null>(null);

  // Full-viewport drag chrome (same protocol as useGridResize): keeps the
  // pointer out of iframes in the main area mid-drag and lets native Electron
  // WebContentsView panes hide via pane-resize-start/end. Raised lazily on
  // the first real movement so a bare click never retargets its mouseup.
  const dragOverlay = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 32px era l'altezza dell'INTESTAZIONE: si poteva trascinare una sezione
    // fino a farla sparire del tutto e poi non c'era modo di capire perché
    // «non si apriva». Il minimo lascia sempre una riga di contenuto.
    const minDi = (s: 'git' | 'processes') => MIN_USEFUL_H[s];
    const dropChrome = () => {
      if (dragOverlay.current) {
        dragOverlay.current.remove();
        dragOverlay.current = null;
        window.dispatchEvent(new Event('topics:pane-resize-end'));
      }
    };
    // Il velo a tutto schermo è lo STESSO delle altre resize (useGridResize):
    // tiene il puntatore fuori dagli iframe e dalle pane native mentre trascini,
    // e si alza solo al primo movimento vero, così un click secco non si
    // ritrova il mouseup su un altro bersaglio.
    const raiseChrome = (cursor: 'row-resize' | 'col-resize') => {
      if (dragOverlay.current) return;
      const ov = document.createElement('div');
      ov.style.cssText = `position:fixed;inset:0;z-index:2147483647;cursor:${cursor}`;
      document.body.appendChild(ov);
      dragOverlay.current = ov;
      window.dispatchEvent(new Event('topics:pane-resize-start'));
    };
    const onMove = (e: MouseEvent) => {
      const w = widthDragRef.current;
      if (w) {
        if ((e.buttons & 1) === 0) { onUp(); return; }
        const dx = e.clientX - w.startX;
        if (!dragOverlay.current && Math.abs(dx) <= DRAG_SLOP_PX) return;
        raiseChrome('col-resize');
        setSidebarWidth(Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, w.startWidth + dx)));
        return;
      }
      const r = dragRef.current;
      if (!r) return;
      // Lost-mouseup recovery: button no longer down — end the drag.
      if ((e.buttons & 1) === 0) { onUp(); return; }
      const delta = e.clientY - r.startY;
      if (!dragOverlay.current && Math.abs(delta) <= DRAG_SLOP_PX) return;
      raiseChrome('row-resize');
      if (r.otherSection) {
        // Redistributing between git ↔ processes
        const newTop = Math.max(minDi(r.section), r.startHeight - delta);
        const newBottom = Math.max(minDi(r.otherSection ?? r.section), (r.otherStartHeight || 0) + delta);
        setBottomHeights(prev => ({ ...prev, [r.section]: newTop, [r.otherSection!]: newBottom }));
      } else {
        // Resizing files ↔ bottom section
        setBottomHeights(prev => ({ ...prev, [r.section]: Math.max(minDi(r.section), r.startHeight - delta) }));
      }
    };
    const onUp = () => {
      if (!dragRef.current && !widthDragRef.current) return;
      dragRef.current = null;
      widthDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dropChrome();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Unmount mid-drag: balance the pane-resize-start already dispatched.
      dragRef.current = null;
      widthDragRef.current = null;
      dropChrome();
    };
  }, []);

  const startWidthResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    widthDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  /** Doppio click sul bordo: torna alla misura di partenza. */
  const resetWidth = useCallback(() => {
    widthDragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setSidebarWidth(DEFAULT_SIDEBAR_W);
  }, []);

  const startBottomResize = useCallback((section: 'git' | 'processes', otherSection?: 'git' | 'processes') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      section,
      startY: e.clientY,
      startHeight: bottomHeights[section],
      otherSection,
      otherStartHeight: otherSection ? bottomHeights[otherSection] : undefined,
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [bottomHeights]);

  if (effectiveCollapsed) {
    const open = (section: SectionId) => () => {
      onToggleCollapse();
      // Stesso cancello del toggle: una sezione stretta a zero deve tornare
      // utile anche quando la si apre dalla rail, non solo dall'intestazione.
      if (section === 'git' || section === 'processes') {
        setBottomHeights(h => (h[section] >= MIN_USEFUL_H[section] ? h : { ...h, [section]: DEFAULT_HEIGHTS[section] }));
      }
      setExpandedSections(prev => ({ ...prev, [section]: true }));
    };
    // Tooltip: è QUI che sta l'informazione lunga. Nella rail ci sono 40px, e
    // il numero da solo dice «c'è qualcosa», non «cosa». Il titolo completa.
    const plural = (key: string, n: number) =>
      n === 1 ? tr(`${key}.one`) : tr(`${key}.many`, { n });
    const gitTitle = git
      ? [
          `${tr('project.sidebar.gitChanges')} · ${git.branch}`,
          git.fileCount > 0
            ? plural('project.sidebar.changedFiles', git.fileCount)
            : tr('project.sidebar.clean'),
          [git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : '']
            .filter(Boolean).join(' '),
        ].filter(Boolean).join('\n')
      : tr('project.sidebar.gitChanges');
    const procTitle = failedCount > 0
      ? `${tr('project.sidebar.processes')}\n${plural('project.sidebar.processesFailed', failedCount)}`
      : runningCount > 0
        ? `${tr('project.sidebar.processes')}\n${plural('project.sidebar.processesRunning', runningCount)}`
        : tr('project.sidebar.processes');
    // I TRE COMANDI, una volta sola: la rail verticale e la striscia in linea
    // sono due presentazioni della stessa cosa, e ricopiarle vorrebbe dire due
    // liste che divergono al primo badge aggiunto.
    const comandi = (inline: boolean) => (
      <>
        <RailButton
          inline={inline}
          icon={FolderTree}
          active={expandedSections.files}
          onClick={open('files')}
          title={tr('project.sidebar.files')}
        />
        <RailButton
          inline={inline}
          icon={GitBranch}
          active={expandedSections.git}
          onClick={open('git')}
          title={gitTitle}
          // Il NOME DEL RAMO non entra e non ci va: nei tool seri il ramo vive
          // nella status bar. Qui ci va il numero che VS Code mette sulla stessa
          // icona — quante modifiche non committate — e il ramo sta nel
          // tooltip, per intero.
          badge={git && git.fileCount > 0 ? git.fileCount : null}
          tone="primary"
          // Nessuna modifica ma divergenza col remoto: un punto, non un secondo
          // numero addosso al primo. Due pastiglie su un bottone da 28px
          // diventano rumore e non si leggono più né l'una né l'altra.
          dot={!!git && git.fileCount === 0 && (git.ahead > 0 || git.behind > 0)}
        />
        <RailButton
          inline={inline}
          icon={CirclePlay}
          active={expandedSections.processes}
          onClick={open('processes')}
          title={procTitle}
          // Il rosso è il motivo per cui questo badge esiste: un processo uscito
          // male, oggi, non lo vedi da nessuna parte se la sidebar è chiusa.
          // Vince sul verde perché è l'unico dei due che chiede di fare
          // qualcosa.
          badge={failedCount > 0 ? failedCount : runningCount > 0 ? runningCount : null}
          tone={failedCount > 0 ? 'danger' : 'success'}
        />
      </>
    );

    // ANCHE COL DITO, e ci si arriva togliendo il nome. Con la card del titolo
    // la striscia faceva ~330px su uno schermo da 390: la barra intera, senza
    // più posto per le tab, e per questo il primo taglio la teneva spenta sul
    // telefono. Senza nome sono quattro box da 36 con 6 di aria — ~160px — e
    // «sulla versione mobile anche doveva essere aggiornata» (Attilio, 09/08)
    // diventa una cosa che ci sta.
    if (inlineSlot) {
      return createPortal(
        <div
          data-testid="project-rail-inline"
          // In fila con le tab e con la loro grammatica: `gap-0.5` come fra due
          // tab, `pl-1.5` cioè ROW_INSET dal bordo della riga. NIENTE filo di
          // separazione verso le tab — in questa colonna una linea fra card
          // ripete ciò che fondo e distanza dicono già (è la regola di
          // `selectionStyles`), ed era proprio la linea di troppo da togliere.
          // NON `flex-shrink-0`: con molte tab aperte qualcosa deve cedere, e a
          // cedere dev'essere il NOME (che tronca), non i comandi (che
          // sparirebbero). I bottoni sono `flex-shrink-0` da soli, quindi la
          // pressione arriva tutta sulla card del titolo.
          className={`flex items-center ${TAB_GAP_CLASS} pl-1.5 min-w-0 app-no-drag`}
          {...NO_DRAG_REGION}
        >
          <SidebarToggleButton
            onClick={onToggleCollapse}
            size="action"
            title={tr('project.sidebar.expand')}
            icon={PanelLeftOpen}
            className={`edge-lit ${RAISED_CONTROL} rounded-lg`}
          />
          {/* NIENTE NOME DEL PROGETTO qui, ed è una rimozione voluta (Attilio,
              09/08, subito dopo averlo visto): la riga sopra porta già la tab
              del progetto col suo nome, e ripeterlo un rigo sotto vuol dire
              scrivere due volte la stessa parola in due card diverse a 40px di
              distanza. Chiusa, la barra deve dire cosa si può APRIRE, non dove
              sei — quello lo dice già la tab che ti ha portato qui. */}
          {comandi(true)}
        </div>,
        inlineSlot,
      );
    }

    return (
      <div data-testid="project-sidebar-rail" className="chrome-glass w-10 flex-shrink-0 border-r border-app-border bg-app-chrome flex flex-col overflow-hidden">
        {/* Header — stessa riga di chrome della tab bar delle pane (h-10 +
            border-b, vedi GroupLayout) e dell'header espanso qui sotto: il
            bottone di espansione cade sulla STESSA linea mediana dei tab, e il
            bordo attraversa tutta la rail invece di essere un trattino w-6. */}
        <div data-testid="project-sidebar-rail-header" className="flex items-center justify-center h-10 border-b border-app-border flex-shrink-0">
          <SidebarToggleButton onClick={onToggleCollapse} size="sm" title={tr('project.sidebar.expand')} icon={PanelLeftOpen} />
        </div>
        <div className="flex flex-col items-center py-2 gap-1">
          {comandi(false)}
        </div>
      </div>
    );
  }

  // On mobile: render as overlay on top of content.
  // Su PORTALE, per lo stesso motivo del modale delle impostazioni: la sidebar
  // vive dentro la pane progetto, e il guscio delle pane ha `contain: layout`
  // (vedi PaneKeepAlive). Un containing block in mezzo trasformerebbe questo
  // drawer a tutta altezza in un riquadro grande quanto la pane. Il portale lo
  // riporta ad ancorarsi al viewport.
  if (isMobile) {
    return createPortal(
      <>
        <div className="fixed inset-0 bg-black/50 z-40" onClick={onToggleCollapse} aria-hidden="true" />
        <div
          // Stessa ancora della variante desktop: le due non convivono mai (il
          // ramo è esclusivo), e portare lo stesso nome fa sì che la ritaratura
          // dei token del chrome in index.css — agganciata a QUESTO selettore —
          // valga anche sul telefono, dove il fondo è identico.
          data-testid="project-sidebar"
          className="chrome-glass fixed inset-y-0 left-0 z-50 w-[280px] bg-app-chrome flex flex-col overflow-hidden shadow-lg border-r border-app-border"
          // IL FONDO SI FERMA SOPRA L'HOME INDICATOR. Il pannello è
          // `inset-y-0`, quindi la sua ultima riga finiva sotto il trattino:
          // uno spazio da cui non si può toccare niente, occupato da qualcosa
          // di toccabile. Il padding lo dipinge il background di QUESTO
          // elemento, quindi la fascia esce del colore del chrome e il bordo
          // dell'app resta continuo — il contenuto sale, la superficie no. È lo
          // stesso rimedio del composer (ChatInput) e della barra di stato
          // della sidebar principale.
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-app-border flex-shrink-0">
            <span className="text-[12px] font-semibold text-app-text truncate" title={projectName}>{projectName}</span>
            <SidebarToggleButton onClick={onToggleCollapse} size="sm" title={tr('project.sidebar.hide')} icon={PanelLeftClose} />
          </div>
          {/* Sections — Files fills top, Git/Processes anchored at bottom */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className={`flex flex-col ${expandedSections.files ? 'flex-1 min-h-0' : 'flex-shrink-0'}`}>
              <div
                onClick={() => toggleSection('files')}
                // Stessa ancora della variante desktop qui sotto.
                data-testid="project-sidebar-files"
                role="button"
                aria-expanded={expandedSections.files}
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none group/files"
              >
                <FolderTree size={14} className="flex-shrink-0" />
                <span>{tr('project.sidebar.files')}</span>
                <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
                {expandedSections.files && (
                  <div className={`ml-auto flex items-center gap-0.5 ${filesHeaderReveal}`} onClick={e => e.stopPropagation()}>
                    <button onClick={() => fileExplorerRef.current?.newFile()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFile')}><FilePlus size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.newFolder()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFolder')}><FolderPlus size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.collapseAll()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.collapseAll')}><ChevronsDownUp size={12} /></button>
                    <button onClick={() => fileExplorerRef.current?.refresh()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.refresh')}><RefreshCw size={12} /></button>
                  </div>
                )}
              </div>
              {expandedSections.files && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <FileExplorer ref={fileExplorerRef} projectPath={projectPath} compact onOpenFile={onOpenFile} onWSMessage={onWSMessage} />
                </div>
              )}
            </div>
            <div className="h-[1px] flex-shrink-0 bg-app-border" />
            <div
              className={`flex flex-col overflow-hidden ${expandedSections.git ? 'min-h-0' : 'flex-shrink-0'}`}
              style={expandedSections.git ? { height: bottomHeights.git } : undefined}
            >
              <Suspense fallback={
                <div onClick={() => toggleSection('git')} className="w-full flex items-center h-8 px-3 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <GitBranch size={14} className={`flex-shrink-0 ${git ? '' : 'text-app-text-muted'}`} />
                    <span>{tr('project.sidebar.gitChanges')}</span>
                    <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 text-app-text-tertiary ${expandedSections.git ? 'rotate-90' : ''}`} />
                  </div>
                </div>
              }>
                <GitChanges projectPath={projectPath} compact expanded={expandedSections.git} onToggle={() => toggleSection('git')} />
              </Suspense>
            </div>
            <div className="h-[1px] flex-shrink-0 bg-app-border" />
            <div
              className={`flex flex-col overflow-hidden ${expandedSections.processes ? 'min-h-0' : 'flex-shrink-0'}`}
              style={expandedSections.processes ? { height: bottomHeights.processes } : undefined}
            >
              <button
                onClick={() => toggleSection('processes')}
                // Ancora stabile per chi guarda da fuori: l'etichetta è tradotta
                // dal 9d1991ea («Multilingua: terzo lotto»), quindi il testo non
                // è un appiglio. E il bottone è un TOGGLE: `aria-expanded` è
                // l'unico modo di aprirlo senza rischiare di richiuderlo — il
                // gemello nella rail lo dichiara già (RailButton).
                data-testid="project-sidebar-processes"
                aria-expanded={expandedSections.processes}
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
              >
                <CirclePlay size={14} className="flex-shrink-0" />
                <span>{tr('project.sidebar.processes')}</span>
                <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.processes ? 'rotate-90' : ''}`} />
                {runningCount > 0 && (
                  <span className="ml-auto text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-[1px] rounded-full">
                    {runningCount}
                  </span>
                )}
              </button>
              {expandedSections.processes && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ScriptRunner projectPath={projectPath} onOpenProcessLog={onOpenProcessLog} />
                </div>
              )}
            </div>
          </div>
        </div>
      </>,
      document.body,
    );
  }

  return (
    <div
      data-testid="project-sidebar"
      // `bg-app-chrome`, non `bg-elevated`. Misurato in tema chiaro sul web:
      // questa colonna usciva #fafafa mentre la sidebar principale — l'altro
      // chrome della stessa finestra — usciva #eaecf0, e la pagina sotto è
      // #f8f9fa. Cioè la barra dei progetti era la superficie più CHIARA delle
      // tre: avanzava verso l'occhio invece di arretrare, al contrario di ogni
      // altro chrome («non mi sembra che abbia lo sfondo corretto rispetto al
      // tema», Attilio 08/08). La classe `chrome-glass` c'era già, ma sotto
      // Tauri/mac è l'unica cosa che dipinge: sul web e su Windows/Linux
      // restava `bg-elevated` a decidere, e nessuno lo vedeva dal Mac.
      //
      // Nessun rischio di doppia mano: la guardia anti-compounding è agganciata
      // alla CLASSE (`.chrome-glass .chrome-glass { transparent !important }`),
      // e sotto la shell il `!important` di quelle regole batte comunque questa
      // utility. Qui si corregge il ramo che la shell non attraversa.
      className="chrome-glass flex-shrink-0 border-r border-app-border bg-app-chrome flex flex-col overflow-hidden relative"
      style={{ width: sidebarWidth }}
    >
      {/* Maniglia sul bordo destro: invisibile, si annuncia col cursore.
          Colorarla al passaggio dava al bordo della barra un aspetto diverso da
          ogni altro bordo solo perche e trascinabile, e la barra non e un
          controllo.
          Sta dentro la barra (`right-0`), non fuori: la barra ha
          `overflow-hidden`, quindi una maniglia che sporge viene ritagliata per
          meta, resta visibile e non prende il mouse. */}
      <div
        data-testid="project-sidebar-resizer"
        onMouseDown={startWidthResize}
        onDoubleClick={resetWidth}
        title={tr('project.sidebar.resize')}
        className="absolute inset-y-0 right-0 w-2 z-20 cursor-col-resize"
      />
      {/* Header — height matches the pane tab bar (h-10) */}
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-app-border flex-shrink-0">
        <span className="text-[12px] font-semibold text-app-text-secondary truncate" title={projectName}>{projectName}</span>
        <SidebarToggleButton onClick={onToggleCollapse} size="sm" title={tr('project.sidebar.hide')} icon={PanelLeftClose} />
      </div>

      {/* Sections — Files fills top (flex-1), Git/Processes anchored at bottom */}
      <div className="flex-1 flex flex-col min-h-0">

        {/* Files Section — always flex-1 to push Git/Processes to bottom */}
        <div className="flex flex-col flex-1 min-h-0">
          <div
            onClick={() => toggleSection('files')}
            // Ancora stabile, come per Git e Processi: l'etichetta e' testo
            // tradotto e questo e' un TOGGLE — chi lo clicca alla cieca su una
            // sezione gia' aperta la richiude.
            data-testid="project-sidebar-files"
            role="button"
            aria-expanded={expandedSections.files}
            // Il bordo sotto SOLO da chiusa. Il contenitore di «File» resta
            // `flex-1` anche quando è chiusa — serve a spingere Git e Processi
            // in fondo — quindi il divisore da 1px finisce in fondo alla
            // colonna, lontanissimo dall'intestazione: la riga chiusa restava
            // senza linea, sospesa sopra il vuoto. Da aperta non serve, perché
            // sotto ci sono i file.
            //
            // Il COLORE sta fuori dalla condizione, e non è pignoleria: si
            // alterna solo `border-b`, cioè la LARGHEZZA. Con
            // `border-b border-app-border` dentro il ramo, chiudendo la sezione
            // il bordo lampeggiava scuro e poi sbiadiva — `transition-colors`
            // anima anche `border-color`, la larghezza no. Il preflight di
            // Tailwind v4 mette `border: 0 solid` senza colore, quindi il
            // colore di partenza era `currentColor`, che qui è
            // `--text-secondary` (#5a5a5a) contro un `--border` di #e8e8e8:
            // la linea compariva quasi nera e ci metteva 150ms a schiarirsi.
            // Tenendo il colore sempre acceso non c'è più niente da animare.
            className={`w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none group/files border-app-border ${
              expandedSections.files ? '' : 'border-b'
            }`}
          >
            <FolderTree size={14} className="flex-shrink-0" />
            <span>{tr('project.sidebar.files')}</span>
            <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
            {expandedSections.files && (
              <div className={`ml-auto flex items-center gap-0.5 ${filesHeaderReveal}`} onClick={e => e.stopPropagation()}>
                <button onClick={() => fileExplorerRef.current?.newFile()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFile')}><FilePlus size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.newFolder()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.newFolder')}><FolderPlus size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.collapseAll()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.collapseAll')}><ChevronsDownUp size={12} /></button>
                <button onClick={() => fileExplorerRef.current?.refresh()} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title={tr('project.sidebar.refresh')}><RefreshCw size={12} /></button>
              </div>
            )}
          </div>
          {expandedSections.files && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileExplorer ref={fileExplorerRef} projectPath={projectPath} compact onOpenFile={onOpenFile} onWSMessage={onWSMessage} />
            </div>
          )}
        </div>

        {/* Resize handle: Files ↔ first expanded bottom section */}
        {(() => {
          const firstBottom: 'git' | 'processes' | null = expandedSections.git ? 'git' : expandedSections.processes ? 'processes' : null;
          const active = !!firstBottom;
          return (
            <div
              className={`h-[1px] flex-shrink-0 relative bg-app-border transition-colors z-10 ${active ? 'cursor-row-resize hover:bg-primary' : ''}`}
              onMouseDown={active ? startBottomResize(firstBottom!) : undefined}
            >
              {active && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
            </div>
          );
        })()}

        {/* Git Section — anchored at bottom, fixed pixel height */}
        <div
          className={`flex flex-col overflow-hidden ${expandedSections.git ? 'min-h-0' : 'flex-shrink-0'}`}
          style={expandedSections.git ? { height: bottomHeights.git } : undefined}
        >
          <Suspense fallback={
            <div
              onClick={() => toggleSection('git')}
              className="w-full flex items-center h-8 px-3 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <GitBranch size={14} className={`flex-shrink-0 ${git ? '' : 'text-app-text-muted'}`} />
                <span>{tr('project.sidebar.gitChanges')}</span>
                <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 text-app-text-tertiary ${expandedSections.git ? 'rotate-90' : ''}`} />
                {git && (
                  <span className="text-app-text-muted truncate">{git.branch}</span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                {git && git.fileCount > 0 && (
                  <span className="text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-[1px] rounded-full">
                    {git.fileCount}
                  </span>
                )}
                {git && git.behind > 0 && (
                  <span className="text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-1 py-[1px] rounded-full">
                    ↓{git.behind}
                  </span>
                )}
                {git && git.ahead > 0 && (
                  <span className="text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1 py-[1px] rounded-full">
                    ↑{git.ahead}
                  </span>
                )}
                <span className="w-4 h-4 inline-flex items-center justify-center text-app-text-tertiary">
                  <span className="inline-flex items-center justify-center w-[10px] h-[10px] animate-spin">
                    <RefreshCw size={10} />
                  </span>
                </span>
              </div>
            </div>
          }>
            <GitChanges
              projectPath={projectPath}
              compact
              expanded={expandedSections.git}
              onToggle={() => toggleSection('git')}
            />
          </Suspense>
        </div>

        {/* Resize handle: Git ↔ Processes */}
        {(() => {
          const active = expandedSections.git && expandedSections.processes;
          return (
            <div
              className={`h-[1px] flex-shrink-0 relative bg-app-border transition-colors z-10 ${active ? 'cursor-row-resize hover:bg-primary' : ''}`}
              onMouseDown={active ? startBottomResize('git', 'processes') : undefined}
            >
              {active && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
            </div>
          );
        })()}

        {/* Processes Section — anchored at bottom, fixed pixel height */}
        <div
          className={`flex flex-col overflow-hidden ${expandedSections.processes ? 'min-h-0' : 'flex-shrink-0'}`}
          style={expandedSections.processes ? { height: bottomHeights.processes } : undefined}
        >
          <button
            onClick={() => toggleSection('processes')}
            // Stessa ancora della variante mobile qui sopra: l'etichetta è
            // tradotta (9d1991ea) e il bottone è un toggle, quindi il testid dice
            // «quale controllo» e `aria-expanded` dice «è già aperto?».
            data-testid="project-sidebar-processes"
            aria-expanded={expandedSections.processes}
            className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
          >
            <CirclePlay size={14} className="flex-shrink-0" />
            <span>{tr('project.sidebar.processes')}</span>
            <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.processes ? 'rotate-90' : ''}`} />
            {runningCount > 0 && (
              <span className="ml-auto text-[11px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1.5 py-[1px] rounded-full">
                {runningCount}
              </span>
            )}
          </button>
          {expandedSections.processes && (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <ScriptRunner projectPath={projectPath} onOpenProcessLog={onOpenProcessLog} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
