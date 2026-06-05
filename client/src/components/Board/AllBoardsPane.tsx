import { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader2, Crown } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  useSensor,
  useSensors,
  PointerSensor,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { globalBoardApi, boardsApi, type BoardTask, type TaskStatus } from '../../lib/api';
import type { WSMessage } from '../../types';
import { AgentsBoardSection } from './AgentsBoardSection';

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: 'text-app-text-muted' },
  { id: 'todo', label: 'Todo', color: 'text-blue-400' },
  { id: 'in_progress', label: 'In Progress', color: 'text-yellow-400' },
  { id: 'review', label: 'Review', color: 'text-purple-400' },
  { id: 'done', label: 'Done', color: 'text-green-400' },
];

interface AllBoardsPaneProps {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** KANBAN-DELTA-01 — jump from a task card's teammate badge to its pane. */
  onJumpToTopic?: (topicId: string) => void;
}

function getProjectLabel(projectId: string): string {
  try {
    const decoded = decodeURIComponent(projectId);
    const parts = decoded.split('/');
    return parts[parts.length - 1] || projectId;
  } catch {
    return projectId;
  }
}

export function AllBoardsPane({ onMessage, onJumpToTopic }: AllBoardsPaneProps) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Fetch all tasks
  useEffect(() => {
    setLoading(true);
    globalBoardApi.listTasks()
      .then(data => { setTasks(data.tasks); setError(null); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // WS sync
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      if (msg.type === 'task:created' || msg.type === 'task:moved') {
        setTasks(prev => {
          const exists = prev.some(t => t.id === msg.task.id);
          if (exists) return prev.map(t => t.id === msg.task.id ? msg.task : t);
          return [...prev, msg.task];
        });
      }
      if (msg.type === 'task:updated') {
        setTasks(prev => prev.map(t => t.id === msg.task.id ? msg.task : t));
      }
      if (msg.type === 'task:deleted') {
        setTasks(prev => prev.filter(t => t.id !== msg.taskId));
      }
    });
  }, [onMessage]);

  // Group by column
  const columns = useMemo(() => {
    const groups: Record<TaskStatus, BoardTask[]> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    };
    for (const t of tasks) {
      (groups[t.status] || groups.todo).push(t);
    }
    for (const col of Object.values(groups)) {
      col.sort((a, b) => (a.kanbanOrder ?? 0) - (b.kanbanOrder ?? 0));
    }
    return groups;
  }, [tasks]);

  // Drag handlers
  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active.id as string);
  }, []);

  const handleDragOver = useCallback((e: DragOverEvent) => {
    const { over } = e;
    if (!over) { setOverColumn(null); return; }
    const overId = over.id as string;
    if (COLUMNS.some(c => c.id === overId)) {
      setOverColumn(overId as TaskStatus);
    } else {
      for (const col of COLUMNS) {
        if (columns[col.id].some(t => t.id === overId)) {
          setOverColumn(col.id);
          break;
        }
      }
    }
  }, [columns]);

  const handleDragEnd = useCallback(async (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    setOverColumn(null);
    if (!over) return;

    const taskId = active.id as string;
    const overId = over.id as string;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const sourceCol = task.status;
    let targetCol = sourceCol;
    if (COLUMNS.some(c => c.id === overId)) {
      targetCol = overId as TaskStatus;
    } else {
      for (const col of COLUMNS) {
        if (columns[col.id].some(t => t.id === overId)) {
          targetCol = col.id;
          break;
        }
      }
    }

    if (sourceCol === targetCol && taskId !== overId) {
      // Reorder within column
      const colItems = [...columns[sourceCol]];
      const oldIdx = colItems.findIndex(t => t.id === taskId);
      const newIdx = colItems.findIndex(t => t.id === overId);
      if (oldIdx !== -1 && newIdx !== -1) {
        const reordered = arrayMove(colItems, oldIdx, newIdx);
        setTasks(prev => {
          const others = prev.filter(t => t.status !== sourceCol);
          return [...others, ...reordered.map((t, i) => ({ ...t, kanbanOrder: i }))];
        });
        try {
          await Promise.all(reordered.map((t, i) =>
            boardsApi.updateTask(t.projectId, t.id, { kanbanOrder: i })
          ));
        } catch {}
      }
    } else if (sourceCol !== targetCol) {
      // Move to different column
      const newOrder = columns[targetCol].length;
      setTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: targetCol, kanbanOrder: newOrder } : t
      ));
      try {
        await boardsApi.moveTask(task.projectId, taskId, targetCol, newOrder);
      } catch {
        setTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: sourceCol } : t
        ));
      }
    }
  }, [tasks, columns]);

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-app-text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-[12px]">
        {error}
      </div>
    );
  }

  return (
    <div data-testid="all-boards-pane" className="flex-1 flex flex-col min-h-0">
      {/* Master session header (MASTER-01 — Variant A: global multi-project Master) */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-app-border/40">
        <div className="text-[11px] text-app-text-muted">
          Global board · all projects
        </div>
        <button
          type="button"
          data-testid="start-master-session"
          onClick={() => window.dispatchEvent(new CustomEvent('open-master'))}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-500/15 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors"
          title="Apri il Master (sessione Claude Code interattiva, sul tuo abbonamento)"
        >
          <Crown size={11} />
          <span>Apri Master</span>
        </button>
      </div>

      {/* Agents status board — status + preview + recommended action + Autopilot */}
      <AgentsBoardSection onMessage={onMessage} onJumpToTopic={onJumpToTopic} />

      {/* Kanban columns */}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-2 p-3 h-full min-w-max">
            {COLUMNS.map(col => (
              <GlobalColumn
                key={col.id}
                column={col}
                tasks={columns[col.id]}
                isOver={overColumn === col.id && activeId !== null}
                onJumpToTopic={onJumpToTopic}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? (
              <div className="bg-surface border border-app-border rounded-lg px-3 py-2 shadow-lg opacity-95 max-w-[240px]">
                <div className="text-[12px] text-app-text truncate">{activeTask.text}</div>
                <div className="text-[11px] text-app-text-muted mt-0.5">{getProjectLabel(activeTask.projectId)}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}

// Kanban column for global board
function GlobalColumn({ column, tasks, isOver, onJumpToTopic }: {
  column: { id: TaskStatus; label: string; color: string };
  tasks: BoardTask[];
  isOver: boolean;
  onJumpToTopic?: (topicId: string) => void;
}) {
  return (
    <div
      className={`w-[220px] flex-shrink-0 flex flex-col rounded-lg transition-colors ${
        isOver ? 'bg-primary/5 ring-1 ring-primary/30' : 'bg-black/[0.02] dark:bg-white/[0.02]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border/50">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${column.color}`}>
          {column.label}
        </span>
        <span className="text-[11px] text-app-text-muted ml-auto tabular-nums">{tasks.length}</span>
      </div>

      {/* Cards */}
      <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy} id={column.id}>
        <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-1.5 min-h-[60px]" id={column.id}>
          {tasks.map(task => (
            <SortableGlobalCard key={task.id} task={task} onJumpToTopic={onJumpToTopic} />
          ))}
          {tasks.length === 0 && (
            <div className="text-[11px] text-app-placeholder text-center py-4 italic">Empty</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// Sortable card showing task + project badge
function SortableGlobalCard({ task, onJumpToTopic }: { task: BoardTask; onJumpToTopic?: (topicId: string) => void }) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const priorityColors = ['text-app-text-muted', 'text-blue-400', 'text-yellow-400', 'text-orange-400', 'text-red-400'];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="bg-surface border border-app-border rounded-md px-2.5 py-2 cursor-grab active:cursor-grabbing hover:border-primary/30 transition-colors touch-none"
    >
      <div className="text-[12px] text-app-text leading-tight">{task.text}</div>
      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="text-[11px] text-app-text-muted bg-app-bg px-1.5 py-0.5 rounded truncate max-w-[120px]">
          {getProjectLabel(task.projectId)}
        </span>
        {task.priority > 2 && (
          <span className={`text-[11px] font-bold ${priorityColors[task.priority] || ''}`}>
            P{task.priority}
          </span>
        )}
        {task.assignedTo && (
          <span className="text-[11px] text-app-text-muted truncate max-w-[60px]">
            {task.assignedTo}
          </span>
        )}
        {task.assignedTopicId && (
          <button
            type="button"
            data-testid="global-task-assigned-topic-badge"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onJumpToTopic?.(task.assignedTopicId!);
            }}
            title="Jump to teammate Topic"
            className="ml-auto flex items-center gap-0.5 px-1 py-[1px] rounded text-[11px] font-medium bg-purple-500/15 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors"
          >
            <Crown size={8} />
            <span>teammate</span>
          </button>
        )}
      </div>
    </div>
  );
}
