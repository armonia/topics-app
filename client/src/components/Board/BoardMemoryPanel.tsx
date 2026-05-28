import { useState, useEffect, useCallback } from 'react';
import { Brain, RefreshCw, Send } from 'lucide-react';
import { boardMemoryApi, type BoardMemory } from '../../lib/api';
import type { WSMessage } from '../../types';

const TAG_COLORS: Record<string, string> = {
  decision: '#f59e0b',
  plan: '#3b82f6',
  handoff: '#8b5cf6',
  summary: '#10b981',
  webhook: '#ef4444',
};

interface BoardMemoryPanelProps {
  projectId: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function BoardMemoryPanel({ projectId, onWSMessage }: BoardMemoryPanelProps) {
  const [memory, setMemory] = useState<BoardMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [newContent, setNewContent] = useState('');
  const [newTags, setNewTags] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await boardMemoryApi.list(projectId, { limit: 100 });
      setMemory(data);
    } catch {
      // silent
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // WS sync
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.type === 'board:memory_added' && msg.projectId === projectId) {
        setMemory(prev => [msg.memory, ...prev]);
      }
    });
    return unsub;
  }, [onWSMessage, projectId]);

  const handleSubmit = useCallback(async () => {
    const content = newContent.trim();
    if (!content) return;
    const tags = newTags.split(',').map(t => t.trim()).filter(Boolean);
    try {
      await boardMemoryApi.create(projectId, { content, tags, source: 'user' });
      setNewContent('');
      setNewTags('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to create memory:', err);
      setSaveError('Failed to save memory');
      setTimeout(() => setSaveError(null), 3000);
    }
  }, [projectId, newContent, newTags]);

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  return (
    <div data-testid="board-memory-panel" className="flex flex-col h-full bg-surface text-app-text">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-app-border/40">
        <Brain size={14} className="text-emerald-400" />
        <span className="text-[12px] font-medium">Board Memory</span>
        <span className="text-[11px] text-app-text-muted ml-1">({memory.length})</span>
        <button onClick={load} className="ml-auto text-app-text-muted hover:text-app-text" title="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Memory entries */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {memory.length === 0 && !loading && (
          <div className="text-[11px] text-app-text-muted text-center py-8 italic">
            No memory entries yet. Agents will store decisions, plans, and handoffs here.
          </div>
        )}
        {memory.map(entry => (
          <div key={entry.id} className="border border-app-border/30 rounded px-2.5 py-2 bg-app-bg/40">
            {/* Tags + metadata */}
            <div className="flex items-center gap-1 mb-1 flex-wrap">
              {entry.tags.map(tag => (
                <span
                  key={tag}
                  className="text-[11px] px-1.5 py-[1px] rounded-sm font-medium"
                  style={{
                    backgroundColor: `${TAG_COLORS[tag] || '#6b7280'}22`,
                    color: TAG_COLORS[tag] || '#6b7280',
                  }}
                >
                  {tag}
                </span>
              ))}
              <span className="text-[11px] text-app-text-muted ml-auto">
                {timeAgo(entry.createdAt)}
              </span>
              {entry.source && (
                <span className="text-[11px] text-app-text-muted">
                  {entry.source}
                </span>
              )}
            </div>
            {/* Content */}
            <p className="text-[11px] text-app-text leading-relaxed whitespace-pre-wrap">
              {entry.content}
            </p>
          </div>
        ))}
      </div>

      {/* Add memory form */}
      <div className="border-t border-app-border/40 px-3 py-2">
        <textarea
          className="w-full text-[11px] bg-app-bg/60 border border-app-border/40 rounded px-2 py-1.5
                     text-app-text placeholder:text-app-text-muted/50
                     focus:outline-none focus:border-primary/40 resize-none"
          placeholder="Add a memory entry..."
          rows={2}
          value={newContent}
          onChange={e => setNewContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <div className="flex items-center gap-1.5 mt-1">
          <input
            className="flex-1 text-[11px] bg-app-bg/60 border border-app-border/40 rounded px-1.5 py-0.5
                       text-app-text placeholder:text-app-text-muted/50
                       focus:outline-none focus:border-primary/40"
            placeholder="Tags (comma-separated)"
            value={newTags}
            onChange={e => setNewTags(e.target.value)}
          />
          <button
            onClick={handleSubmit}
            disabled={!newContent.trim()}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded
                       bg-primary/20 text-primary hover:bg-primary/30
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={10} />
            Save
          </button>
          {saved && <span className="text-[11px] text-emerald-400 ml-1">Saved</span>}
          {saveError && <span className="text-[11px] text-red-400 ml-1">{saveError}</span>}
        </div>
      </div>
    </div>
  );
}
