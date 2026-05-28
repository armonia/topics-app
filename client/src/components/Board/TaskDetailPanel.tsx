import { useState, useEffect, useCallback } from 'react';
import { X, MessageSquare, Link2, Clock, Tag, Send, Archive } from 'lucide-react';
import { boardsApi, type BoardTask, type TaskStatus, type TaskComment, type Tag as TagType } from '../../lib/api';

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', review: 'Review', done: 'Done',
};

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Critical', color: 'text-red-500' },
  1: { label: 'High', color: 'text-orange-400' },
  2: { label: 'Medium', color: 'text-blue-400' },
  3: { label: 'Low', color: 'text-gray-400' },
  4: { label: 'None', color: 'text-slate-500' },
};

interface TaskDetailPanelProps {
  task: BoardTask;
  projectId: string;
  tags: TagType[];
  onClose: () => void;
  onUpdate: (taskId: string, updates: Partial<BoardTask>) => void;
  onArchive?: (taskId: string) => void;
}

export function TaskDetailPanel({ task, projectId, tags: _tags, onClose, onUpdate, onArchive }: TaskDetailPanelProps) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(task.description || '');
  const [loadingComments, setLoadingComments] = useState(true);
  const [commentError, setCommentError] = useState<string | null>(null);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Load comments
  useEffect(() => {
    setLoadingComments(true);
    boardsApi.getComments(projectId, task.id)
      .then(data => { setComments(data.comments); setCommentError(null); })
      .catch(() => { setComments([]); setCommentError('Failed to load comments'); })
      .finally(() => setLoadingComments(false));
  }, [projectId, task.id]);

  const handleAddComment = useCallback(async () => {
    if (!newComment.trim()) return;
    try {
      const comment = await boardsApi.addComment(projectId, task.id, { content: newComment.trim() });
      setComments(prev => [...prev, comment]);
      setNewComment('');
    } catch (err) {
      console.error('Failed to add comment:', err);
      setCommentError('Failed to add comment');
      setTimeout(() => setCommentError(null), 3000);
    }
  }, [projectId, task.id, newComment]);

  const handleSaveDescription = useCallback(() => {
    onUpdate(task.id, { description } as any);
    setEditingDescription(false);
  }, [task.id, description, onUpdate]);

  const priority = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS[2];

  return (
    <div data-testid="task-detail-panel" className="fixed inset-y-0 right-0 w-[360px] bg-surface border-l border-app-border shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
        <span className="text-[12px] font-semibold text-app-text flex-1 truncate">{task.text}</span>
        <button onClick={onClose} className="text-app-text-muted hover:text-app-text p-0.5">
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* Status & Priority */}
        <div className="flex items-center gap-3 text-[11px]">
          <div>
            <span className="text-app-text-muted mr-1">Status:</span>
            <select
              value={task.status}
              onChange={e => onUpdate(task.id, { status: e.target.value as TaskStatus } as any)}
              className="bg-surface border border-app-border rounded px-1.5 py-0.5 text-[11px] text-app-text focus:outline-none focus:border-primary"
            >
              {Object.entries(STATUS_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="text-app-text-muted mr-1">Priority:</span>
            <select
              value={task.priority}
              onChange={e => onUpdate(task.id, { priority: parseInt(e.target.value) } as any)}
              className={`bg-surface border border-app-border rounded px-1.5 py-0.5 text-[11px] focus:outline-none focus:border-primary ${priority.color}`}
            >
              {Object.entries(PRIORITY_LABELS).map(([val, { label }]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Assigned */}
        {task.assignedTo && (
          <div className="text-[11px]">
            <span className="text-app-text-muted mr-1">Assigned:</span>
            <span className="text-app-text">{task.assignedTo}</span>
          </div>
        )}

        {/* Due date */}
        {task.dueDate && (
          <div className="flex items-center gap-1 text-[11px] text-app-text-muted">
            <Clock size={12} />
            <span>Due: {new Date(task.dueDate).toLocaleDateString()}</span>
          </div>
        )}

        {/* Tags */}
        {task.tags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <Tag size={12} className="text-app-text-muted" />
            {task.tags.map(tag => (
              <span
                key={tag.id}
                className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: tag.color + '20', color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Dependencies */}
        {(task.blockedBy.length > 0 || task.blocks.length > 0) && (
          <div className="text-[11px] space-y-1">
            <div className="flex items-center gap-1 text-app-text-muted">
              <Link2 size={12} />
              <span>Dependencies</span>
            </div>
            {task.blockedBy.length > 0 && (
              <div className="pl-4 text-yellow-500">
                Blocked by {task.blockedBy.length} task(s)
              </div>
            )}
            {task.blocks.length > 0 && (
              <div className="pl-4 text-app-text-muted">
                Blocks {task.blocks.length} task(s)
              </div>
            )}
          </div>
        )}

        {/* Description */}
        <div>
          <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Description</div>
          {editingDescription ? (
            <div className="space-y-1">
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 focus:outline-none focus:border-primary text-app-text resize-none min-h-[80px]"
                autoFocus
              />
              <div className="flex gap-1">
                <button onClick={handleSaveDescription} className="text-[11px] bg-primary text-white px-2 py-0.5 rounded">Save</button>
                <button onClick={() => { setEditingDescription(false); setDescription(task.description || ''); }} className="text-[11px] text-app-text-muted px-2 py-0.5">Cancel</button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => setEditingDescription(true)}
              className="text-[11px] text-app-text min-h-[30px] cursor-text hover:bg-black/3 dark:hover:bg-white/3 rounded px-1 py-0.5"
            >
              {task.description || <span className="text-app-placeholder italic">Click to add description...</span>}
            </div>
          )}
        </div>

        {/* Comments */}
        <div>
          <div className="flex items-center gap-1 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">
            <MessageSquare size={12} />
            <span>Comments ({comments.length})</span>
          </div>

          {loadingComments ? (
            <div className="text-[11px] text-app-placeholder py-2 text-center">Loading...</div>
          ) : (
            <div className="space-y-2">
              {comments.map(c => (
                <div key={c.id} className="bg-black/3 dark:bg-white/3 rounded px-2 py-1.5">
                  <div className="flex items-center gap-1 text-[11px] text-app-text-muted mb-0.5">
                    <span className="font-medium">{c.author}</span>
                    <span>&middot;</span>
                    <span>{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-[11px] text-app-text whitespace-pre-wrap">{c.content}</div>
                </div>
              ))}
            </div>
          )}

          {commentError && <div className="text-[11px] text-red-400 px-1 py-0.5">{commentError}</div>}

          {/* Add comment */}
          <div className="flex items-center gap-1 mt-2">
            <input
              value={newComment}
              onChange={e => setNewComment(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
              placeholder="Add a comment..."
              className="flex-1 text-[11px] bg-surface border border-app-border rounded px-2 py-1 focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder"
            />
            <button
              onClick={handleAddComment}
              disabled={!newComment.trim()}
              className="text-primary hover:text-primary/80 disabled:text-app-placeholder p-1"
            >
              <Send size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center px-3 py-1.5 border-t border-app-border text-[11px] text-app-text-muted">
        <span className="flex-1">
          Created {new Date(task.createdAt).toLocaleString()}
          {task.completedAt && <> &middot; Completed {new Date(task.completedAt).toLocaleString()}</>}
        </span>
        {onArchive && (
          <button
            onClick={() => { onArchive(task.id); onClose(); }}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-app-text-muted hover:text-yellow-500 hover:bg-yellow-500/10 transition-colors"
            title="Archive task"
          >
            <Archive size={10} />
            Archive
          </button>
        )}
      </div>
    </div>
  );
}
