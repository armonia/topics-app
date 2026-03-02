import { useState, useRef, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { TaskCard } from './TaskCard';
import type { BoardTask, TaskStatus, Tag, Approval } from '../../lib/api';

interface KanbanColumnProps {
  id: TaskStatus;
  label: string;
  color: string;
  tasks: BoardTask[];
  tags: Tag[];
  isOver: boolean;
  projectId: string;
  topicId?: string;
  approvalsByTaskId?: Map<string, Approval>;
  heartbeatByTaskId?: Map<string, number>;
  onCreateTask: (data: { text: string; status?: TaskStatus }) => Promise<BoardTask>;
  onUpdateTask: (taskId: string, updates: Partial<BoardTask>) => Promise<BoardTask>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onSelectTask?: (task: BoardTask) => void;
  onReviewApproval?: (approvalId: string) => void;
}

export function KanbanColumn({
  id,
  label,
  color,
  tasks,
  tags: _tags,
  isOver,
  projectId: _projectId,
  topicId: _topicId,
  approvalsByTaskId,
  heartbeatByTaskId,
  onCreateTask,
  onUpdateTask: _onUpdateTask,
  onDeleteTask,
  onSelectTask,
  onReviewApproval,
}: KanbanColumnProps) {
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { setNodeRef } = useDroppable({ id });

  const taskIds = tasks.map(t => t.id);

  const handleAdd = useCallback(async () => {
    const trimmed = newText.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    try {
      await onCreateTask({ text: trimmed, status: id });
      setNewText('');
      setAdding(false);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  }, [newText, id, onCreateTask]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      } else if (e.key === 'Escape') {
        setNewText('');
        setAdding(false);
      }
    },
    [handleAdd],
  );

  const startAdding = useCallback(() => {
    setAdding(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  return (
    <div
      ref={setNodeRef}
      className={`
        flex flex-col min-w-[160px] max-w-[220px] w-[180px] rounded-md
        bg-app-bg/60 border border-app-border/40
        transition-all duration-150
        ${isOver ? 'ring-1 ring-primary/30 bg-primary/10' : ''}
      `}
    >
      {/* Column header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-app-border/30">
        <span className={`w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
        <span className="text-[11px] font-medium text-app-text truncate">{label}</span>
        <span className="ml-auto text-[10px] text-app-text-muted bg-app-bg/80 rounded px-1 min-w-[18px] text-center">
          {tasks.length}
        </span>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-1 min-h-[40px]">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 && !adding ? (
            <div className="text-[10px] text-app-text-muted text-center py-4 italic select-none">
              No tasks
            </div>
          ) : (
            tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                approval={approvalsByTaskId?.get(task.id)}
                lastHeartbeat={heartbeatByTaskId?.get(task.id)}
                onSelect={onSelectTask}
                onDelete={onDeleteTask}
                onReviewApproval={onReviewApproval}
              />
            ))
          )}
        </SortableContext>
      </div>

      {/* Add task */}
      <div className="px-1 pb-1">
        {adding ? (
          <div className="flex flex-col gap-1">
            <input
              ref={inputRef}
              type="text"
              className="w-full text-[11px] bg-surface border border-app-border/50 rounded px-1.5 py-1
                         text-app-text placeholder:text-app-text-muted/50
                         focus:outline-none focus:border-primary/40"
              placeholder="Task description..."
              value={newText}
              onChange={e => setNewText(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleAdd}
            />
          </div>
        ) : (
          <button
            onClick={startAdding}
            className="flex items-center gap-1 w-full text-[10px] text-app-text-muted
                       hover:text-app-text hover:bg-app-bg/60 rounded px-1.5 py-0.5
                       transition-colors cursor-pointer"
          >
            <Plus size={10} />
            Add
          </button>
        )}
      </div>
    </div>
  );
}
