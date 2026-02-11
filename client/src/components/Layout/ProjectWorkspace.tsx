import { useState, useCallback, lazy, Suspense } from 'react';
import {
  MessageSquare, FolderTree, Globe, GitBranch, Terminal, X
} from 'lucide-react';
import type { Topic } from '../../types';
// Lazy-load heavy project panels
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));

const LazySpinner = () => (
  <div className="flex items-center justify-center h-full">
    <div className="w-4 h-4 border-2 border-[#ccc] dark:border-[#555] border-t-[var(--primary)] rounded-full animate-spin" />
  </div>
);

type PaneType = 'chat' | 'files' | 'browser' | 'git' | 'terminal';

interface Pane {
  id: string;
  type: PaneType;
  title?: string;
}

interface ProjectWorkspaceProps {
  topic: Topic;
  isFocused: boolean;
  onFocus: () => void;
  onClose: () => void;
  chatContent: React.ReactNode;
}

const PANE_CONFIG: Record<PaneType, { icon: React.ReactNode; label: string; color: string }> = {
  chat: { icon: <MessageSquare size={14} />, label: 'Chat', color: 'var(--primary)' },
  files: { icon: <FolderTree size={14} />, label: 'Files', color: '#f59e0b' },
  browser: { icon: <Globe size={14} />, label: 'Browser', color: '#10b981' },
  git: { icon: <GitBranch size={14} />, label: 'Git', color: '#ef4444' },
  terminal: { icon: <Terminal size={14} />, label: 'Terminal', color: '#8b5cf6' },
};

export function ProjectWorkspace({
  topic,
  isFocused,
  onFocus,
  onClose,
  chatContent,
}: ProjectWorkspaceProps) {
  // Panes state - starts with just chat
  const [panes, setPanes] = useState<Pane[]>([
    { id: 'main-chat', type: 'chat' }
  ]);
  const [activePaneId, setActivePaneId] = useState('main-chat');
  const [splitDirection, _setSplitDirection] = useState<'horizontal' | 'vertical'>('horizontal');
  const [_splitRatio, _setSplitRatio] = useState(0.5);
  const [_isResizing, _setIsResizing] = useState(false);

  const hasProject = !!topic.projectPath;

  const addPane = useCallback((type: PaneType) => {
    const id = `${type}-${Date.now()}`;
    setPanes(prev => [...prev, { id, type }]);
    setActivePaneId(id);
  }, []);

  const removePane = useCallback((id: string) => {
    setPanes(prev => {
      const newPanes = prev.filter(p => p.id !== id);
      if (newPanes.length === 0) {
        // Don't remove the last pane, switch to chat
        return [{ id: 'main-chat', type: 'chat' as PaneType }];
      }
      if (activePaneId === id) {
        setActivePaneId(newPanes[newPanes.length - 1].id);
      }
      return newPanes;
    });
  }, [activePaneId]);

  const renderPaneContent = (pane: Pane) => {
    switch (pane.type) {
      case 'chat':
        return chatContent;
      
      case 'files':
        if (!hasProject) {
          return (
            <div className="flex-1 flex items-center justify-center text-[#888]">
              <div className="text-center">
                <FolderTree size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-[13px]">No project linked</p>
                <p className="text-[11px] text-[#666] mt-1">Link a project in topic settings</p>
              </div>
            </div>
          );
        }
        return <Suspense fallback={<LazySpinner />}><FileExplorer projectPath={topic.projectPath!} /></Suspense>;
      
      case 'browser':
        return <Suspense fallback={<LazySpinner />}><RemoteBrowserPanel contextId={topic.id} /></Suspense>;
      
      case 'git':
        if (!hasProject) {
          return (
            <div className="flex-1 flex items-center justify-center text-[#888]">
              <div className="text-center">
                <GitBranch size={32} className="mx-auto mb-3 opacity-50" />
                <p className="text-[13px]">No project linked</p>
              </div>
            </div>
          );
        }
        return <Suspense fallback={<LazySpinner />}><GitChanges projectPath={topic.projectPath!} /></Suspense>;
      
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

  const renderPane = (pane: Pane, isOnly: boolean) => {
    const config = PANE_CONFIG[pane.type];
    const isActive = pane.id === activePaneId;

    return (
      <div
        key={pane.id}
        className={`flex flex-col min-h-0 overflow-hidden ${
          isOnly ? 'flex-1' : ''
        } ${isActive ? 'ring-1 ring-[var(--primary)]/30' : ''}`}
        onClick={() => setActivePaneId(pane.id)}
      >
        {/* Pane header */}
        <div className={`h-8 flex items-center gap-1.5 px-2 border-b flex-shrink-0 ${
          isActive 
            ? 'bg-[#f8f9fa] dark:bg-[#252525] border-[var(--primary)]/30' 
            : 'bg-[#f5f5f5] dark:bg-[#1e1e1e] border-[#e8e8e8] dark:border-[#2a2a2a]'
        }`}>
          <span style={{ color: config.color }}>{config.icon}</span>
          <span className={`text-[11px] font-medium flex-1 truncate ${
            isActive ? 'text-[#1a1a1a] dark:text-white' : 'text-[#666] dark:text-[#999]'
          }`}>
            {pane.title || config.label}
          </span>
          {!isOnly && (
            <button
              onClick={(e) => { e.stopPropagation(); removePane(pane.id); }}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/10 text-[#888] hover:text-red-500"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Pane content */}
        <div className="flex-1 min-h-0 overflow-hidden bg-white dark:bg-[#1a1a1a]">
          {renderPaneContent(pane)}
        </div>
      </div>
    );
  };

  // Available pane types to add
  const availableTypes: PaneType[] = ['files', 'browser', 'git', 'terminal'];
  const openTypes = panes.map(p => p.type);

  return (
    <div 
      className={`flex flex-col h-full overflow-hidden bg-white dark:bg-[#1a1a1a] ${
        isFocused ? 'ring-1 ring-[var(--primary)]' : ''
      }`}
      onClick={onFocus}
    >
      {/* Main header */}
      <div className="h-9 flex items-center gap-2 px-2 border-b border-[#e8e8e8] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#1e1e1e] flex-shrink-0">
        <span className="text-[14px]">{topic.icon}</span>
        <span className="text-[12px] font-medium text-[#1a1a1a] dark:text-white truncate max-w-[150px]">
          {topic.name}
        </span>
        {hasProject && (
          <span className="text-[9px] bg-[var(--primary)]/10 text-[var(--primary)] px-1.5 py-0.5 rounded">
            {topic.projectPath?.split('/').pop()}
          </span>
        )}
        
        <div className="flex-1" />
        
        {/* Add pane buttons */}
        <div className="flex items-center gap-0.5 border-l border-[#e8e8e8] dark:border-[#333] pl-2 ml-2">
          {availableTypes.map(type => {
            const config = PANE_CONFIG[type];
            const isOpen = openTypes.includes(type) && type !== 'browser'; // Allow multiple browsers
            return (
              <button
                key={type}
                onClick={(e) => { e.stopPropagation(); addPane(type); }}
                disabled={isOpen}
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                  isOpen
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-[#888] hover:text-[#555] dark:hover:text-[#ccc]'
                }`}
                title={`Add ${config.label}`}
              >
                {config.icon}
              </button>
            );
          })}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-500/10 text-[#888] hover:text-red-500"
        >
          <X size={14} />
        </button>
      </div>

      {/* Panes area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {panes.length === 1 ? (
          renderPane(panes[0], true)
        ) : (
          <div className={`flex-1 flex ${splitDirection === 'horizontal' ? 'flex-row' : 'flex-col'} min-h-0`}>
            {panes.map((pane, idx) => (
              <div 
                key={pane.id}
                className="flex-1 min-w-0 min-h-0 overflow-hidden"
                style={idx > 0 ? { 
                  borderLeft: splitDirection === 'horizontal' ? '1px solid var(--border-color, #e8e8e8)' : undefined,
                  borderTop: splitDirection === 'vertical' ? '1px solid var(--border-color, #e8e8e8)' : undefined,
                } : undefined}
              >
                {renderPane(pane, false)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
