import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { ChevronRight, FolderTree, GitBranch, Zap, RefreshCw, PanelLeftOpen, PanelLeftClose, FilePlus, FolderPlus, ChevronsDownUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { ScriptRunner } from './ScriptRunner';
import { FileExplorer, type FileExplorerHandle } from './FileExplorer';
import { useScripts } from '../../hooks/useScripts';
import { useGitStatus } from '../../hooks/useGitStatus';
import { DRAG_SLOP_PX } from '../../hooks/useGridResize';
import type { WSMessage } from '../../types';

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
}

type SectionId = 'files' | 'git' | 'processes';

/** Quanto a lungo un'uscita fallita resta degna della pastiglia rossa. */
const FAILURE_BADGE_WINDOW_MS = 10 * 60 * 1000;

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
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: number | null;
  tone?: 'primary' | 'success' | 'danger';
  dot?: boolean;
}) {
  const toneClass = tone === 'danger'
    ? 'bg-red-500 text-white'
    : tone === 'success'
      ? 'bg-emerald-500 text-white'
      : 'bg-primary text-white';
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
          className={`absolute -top-1 -right-1 min-w-[15px] h-[15px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-bold leading-none tabular-nums ring-2 ring-elevated ${toneClass}`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {badge === null && dot && (
        <span className={`absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full ring-2 ring-elevated ${toneClass}`} />
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
}: ProjectSidebarProps) {
  const tr = useT();
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
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() => {
    try {
      const saved = sessionStorage.getItem('sidebar-sections');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { files: true, git: false, processes: false };
  });

  // Persist expanded sections across page refreshes
  useEffect(() => {
    try { sessionStorage.setItem('sidebar-sections', JSON.stringify(expandedSections)); } catch {}
  }, [expandedSections]);

  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Running process count for the Processes header badge (shared hook — no duplicate polling)
  const { scripts, runningCount } = useScripts({ projectPath, onMessage: onWSMessage });
  // `status === 'error'` da solo NON è un fallimento, ed è la differenza fra un
  // segnale e un allarme che si impara a ignorare. `-1` è il codice-sentinella
  // di DUE casi che non chiedono niente a nessuno: lo stop volontario
  // (`processes.ts:716`) e «il processo è morto mentre il server era giù»
  // (`processes.ts:184`) — che su questa macchina, con TOPICS_SERVER_WATCH=1,
  // succede a OGNI salvataggio sotto `server/`: ogni dev server vivo diventa
  // `error`. Senza questo filtro la pastiglia rossa sarebbe accesa quasi sempre
  // e non vorrebbe dire niente. Serve un'uscita davvero non-zero, e recente:
  // `recent` è persistito su disco, quindi un fallimento di ieri resterebbe
  // rosso per sempre.
  const failedCount = scripts.filter(s => {
    if (s.status !== 'error' || (s.exitCode ?? -1) <= 0) return false;
    if (!s.completedAt) return false;
    const age = Date.now() - new Date(s.completedAt).getTime();
    return Number.isFinite(age) && age < FAILURE_BADGE_WINDOW_MS;
  }).length;

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
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // ── Bottom sections (Git, Processes) — anchored at bottom with pixel heights ──
  // Files fills remaining space (flex-1). Git/Processes pinned at bottom.
  const HEIGHTS_KEY = 'project-sidebar-bottom-heights';
  const [bottomHeights, setBottomHeights] = useState<Record<'git' | 'processes', number>>(() => {
    try {
      const saved = sessionStorage.getItem(HEIGHTS_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return { git: 200, processes: 150 };
  });

  useEffect(() => {
    try { sessionStorage.setItem(HEIGHTS_KEY, JSON.stringify(bottomHeights)); } catch {}
  }, [bottomHeights]);

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
    const MIN_H = 32;
    const dropChrome = () => {
      if (dragOverlay.current) {
        dragOverlay.current.remove();
        dragOverlay.current = null;
        window.dispatchEvent(new Event('topics:pane-resize-end'));
      }
    };
    const onMove = (e: MouseEvent) => {
      const r = dragRef.current;
      if (!r) return;
      // Lost-mouseup recovery: button no longer down — end the drag.
      if ((e.buttons & 1) === 0) { onUp(); return; }
      const delta = e.clientY - r.startY;
      if (!dragOverlay.current && Math.abs(delta) <= DRAG_SLOP_PX) return;
      if (!dragOverlay.current) {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:row-resize';
        document.body.appendChild(ov);
        dragOverlay.current = ov;
        window.dispatchEvent(new Event('topics:pane-resize-start'));
      }
      if (r.otherSection) {
        // Redistributing between git ↔ processes
        const newTop = Math.max(MIN_H, r.startHeight - delta);
        const newBottom = Math.max(MIN_H, (r.otherStartHeight || 0) + delta);
        setBottomHeights(prev => ({ ...prev, [r.section]: newTop, [r.otherSection!]: newBottom }));
      } else {
        // Resizing files ↔ bottom section
        setBottomHeights(prev => ({ ...prev, [r.section]: Math.max(MIN_H, r.startHeight - delta) }));
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
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
      dropChrome();
    };
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
    return (
      <div data-testid="project-sidebar-rail" className="chrome-glass w-10 flex-shrink-0 border-r border-app-border bg-elevated flex flex-col overflow-hidden">
        {/* Header — stessa riga di chrome della tab bar delle pane (h-10 +
            border-b, vedi GroupLayout) e dell'header espanso qui sotto: il
            bottone di espansione cade sulla STESSA linea mediana dei tab, e il
            bordo attraversa tutta la rail invece di essere un trattino w-6. */}
        <div data-testid="project-sidebar-rail-header" className="flex items-center justify-center h-10 border-b border-app-border flex-shrink-0">
          <SidebarToggleButton onClick={onToggleCollapse} size="sm" title={tr('project.sidebar.expand')} icon={PanelLeftOpen} />
        </div>
        <div className="flex flex-col items-center py-2 gap-1">
          <RailButton
            icon={FolderTree}
            active={expandedSections.files}
            onClick={open('files')}
            title={tr('project.sidebar.files')}
          />
          <RailButton
            icon={GitBranch}
            active={expandedSections.git}
            onClick={open('git')}
            title={gitTitle}
            // Il NOME DEL RAMO non entra e non ci va: 40px sono ~5 caratteri, e
            // nei tool seri il ramo vive nella status bar, non nella rail. Qui
            // ci va il numero che VS Code mette sulla stessa icona — quante
            // modifiche non committate — e il ramo sta nel tooltip, per intero.
            badge={git && git.fileCount > 0 ? git.fileCount : null}
            tone="primary"
            // Nessuna modifica ma divergenza col remoto: un punto, non un
            // secondo numero addosso al primo. Due pastiglie su un bottone da
            // 28px diventano rumore e non si leggono più né l'una né l'altra.
            dot={!!git && git.fileCount === 0 && (git.ahead > 0 || git.behind > 0)}
          />
          <RailButton
            icon={Zap}
            active={expandedSections.processes}
            onClick={open('processes')}
            title={procTitle}
            // Il rosso è il motivo per cui questo badge esiste: un processo
            // uscito male, oggi, non lo vedi da nessuna parte se la sidebar è
            // chiusa. Vince sul verde perché è l'unico dei due che chiede di
            // fare qualcosa.
            badge={failedCount > 0 ? failedCount : runningCount > 0 ? runningCount : null}
            tone={failedCount > 0 ? 'danger' : 'success'}
          />
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
        <div className="fixed inset-y-0 left-0 z-50 w-[280px] bg-elevated flex flex-col overflow-hidden shadow-lg border-r border-app-border">
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
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none group/files"
              >
                <FolderTree size={14} className="flex-shrink-0" />
                <span>{tr('project.sidebar.files')}</span>
                <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
                {expandedSections.files && (
                  <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/files:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
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
                    <GitBranch size={14} className={`flex-shrink-0 ${git ? 'text-primary' : 'text-app-text-muted'}`} />
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
                className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
              >
                <Zap size={14} className="flex-shrink-0" />
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
    <div className="chrome-glass w-56 flex-shrink-0 border-r border-app-border bg-elevated flex flex-col overflow-hidden">
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
            className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none group/files"
          >
            <FolderTree size={14} className="flex-shrink-0" />
            <span>{tr('project.sidebar.files')}</span>
            <ChevronRight size={12} className={`transition-transform duration-150 text-app-text-tertiary flex-shrink-0 ${expandedSections.files ? 'rotate-90' : ''}`} />
            {expandedSections.files && (
              <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/files:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
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
                <GitBranch size={14} className={`flex-shrink-0 ${git ? 'text-primary' : 'text-app-text-muted'}`} />
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
            className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
          >
            <Zap size={14} className="flex-shrink-0" />
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
