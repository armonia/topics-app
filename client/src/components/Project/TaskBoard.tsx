import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, CheckSquare, Circle, Clock, CheckCircle2, Loader2, GripVertical } from 'lucide-react';
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
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { tasksApi, type Task } from '../../lib/api';
import type { WSMessage } from '../../types';

type KanbanStatus = 'backlog' | 'active' | 'review' | 'done';

const COLUMNS: { id: KanbanStatus; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: 'text-app-text-muted' },
  { id: 'active', label: 'Active', color: 'text-blue-500' },
  { id: 'review', label: 'Review', color: 'text-yellow-500' },
  { id: 'done', label: 'Done', color: 'text-green-500' },
];

function toKanbanStatus(status: string): KanbanStatus {
  if (['backlog', 'active', 'review', 'done'].includes(status)) return status as KanbanStatus;
  return 'backlog';
}

interface TaskBoardProps {
  topicId: string;
  projectId: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

const COLLAPSE_KEY = 'topics-taskboard-collapsed';
const VIEW_KEY = 'topics-taskboard-view';

export function TaskBoard({ topicId, projectId, onWSMessage }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; }
  });
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as 'kanban' | 'list') || 'kanban'; } catch { return 'kanban'; }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<KanbanStatus | null>(null);

  // Track new task input per column
  const [addingInColumn, setAddingInColumn] = useState<KanbanStatus | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Load tasks
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    tasksApi.list(projectId)
      .then(data => setTasks(data.tasks))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  // WS sync
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.projectId !== projectId) return;
      if (msg.type === 'task:created') {
        setTasks(prev => prev.some(t => t.id === msg.task.id) ? prev : [...prev, msg.task]);
      }
      if (msg.type === 'task:updated') {
        setTasks(prev => prev.map(t => t.id === msg.task.id ? msg.task : t));
      }
      if (msg.type === 'task:deleted') {
        setTasks(prev => prev.filter(t => t.id !== msg.taskId));
      }
    });
    return unsub;
  }, [onWSMessage, projectId]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  const toggleView = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'kanban' ? 'list' : 'kanban';
      try { localStorage.setItem(VIEW_KEY, next); } catch {}
      return next;
    });
  }, []);

  // Group tasks by column
  const columnTasks = useMemo(() => {
    const groups: Record<KanbanStatus, Task[]> = { backlog: [], active: [], review: [], done: [] };
    for (const t of tasks) {
      const col = toKanbanStatus(t.status);
      groups[col].push(t);
    }
    // Sort by kanbanOrder within each column
    for (const col of Object.keys(groups) as KanbanStatus[]) {
      groups[col].sort((a, b) => (a.kanbanOrder ?? 0) - (b.kanbanOrder ?? 0));
    }
    return groups;
  }, [tasks]);

  const pendingCount = columnTasks.backlog.length + columnTasks.active.length + columnTasks.review.length;

  // Add task
  const handleAddTask = useCallback(async (column: KanbanStatus) => {
    if (!newTaskText.trim()) return;
    try {
      const task = await tasksApi.create(projectId, newTaskText.trim(), topicId);
      // Migrate to correct column status
      if (column !== 'backlog') {
        const updated = await tasksApi.update(projectId, task.id, { status: column });
        setTasks(prev => [...prev, updated]);
      } else {
        setTasks(prev => [...prev, task]);
      }
      setNewTaskText('');
      setAddingInColumn(null);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  }, [newTaskText, projectId, topicId]);

  // Delete task
  const handleDeleteTask = useCallback(async (taskId: string) => {
    try {
      await tasksApi.remove(projectId, taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }, [projectId]);

  // Drag handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverColumn(null); return; }

    // Determine which column we're over
    const overId = over.id as string;
    if (COLUMNS.some(c => c.id === overId)) {
      setOverColumn(overId as KanbanStatus);
    } else {
      // Over a task — find which column it's in
      for (const col of COLUMNS) {
        if (columnTasks[col.id].some(t => t.id === overId)) {
          setOverColumn(col.id);
          break;
        }
      }
    }
  }, [columnTasks]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverColumn(null);

    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    // Find which column the active task is currently in
    let sourceCol: KanbanStatus = 'backlog';
    for (const col of COLUMNS) {
      if (columnTasks[col.id].some(t => t.id === activeTaskId)) {
        sourceCol = col.id;
        break;
      }
    }

    // Determine target column
    let targetCol: KanbanStatus = sourceCol;
    if (COLUMNS.some(c => c.id === overId)) {
      targetCol = overId as KanbanStatus;
    } else {
      for (const col of COLUMNS) {
        if (columnTasks[col.id].some(t => t.id === overId)) {
          targetCol = col.id;
          break;
        }
      }
    }

    if (sourceCol === targetCol && activeTaskId !== overId) {
      // Reorder within same column
      const colItems = [...columnTasks[sourceCol]];
      const oldIndex = colItems.findIndex(t => t.id === activeTaskId);
      const newIndex = colItems.findIndex(t => t.id === overId);
      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(colItems, oldIndex, newIndex);
        // Optimistic update
        setTasks(prev => {
          const others = prev.filter(t => toKanbanStatus(t.status) !== sourceCol);
          const updated = reordered.map((t, i) => ({ ...t, kanbanOrder: i }));
          return [...others, ...updated];
        });
        // Persist order
        try {
          await Promise.all(
            reordered.map((t, i) =>
              tasksApi.update(projectId, t.id, { kanbanOrder: i })
            )
          );
        } catch (err) {
          console.error('Failed to persist order:', err);
        }
      }
    } else if (sourceCol !== targetCol) {
      // Move to different column
      const task = tasks.find(t => t.id === activeTaskId);
      if (!task) return;

      // Optimistic update
      const newOrder = columnTasks[targetCol].length;
      setTasks(prev =>
        prev.map(t =>
          t.id === activeTaskId ? { ...t, status: targetCol as any, kanbanOrder: newOrder } : t
        )
      );

      // Persist
      try {
        await tasksApi.update(projectId, activeTaskId, {
          status: targetCol,
          kanbanOrder: newOrder,
        });
      } catch (err) {
        console.error('Failed to move task:', err);
        // Rollback
        setTasks(prev =>
          prev.map(t =>
            t.id === activeTaskId ? { ...t, status: sourceCol as any } : t
          )
        );
      }
    }
  }, [columnTasks, tasks, projectId]);

  // Focus input when showing
  useEffect(() => {
    if (addingInColumn) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [addingInColumn]);

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null;

  return (
    <div className="border-b border-app-border">
      {/* Header */}
      <div className="flex items-center">
        <button
          onClick={toggleCollapse}
          className="flex-1 flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <CheckSquare size={13} />
          <span>Tasks</span>
          {pendingCount > 0 && (
            <span className="ml-1 bg-primary text-white text-[9px] px-1.5 py-0.5 rounded-full leading-none font-bold">
              {pendingCount}
            </span>
          )}
        </button>
        {!collapsed && (
          <button
            onClick={toggleView}
            className="px-2 py-1 text-[10px] text-app-text-muted hover:text-app-text transition-colors mr-1"
            title={viewMode === 'kanban' ? 'Switch to list view' : 'Switch to kanban view'}
          >
            {viewMode === 'kanban' ? 'List' : 'Board'}
          </button>
        )}
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="px-1 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 size={14} className="animate-spin text-app-text-muted" />
            </div>
          ) : viewMode === 'kanban' ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCorners}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
            >
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {COLUMNS.map(col => (
                  <KanbanColumn
                    key={col.id}
                    column={col}
                    tasks={columnTasks[col.id]}
                    isOver={overColumn === col.id && activeId !== null}
                    addingInColumn={addingInColumn}
                    newTaskText={newTaskText}
                    inputRef={inputRef}
                    onSetAddingColumn={setAddingInColumn}
                    onSetNewTaskText={setNewTaskText}
                    onAddTask={handleAddTask}
                    onDeleteTask={handleDeleteTask}
                  />
                ))}
              </div>
              <DragOverlay>
                {activeTask ? (
                  <div className="bg-surface border border-app-border rounded px-2 py-1.5 text-[11px] text-app-text shadow-lg opacity-90 max-w-[140px] truncate">
                    {activeTask.text}
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          ) : (
            // List view (fallback)
            <ListViewTasks
              tasks={tasks}
              projectId={projectId}
              topicId={topicId}
              onUpdate={(updatedTasks) => setTasks(updatedTasks)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Kanban column component
interface KanbanColumnProps {
  column: { id: KanbanStatus; label: string; color: string };
  tasks: Task[];
  isOver: boolean;
  addingInColumn: KanbanStatus | null;
  newTaskText: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSetAddingColumn: (col: KanbanStatus | null) => void;
  onSetNewTaskText: (text: string) => void;
  onAddTask: (col: KanbanStatus) => void;
  onDeleteTask: (id: string) => void;
}

function KanbanColumn({
  column,
  tasks,
  isOver,
  addingInColumn,
  newTaskText,
  inputRef,
  onSetAddingColumn,
  onSetNewTaskText,
  onAddTask,
  onDeleteTask,
}: KanbanColumnProps) {
  return (
    <div
      className={`flex-1 min-w-[120px] rounded-md transition-colors ${
        isOver ? 'bg-primary/10 ring-1 ring-primary/30' : 'bg-black/3 dark:bg-white/3'
      }`}
    >
      {/* Column header */}
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-black/5 dark:border-white/5">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${column.color}`}>
          {column.label}
        </span>
        <span className="text-[9px] text-app-text-muted ml-auto">{tasks.length}</span>
      </div>

      {/* Task list */}
      <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy} id={column.id}>
        <div className="min-h-[40px] px-0.5 py-0.5 space-y-0.5" id={column.id}>
          {tasks.map(task => (
            <SortableTaskCard key={task.id} task={task} onDelete={onDeleteTask} />
          ))}
          {tasks.length === 0 && (
            <div className="text-[10px] text-app-placeholder text-center py-2 italic">
              Empty
            </div>
          )}
        </div>
      </SortableContext>

      {/* Add task */}
      {addingInColumn === column.id ? (
        <div className="px-1 pb-1">
          <input
            ref={inputRef}
            type="text"
            value={newTaskText}
            onChange={e => onSetNewTaskText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onAddTask(column.id);
              if (e.key === 'Escape') { onSetAddingColumn(null); onSetNewTaskText(''); }
            }}
            onBlur={() => {
              if (!newTaskText.trim()) {
                onSetAddingColumn(null);
                onSetNewTaskText('');
              }
            }}
            placeholder="New task..."
            className="w-full text-[10px] bg-surface border border-app-border rounded px-1.5 py-1 focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder"
          />
        </div>
      ) : (
        <button
          onClick={() => { onSetAddingColumn(column.id); onSetNewTaskText(''); }}
          className="w-full flex items-center gap-0.5 px-1.5 py-1 text-[10px] text-app-text-muted hover:text-primary transition-colors"
        >
          <Plus size={10} />
          <span>Add</span>
        </button>
      )}
    </div>
  );
}

// Sortable task card
function SortableTaskCard({ task, onDelete }: { task: Task; onDelete: (id: string) => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-1 bg-surface border border-app-border rounded px-1.5 py-1 cursor-default hover:border-primary/30 transition-colors"
    >
      <button
        {...attributes}
        {...listeners}
        className="flex-shrink-0 text-app-placeholder hover:text-app-text-muted cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical size={10} />
      </button>
      <span className={`flex-1 text-[10px] truncate ${
        toKanbanStatus(task.status) === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'
      }`}>
        {task.text}
      </span>
      <button
        onClick={() => onDelete(task.id)}
        className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-app-placeholder hover:text-red-500 p-0.5 transition-all"
        title="Delete"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}

// Simple list view as fallback
function ListViewTasks({
  tasks,
  projectId,
  topicId,
  onUpdate,
}: {
  tasks: Task[];
  projectId: string;
  topicId: string;
  onUpdate: (tasks: Task[]) => void;
}) {
  const [showInput, setShowInput] = useState(false);
  const [newText, setNewText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showInput) setTimeout(() => inputRef.current?.focus(), 50);
  }, [showInput]);

  const handleAdd = async () => {
    if (!newText.trim()) return;
    try {
      const task = await tasksApi.create(projectId, newText.trim(), topicId);
      onUpdate([...tasks, task]);
      setNewText('');
      setShowInput(false);
    } catch {}
  };

  const handleToggle = async (task: Task) => {
    const newStatus = task.status === 'done' ? 'backlog' : 'done';
    try {
      const updated = await tasksApi.update(projectId, task.id, { status: newStatus });
      onUpdate(tasks.map(t => t.id === task.id ? updated : t));
    } catch {}
  };

  const handleDelete = async (taskId: string) => {
    try {
      await tasksApi.remove(projectId, taskId);
      onUpdate(tasks.filter(t => t.id !== taskId));
    } catch {}
  };

  const active = tasks.filter(t => t.status === 'active');
  const backlog = tasks.filter(t => t.status === 'backlog' || t.status === 'review');
  const done = tasks.filter(t => t.status === 'done');

  const renderGroup = (label: string, items: Task[], colorClass: string) =>
    items.length > 0 && (
      <div className="mb-1.5">
        <div className={`text-[10px] font-semibold ${colorClass} px-1 py-0.5 uppercase tracking-wider`}>{label}</div>
        {items.map(task => (
          <div key={task.id} className="group flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-black/3 dark:hover:bg-white/3">
            <button onClick={() => handleToggle(task)} className={`flex-shrink-0 ${task.status === 'done' ? 'text-green-500' : task.status === 'active' ? 'text-yellow-500' : 'text-app-placeholder hover:text-primary'}`}>
              {task.status === 'done' ? <CheckCircle2 size={14} /> : task.status === 'active' ? <Clock size={14} /> : <Circle size={14} />}
            </button>
            <span className={`flex-1 text-[11px] truncate ${task.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}>{task.text}</span>
            <button onClick={() => handleDelete(task.id)} className="opacity-0 group-hover:opacity-100 text-app-placeholder hover:text-red-500 p-0.5 transition-all"><Trash2 size={11} /></button>
          </div>
        ))}
      </div>
    );

  return (
    <>
      {renderGroup('Active', active, 'text-blue-600 dark:text-blue-400')}
      {renderGroup('Backlog', backlog, 'text-app-text-muted')}
      {renderGroup('Done', done, 'text-green-600 dark:text-green-400')}
      {tasks.length === 0 && !showInput && (
        <div className="text-[11px] text-app-placeholder px-1 py-2 text-center">No tasks yet</div>
      )}
      {showInput ? (
        <div className="flex items-center gap-1 px-1 mt-1">
          <input
            ref={inputRef}
            type="text"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setShowInput(false); setNewText(''); } }}
            placeholder="Task description..."
            className="flex-1 text-[11px] bg-surface border border-app-border rounded px-2 py-1 focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder"
          />
          <button onClick={handleAdd} className="text-[10px] bg-primary text-white px-2 py-1 rounded hover:opacity-90 transition-opacity">Add</button>
          <button onClick={() => { setShowInput(false); setNewText(''); }} className="text-[10px] text-app-text-muted px-1 py-1">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setShowInput(true)} className="flex items-center gap-1 px-1 py-1 text-[11px] text-app-text-muted hover:text-primary transition-colors w-full">
          <Plus size={12} />
          <span>Add task</span>
        </button>
      )}
    </>
  );
}
