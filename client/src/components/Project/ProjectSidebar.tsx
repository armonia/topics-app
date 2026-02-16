import { useState, useEffect, lazy, Suspense } from 'react';
import { ChevronDown, ChevronRight, FolderTree, GitBranch, Zap, PanelLeftClose, PanelLeft } from 'lucide-react';
import { ProcessList } from './ProcessList';
import { ContextTemplates } from './ContextTemplates';
import { tasksApi } from '../../lib/api';
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
}

type SectionId = 'files' | 'git' | 'processes';

export function ProjectSidebar({ 
  projectPath, 
  topicId, 
  collapsed, 
  onToggleCollapse,
  onOpenFile,
  onWSMessage,
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
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>({
    files: true,
    git: false,
    processes: false,
  });

  // Resolve projectId for task board
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    tasksApi.getProjectId(topicId)
      .then(data => setProjectId(data.projectId))
      .catch(() => setProjectId(null));
  }, [topicId]);

  const toggleSection = (section: SectionId) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  if (effectiveCollapsed) {
    return (
      <div className="w-10 flex-shrink-0 border-r border-app-border bg-elevated flex flex-col items-center py-2 gap-1">
        <button
          onClick={onToggleCollapse}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted hover:text-app-text-hover transition-colors"
          title="Espandi sidebar"
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

      {/* Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Context Templates (Feature 1) */}
        <ContextTemplates topicId={topicId} projectPath={projectPath} />

        {/* Task Board (Feature 3) */}
        {projectId && onWSMessage && (
          <Suspense fallback={<SectionSpinner />}>
            <TaskBoard topicId={topicId} projectId={projectId} onWSMessage={onWSMessage} />
          </Suspense>
        )}

        {/* Files Section */}
        <div className="border-b border-app-border">
          <button
            onClick={() => toggleSection('files')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            {expandedSections.files ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <FolderTree size={13} />
            <span>Files</span>
          </button>
          {expandedSections.files && (
            <div className="max-h-64 overflow-y-auto">
              <Suspense fallback={<SectionSpinner />}>
                <FileExplorer projectPath={projectPath} compact onOpenFile={onOpenFile} />
              </Suspense>
            </div>
          )}
        </div>

        {/* Git Section */}
        <div className="border-b border-app-border">
          <button
            onClick={() => toggleSection('git')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            {expandedSections.git ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <GitBranch size={13} />
            <span>Git Changes</span>
          </button>
          {expandedSections.git && (
            <div className="max-h-64 overflow-y-auto">
              <Suspense fallback={<SectionSpinner />}>
                <GitChanges projectPath={projectPath} compact />
              </Suspense>
            </div>
          )}
        </div>

        {/* Processes Section */}
        <div>
          <button
            onClick={() => toggleSection('processes')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            {expandedSections.processes ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Zap size={13} />
            <span>Processes</span>
          </button>
          {expandedSections.processes && (
            <div className="max-h-48 overflow-y-auto">
              <ProcessList topicId={topicId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
