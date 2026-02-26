import { useState, useCallback, useMemo } from 'react';
import { Loader2, Settings, X } from 'lucide-react';
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
import { arrayMove } from '@dnd-kit/sortable';
import { useBoard } from '../../hooks/useBoard';
import { KanbanColumn } from './KanbanColumn';
import { TaskFilters } from './TaskFilters';
import { TaskDetailPanel } from './TaskDetailPanel';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import { ApprovalReviewModal } from './ApprovalReviewModal';
import type { BoardTask, TaskStatus, Approval } from '../../lib/api';
import type { WSMessage } from '../../types';

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'backlog', label: 'Backlog', color: 'text-app-text-muted' },
  { id: 'todo', label: 'Todo', color: 'text-blue-400' },
  { id: 'in_progress', label: 'In Progress', color: 'text-yellow-400' },
  { id: 'review', label: 'Review', color: 'text-purple-400' },
  { id: 'done', label: 'Done', color: 'text-green-400' },
];

interface KanbanBoardProps {
  projectId: string;
  topicId?: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function KanbanBoard({ projectId, topicId, onWSMessage }: KanbanBoardProps) {
  const {
    columns,
    tags,
    loading,
    error,
    stats,
    selectedTask, setSelectedTask,
    approvalsByTaskId,
    heartbeatByTaskId,
    escalations,
    dismissEscalation,
    createTask,
    updateTask,
    deleteTask,
    archiveTask,
    moveTask,
    reorderInColumn,
    approveApproval,
    rejectApproval,
    statusFilter, setStatusFilter,
    priorityFilter, setPriorityFilter,
    assignedFilter, setAssignedFilter,
  } = useBoard({ projectId, onWSMessage });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<TaskStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [reviewingApproval, setReviewingApproval] = useState<Approval | null>(null);

  const handleReviewApproval = useCallback((approvalId: string) => {
    const approval = [...approvalsByTaskId.values()].find(a => a.id === approvalId);
    if (approval) setReviewingApproval(approval);
  }, [approvalsByTaskId]);

  const handleApprove = useCallback(async (id: string, comment?: string) => {
    await approveApproval(id, comment);
    setReviewingApproval(null);
  }, [approveApproval]);

  const handleReject = useCallback(async (id: string, comment?: string) => {
    await rejectApproval(id, comment);
    setReviewingApproval(null);
  }, [rejectApproval]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Flat list of all tasks for quick lookup
  const allTasks = useMemo(() => {
    const result: BoardTask[] = [];
    for (const col of COLUMNS) {
      result.push(...columns[col.id]);
    }
    return result;
  }, [columns]);

  const activeTask = activeId ? allTasks.find(t => t.id === activeId) ?? null : null;

  // Find which column a task belongs to
  const findColumnForTask = useCallback((taskId: string): TaskStatus | null => {
    for (const col of COLUMNS) {
      if (columns[col.id].some(t => t.id === taskId)) return col.id;
    }
    return null;
  }, [columns]);

  // --- Drag handlers ---

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setOverColumnId(null);
      return;
    }

    const overId = over.id as string;

    // Check if hovering over a column droppable directly
    if (COLUMNS.some(c => c.id === overId)) {
      setOverColumnId(overId as TaskStatus);
      return;
    }

    // Hovering over a task -- find its column
    const col = findColumnForTask(overId);
    setOverColumnId(col);
  }, [findColumnForTask]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverColumnId(null);

    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    const sourceCol = findColumnForTask(activeTaskId);
    if (!sourceCol) return;

    // Determine target column
    let targetCol: TaskStatus = sourceCol;
    if (COLUMNS.some(c => c.id === overId)) {
      targetCol = overId as TaskStatus;
    } else {
      const col = findColumnForTask(overId);
      if (col) targetCol = col;
    }

    if (sourceCol === targetCol) {
      // Within-column reorder
      if (activeTaskId === overId) return;

      const colItems = columns[sourceCol];
      const oldIndex = colItems.findIndex(t => t.id === activeTaskId);
      const newIndex = colItems.findIndex(t => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(colItems, oldIndex, newIndex);
      const orderedIds = reordered.map(t => t.id);
      await reorderInColumn(sourceCol, orderedIds);
    } else {
      // Cross-column move
      const targetItems = columns[targetCol];
      const newOrder = targetItems.length;
      try {
        await moveTask(activeTaskId, targetCol, newOrder);
      } catch (err) {
        console.error('Move rejected:', err);
      }
    }
  }, [columns, findColumnForTask, moveTask, reorderInColumn]);

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={18} className="animate-spin text-app-text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] text-red-400">
        Failed to load board: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface text-app-text overflow-hidden">
      {/* Escalation toasts */}
      {escalations.length > 0 && (
        <div className="absolute top-2 right-2 z-50 flex flex-col gap-1.5 max-w-[300px]">
          {escalations.map((esc, i) => (
            <div key={esc.timestamp} className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-[11px] shadow-lg">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-yellow-400">
                  {esc.agentName} needs help
                </span>
                <button onClick={() => dismissEscalation(i)} className="text-app-text-muted hover:text-app-text">
                  <X size={12} />
                </button>
              </div>
              <p className="text-app-text-muted">{esc.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filter bar + settings */}
      <div className="flex items-center">
        <div className="flex-1">
          <TaskFilters
            tags={tags}
            stats={stats}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            priorityFilter={priorityFilter}
            onPriorityFilter={setPriorityFilter}
            assignedFilter={assignedFilter}
            onAssignedFilter={setAssignedFilter}
          />
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="p-1.5 mr-1 text-app-text-muted hover:text-app-text transition-colors"
          title="Board settings"
        >
          <Settings size={13} />
        </button>
      </div>

      {/* Columns */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-1.5 h-full p-1.5 min-w-max">
            {COLUMNS.map(col => (
              <KanbanColumn
                key={col.id}
                id={col.id}
                label={col.label}
                color={col.color}
                tasks={columns[col.id]}
                tags={tags}
                isOver={overColumnId === col.id && activeId !== null}
                projectId={projectId}
                topicId={topicId}
                approvalsByTaskId={approvalsByTaskId}
                heartbeatByTaskId={heartbeatByTaskId}
                onCreateTask={createTask}
                onUpdateTask={updateTask}
                onDeleteTask={deleteTask}
                onSelectTask={setSelectedTask}
                onReviewApproval={handleReviewApproval}
              />
            ))}
          </div>

          <DragOverlay>
            {activeTask ? (
              <div className="bg-surface border border-primary/40 rounded px-2 py-1.5 text-[11px] text-app-text shadow-lg opacity-90 max-w-[200px] truncate">
                {activeTask.text}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Task detail slide-out panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projectId={projectId}
          tags={tags}
          onClose={() => setSelectedTask(null)}
          onUpdate={updateTask}
          onArchive={archiveTask}
        />
      )}

      {/* Board settings modal */}
      {showSettings && (
        <BoardSettingsPanel
          projectId={projectId}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Approval review modal */}
      {reviewingApproval && (
        <ApprovalReviewModal
          approval={reviewingApproval}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={() => setReviewingApproval(null)}
        />
      )}
    </div>
  );
}
