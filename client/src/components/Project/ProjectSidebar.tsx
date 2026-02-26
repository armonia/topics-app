import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { ChevronRight, FolderTree, GitBranch, Zap, PanelLeftClose, PanelLeft, RefreshCw } from 'lucide-react';
import { ScriptRunner } from './ScriptRunner';
import type { WSMessage } from '../../types';

// Lazy-load heavy project components
const FileExplorer = lazy(() => import('./FileExplorer').then(m => ({ default: m.FileExplorer })));
const GitChanges = lazy(() => import('./GitChanges').then(m => ({ default: m.GitChanges })));
const TaskBoard = lazy(() => import('./TaskBoard').then(m => ({ default: m.TaskBoard })));

const SectionSpinner = () => (
  <div className="flex items-center justify-center py-4">
    <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
  </div>
);

interface ProjectSidebarProps {
  projectPath: string;
  topicId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenFile?: (path: string) => void;
  onWSMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onOpenBoard?: () => void;
  onOpenProcessLog?: (processId: string, scriptName: string) => void;
}

type SectionId = 'files' | 'git' | 'processes';

export function ProjectSidebar({
  projectPath,
  topicId,
  collapsed,
  onToggleCollapse,
  onOpenFile,
  onWSMessage,
  onOpenBoard,
  onOpenProcessLog,
}: ProjectSidebarProps) {
  // Auto-collapse on mobile
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // Force collapsed on mobile
  const effectiveCollapsed = isMobile ? true : collapsed;
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

  // Use same projectId as KanbanBoard (encodeURIComponent of projectPath)
  const projectId = projectPath ? encodeURIComponent(projectPath) : null;

  // Read cached git status for Suspense fallback (avoids flash without branch/changes)
  const cachedGit = (() => {
    try {
      const raw = sessionStorage.getItem(`git-status-cache:${projectPath}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { status?: { branch?: string; files?: unknown[]; ahead?: number; behind?: number } };
        const s = parsed?.status;
        if (s?.branch) return { branch: s.branch, fileCount: s.files?.length ?? 0, ahead: s.ahead ?? 0, behind: s.behind ?? 0 };
      }
    } catch {}
    return null;
  })();

  const toggleSection = (section: SectionId) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // ── Bottom sections (Git, Processes) pixel-height drag-resize ──
  // Files fills remaining space (flex-1). Git/Processes are anchored to bottom with fixed heights.
  const [bottomHeights, setBottomHeights] = useState(() => {
    try {
      const saved = sessionStorage.getItem('sidebar-bottom-heights');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { git: 200, processes: 150 };
  });

  useEffect(() => {
    try { sessionStorage.setItem('sidebar-bottom-heights', JSON.stringify(bottomHeights)); } catch {}
  }, [bottomHeights]);
  const bottomRefs = useRef<{ git: HTMLDivElement | null; processes: HTMLDivElement | null }>({ git: null, processes: null });
  const resizeRef = useRef<{
    section: 'git' | 'processes';
    startY: number;
    startHeight: number;
    // For git↔processes resize: also adjust the other section
    otherSection?: 'git' | 'processes';
    otherStartHeight?: number;
  } | null>(null);

  useEffect(() => {
    const MIN_H = 32; // minimum = just the header
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientY - r.startY;
      if (r.otherSection) {
        // Redistributing between git ↔ processes
        const newTop = r.startHeight - delta;
        const newBottom = (r.otherStartHeight || 0) + delta;
        if (newTop >= MIN_H && newBottom >= MIN_H) {
          const topEl = bottomRefs.current[r.section];
          const bottomEl = bottomRefs.current[r.otherSection];
          if (topEl) topEl.style.height = `${newTop}px`;
          if (bottomEl) bottomEl.style.height = `${newBottom}px`;
        }
      } else {
        // Resizing files ↔ bottom section (only adjust bottom section height)
        const newH = r.startHeight - delta;
        if (newH >= MIN_H) {
          const el = bottomRefs.current[r.section];
          if (el) el.style.height = `${newH}px`;
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const delta = e.clientY - r.startY;
      if (r.otherSection) {
        const newTop = Math.max(MIN_H, r.startHeight - delta);
        const newBottom = Math.max(MIN_H, (r.otherStartHeight || 0) + delta);
        setBottomHeights(prev => ({ ...prev, [r.section]: newTop, [r.otherSection!]: newBottom }));
      } else {
        const newH = Math.max(MIN_H, r.startHeight - delta);
        setBottomHeights(prev => ({ ...prev, [r.section]: newH }));
      }
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const startBottomResize = useCallback((section: 'git' | 'processes', otherSection?: 'git' | 'processes') => (e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = {
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
    return (
      <div className="w-10 flex-shrink-0 border-r border-app-border bg-elevated flex flex-col items-center py-2 gap-1">
        <button
          onClick={onToggleCollapse}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted hover:text-app-text-hover transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft size={16} />
        </button>
        <div className="w-6 h-px bg-app-border my-1" />
        <button
          onClick={() => { onToggleCollapse(); setExpandedSections(prev => ({ ...prev, files: true })); }}
          className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
            expandedSections.files ? 'text-primary bg-primary/10' : 'text-app-text-muted hover:text-app-text-hover hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title="Files"
        >
          <FolderTree size={15} />
        </button>
        <button
          onClick={() => { onToggleCollapse(); setExpandedSections(prev => ({ ...prev, git: true })); }}
          className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
            expandedSections.git ? 'text-primary bg-primary/10' : 'text-app-text-muted hover:text-app-text-hover hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title="Git Changes"
        >
          <GitBranch size={15} />
        </button>
        <button
          onClick={() => { onToggleCollapse(); setExpandedSections(prev => ({ ...prev, processes: true })); }}
          className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
            expandedSections.processes ? 'text-primary bg-primary/10' : 'text-app-text-muted hover:text-app-text-hover hover:bg-black/5 dark:hover:bg-white/5'
          }`}
          title="Processes"
        >
          <Zap size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-56 flex-shrink-0 border-r border-app-border bg-elevated flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-app-border">
        <span className="text-[11px] font-medium text-app-text-muted uppercase tracking-wide">Project</span>
        <button
          onClick={onToggleCollapse}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted hover:text-app-text-hover transition-colors"
          title="Hide sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* Sections — Files fills top (flex-1), Git/Processes anchored to bottom */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* ── Top area: fixed content + Files (fills remaining space) ── */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Fixed content at top */}
          <div className="flex-shrink-0">
            {projectId && onWSMessage && (
              <Suspense fallback={<SectionSpinner />}>
                <TaskBoard topicId={topicId} projectId={projectId} onWSMessage={onWSMessage} onOpenBoard={onOpenBoard} />
              </Suspense>
            )}
          </div>

          {/* Files Section — fills remaining top space */}
          <div className={expandedSections.files ? 'flex-1 min-h-0 flex flex-col' : 'flex-shrink-0'}>
            <button
              onClick={() => toggleSection('files')}
              className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
            >
              <ChevronRight size={12} className={`transition-transform duration-150 ${expandedSections.files ? 'rotate-90' : ''}`} />
              <FolderTree size={14} />
              <span>Files</span>
            </button>
            {expandedSections.files && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <Suspense fallback={<SectionSpinner />}>
                  <FileExplorer projectPath={projectPath} compact onOpenFile={onOpenFile} />
                </Suspense>
              </div>
            )}
          </div>
        </div>

        {/* ── Resize handle: Files ↔ first expanded bottom section ── */}
        {(() => {
          const firstBottom: 'git' | 'processes' | null = expandedSections.git ? 'git' : expandedSections.processes ? 'processes' : null;
          const active = expandedSections.files && firstBottom;
          return (
            <div
              className={`h-[1px] flex-shrink-0 relative bg-app-border transition-colors z-10 ${active ? 'cursor-row-resize hover:bg-primary' : ''}`}
              onMouseDown={active ? startBottomResize(firstBottom!) : undefined}
            >
              {active && <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />}
            </div>
          );
        })()}

        {/* ── Bottom area: Git + Processes (anchored, fixed pixel heights) ── */}

        {/* Git Section */}
        <div
          ref={el => { bottomRefs.current.git = el; }}
          className={expandedSections.git ? 'flex-shrink-0 flex flex-col min-h-0 overflow-hidden' : 'flex-shrink-0'}
          style={expandedSections.git ? { height: bottomHeights.git } : undefined}
        >
          <Suspense fallback={
            <div
              onClick={() => toggleSection('git')}
              className="w-full flex items-center h-8 px-3 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <ChevronRight size={12} className={`flex-shrink-0 transition-transform duration-150 ${expandedSections.git ? 'rotate-90' : ''}`} />
                <GitBranch size={14} className={`flex-shrink-0 ${cachedGit ? 'text-primary' : 'text-app-text-muted'}`} />
                <span>Git</span>
                {cachedGit && (
                  <span className="text-app-text-muted truncate">{cachedGit.branch}</span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                {cachedGit && cachedGit.fileCount > 0 && (
                  <span className="text-[9px] font-medium text-primary bg-primary/10 px-1.5 py-[1px] rounded-full">
                    {cachedGit.fileCount}
                  </span>
                )}
                {cachedGit && cachedGit.behind > 0 && (
                  <span className="text-[9px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-1 py-[1px] rounded-full">
                    ↓{cachedGit.behind}
                  </span>
                )}
                {cachedGit && cachedGit.ahead > 0 && (
                  <span className="text-[9px] font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-1 py-[1px] rounded-full">
                    ↑{cachedGit.ahead}
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

        {/* Processes & Scripts Section */}
        <div
          ref={el => { bottomRefs.current.processes = el; }}
          className={expandedSections.processes ? 'flex-shrink-0 flex flex-col min-h-0 overflow-hidden' : 'flex-shrink-0'}
          style={expandedSections.processes ? { height: bottomHeights.processes } : undefined}
        >
          <button
            onClick={() => toggleSection('processes')}
            className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
          >
            <ChevronRight size={12} className={`transition-transform duration-150 ${expandedSections.processes ? 'rotate-90' : ''}`} />
            <Zap size={14} />
            <span>Processes</span>
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
