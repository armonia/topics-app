import { useState, lazy, Suspense } from 'react';
import { X, Maximize2, Minimize2, GripVertical, MessageSquare, FolderTree, Globe, Terminal, GitBranch } from 'lucide-react';
import type { ProjectWindow as ProjectWindowType, WindowType } from '../../types/project';
import { WINDOW_CONFIG } from '../../types/project';
// Lazy-load heavy project components
const FileExplorer = lazy(() => import('./FileExplorer').then(m => ({ default: m.FileExplorer })));
const GitChanges = lazy(() => import('./GitChanges').then(m => ({ default: m.GitChanges })));
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));

const LazySpinner = () => (
  <div className="flex items-center justify-center h-full">
    <div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
  </div>
);

// Icon component mapping
const Icons: Record<string, React.FC<{ size: number; className?: string }>> = {
  MessageSquare,
  FolderTree,
  Globe,
  Terminal,
  GitBranch,
};

interface ProjectWindowProps {
  window: ProjectWindowType;
  isFocused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
  // Chat-specific props (passed through when type='chat')
  chatContent?: React.ReactNode;
}

export function ProjectWindowPanel({
  window: win,
  isFocused,
  onFocus,
  onClose,
  onDragStart,
  isDragOver,
  chatContent,
}: ProjectWindowProps) {
  const [maximized, setMaximized] = useState(false);
  
  const config = WINDOW_CONFIG[win.type];
  const IconComponent = Icons[config.icon] || MessageSquare;
  
  const title = win.title || (win.type === 'chat' 
    ? 'Chat' 
    : win.type === 'files' 
      ? (win.projectPath?.split('/').pop() || 'Files')
      : config.label);

  const renderContent = () => {
    switch (win.type) {
      case 'chat':
        return chatContent || (
          <div className="flex-1 flex items-center justify-center text-[#888]">
            <p className="text-[13px]">No chat content</p>
          </div>
        );
      
      case 'files':
        if (!win.projectPath) {
          return (
            <div className="flex-1 flex items-center justify-center text-[#888]">
              <div className="text-center">
                <FolderTree size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-[13px]">No project selected</p>
                <p className="text-[11px] text-[#666] mt-1">Open a topic with a project path</p>
              </div>
            </div>
          );
        }
        return <Suspense fallback={<LazySpinner />}><FileExplorer projectPath={win.projectPath} /></Suspense>;
      
      case 'browser':
        return <Suspense fallback={<LazySpinner />}><RemoteBrowserPanel contextId={win.topicId || 'default'} /></Suspense>;
      
      case 'git':
        if (!win.projectPath) {
          return (
            <div className="flex-1 flex items-center justify-center text-[#888]">
              <div className="text-center">
                <GitBranch size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-[13px]">No project selected</p>
              </div>
            </div>
          );
        }
        return <Suspense fallback={<LazySpinner />}><GitChanges projectPath={win.projectPath} /></Suspense>;
      
      case 'terminal':
        return (
          <div className="flex-1 flex items-center justify-center bg-black text-green-400 font-mono">
            <p className="text-[13px]">Terminal coming soon...</p>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div
      className={`flex flex-col h-full overflow-hidden rounded-lg border transition-all ${
        isFocused
          ? 'border-[var(--primary)] shadow-lg shadow-[var(--primary)]/10'
          : 'border-[#e8e8e8] dark:border-[#2a2a2a]'
      } ${isDragOver ? 'ring-2 ring-[var(--primary)] ring-opacity-50' : ''} ${
        maximized ? 'fixed inset-4 z-50' : ''
      }`}
      onClick={onFocus}
    >
      {/* Header */}
      <div
        className={`h-9 flex items-center gap-2 px-2 border-b flex-shrink-0 cursor-move ${
          isFocused
            ? 'bg-gradient-to-r from-[#f8f9fa] to-white dark:from-[#1e1e1e] dark:to-[#252525] border-[var(--primary)]/30'
            : 'bg-[#f8f9fa] dark:bg-[#1e1e1e] border-[#e8e8e8] dark:border-[#2a2a2a]'
        }`}
        draggable
        onDragStart={onDragStart}
      >
        {/* Drag handle */}
        <GripVertical size={14} className="text-[#999] dark:text-[#666] flex-shrink-0" />
        
        {/* Icon */}
        <IconComponent
          size={14}
          className="flex-shrink-0"
        />
        
        {/* Title */}
        <span className={`text-[12px] font-medium truncate flex-1 ${
          isFocused ? 'text-[#1a1a1a] dark:text-white' : 'text-[#666] dark:text-[#999]'
        }`}>
          {title}
        </span>
        
        {/* Window controls */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#888] hover:text-[#555] dark:hover:text-[#ccc] transition-colors"
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-500/10 text-[#888] hover:text-red-500 transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden bg-white dark:bg-[#1a1a1a]">
        {renderContent()}
      </div>
    </div>
  );
}

// Toolbar to add new windows
interface AddWindowToolbarProps {
  projectPath: string | null;
  onAddWindow: (type: WindowType) => void;
  openTypes: WindowType[];
}

export function AddWindowToolbar({ projectPath: _projectPath, onAddWindow, openTypes }: AddWindowToolbarProps) {
  const availableTypes: WindowType[] = ['files', 'browser', 'git', 'terminal'];
  
  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-[#f5f5f5] dark:bg-[#252525] border-b border-[#e8e8e8] dark:border-[#333]">
      <span className="text-[10px] text-[#888] uppercase tracking-wide mr-2">Add:</span>
      {availableTypes.map(type => {
        const config = WINDOW_CONFIG[type];
        const IconComponent = Icons[config.icon];
        const isOpen = openTypes.includes(type);
        
        return (
          <button
            key={type}
            onClick={() => onAddWindow(type)}
            disabled={isOpen && type !== 'browser'} // Allow multiple browsers
            className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
              isOpen && type !== 'browser'
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-white dark:hover:bg-[#333] text-[#666] dark:text-[#999]'
            }`}
            title={`Add ${config.label} window`}
          >
            <span style={{ color: config.color }}><IconComponent size={12} /></span>
            {config.label}
          </button>
        );
      })}
    </div>
  );
}
