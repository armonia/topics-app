import { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, Lock, Crown } from 'lucide-react';
import { ApprovalBanner } from './ApprovalBanner';
import type { BoardTask, Approval } from '../../lib/api';

interface TaskCardProps {
  task: BoardTask;
  approval?: Approval;
  onSelect?: (task: BoardTask) => void;
  onDelete?: (taskId: string) => void;
  onReviewApproval?: (approvalId: string) => void;
  lastHeartbeat?: number; // timestamp of last heartbeat for this agent
  /** KANBAN-DELTA-01 — invoked when the user clicks the teammate badge to jump to that pane. */
  onJumpToTopic?: (topicId: string) => void;
}

const PRIORITY_COLORS: Record<number, string> = {
  0: 'bg-red-500',
  1: 'bg-orange-400',
  2: 'bg-blue-400',
  3: 'bg-gray-400',
  4: 'bg-slate-500',
};

export function TaskCard({ task, approval, onSelect, onDelete, onReviewApproval, lastHeartbeat, onJumpToTopic }: TaskCardProps) {
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

  const isBlocked = task.blockedBy && task.blockedBy.length > 0;
  const isAgentWorking = task.status === 'in_progress' && task.assignedAgentId;

  // Heartbeat pulse — true if heartbeat received within last 60s
  const [isAlive, setIsAlive] = useState(false);
  useEffect(() => {
    if (!lastHeartbeat) { setIsAlive(false); return; }
    const age = Date.now() - lastHeartbeat;
    setIsAlive(age < 60000);
  }, [lastHeartbeat]);

  // Working timer
  const [workingTime, setWorkingTime] = useState('');
  useEffect(() => {
    if (!isAgentWorking || !task.inProgressAt) return;
    const update = () => {
      const elapsed = Date.now() - new Date(task.inProgressAt!).getTime();
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      setWorkingTime(`${mins}m ${secs.toString().padStart(2, '0')}s`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isAgentWorking, task.inProgressAt]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`task-card-${task.id}`}
      className={`
        group relative flex items-start gap-1 bg-surface border border-app-border rounded
        px-1.5 py-1 cursor-pointer select-none
        hover:border-primary/30 transition-colors
      `}
      onClick={() => onSelect?.(task)}
    >
      {/* Drag handle */}
      <button
        data-testid="task-card-drag-handle"
        className="flex-shrink-0 mt-0.5 text-app-text-muted/40 hover:text-app-text-muted cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
        onClick={e => e.stopPropagation()}
      >
        <GripVertical size={10} />
      </button>

      {/* Card content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {/* Priority dot */}
          <span
            className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${PRIORITY_COLORS[task.priority] ?? 'bg-slate-500'}`}
          />

          {/* Blocked indicator */}
          {isBlocked && (
            <Lock size={10} className="flex-shrink-0 text-yellow-500/70" />
          )}

          {/* Task text */}
          <span className="text-[11px] text-app-text leading-tight truncate">
            {task.text}
          </span>

          {/* KANBAN-DELTA-01 — teammate Topic badge (jump-to-tab) */}
          {task.assignedTopicId && (
            <button
              type="button"
              data-testid="task-assigned-topic-badge"
              onClick={(e) => {
                e.stopPropagation();
                onJumpToTopic?.(task.assignedTopicId!);
              }}
              title="Jump to teammate Topic"
              className="ml-auto flex items-center gap-0.5 px-1 py-[1px] rounded text-[9px] font-medium bg-purple-500/15 text-purple-300 hover:bg-purple-500/30 hover:text-purple-200 transition-colors"
            >
              <Crown size={8} />
              <span className="truncate max-w-[60px]">teammate</span>
            </button>
          )}
        </div>

        {/* Agent working indicator */}
        {isAgentWorking && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[10px]">{task.fingerprint ?? '🤖'}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${isAlive ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`}
              title={isAlive ? 'Agent active' : 'Agent offline'}
            />
            {task.assignedTo && (
              <span className="text-[9px] text-app-text-muted truncate max-w-[80px]">
                {task.assignedTo}
              </span>
            )}
            {workingTime && (
              <span className="text-[9px] text-app-text-muted ml-auto">
                {workingTime}
              </span>
            )}
          </div>
        )}

        {/* Tags */}
        {task.tags && task.tags.length > 0 && (
          <div className="flex flex-wrap gap-0.5 mt-0.5">
            {task.tags.map(tag => (
              <span
                key={tag.id}
                className="text-[9px] leading-none px-1 py-[1px] rounded-sm font-medium"
                style={{
                  backgroundColor: `${tag.color}22`,
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {/* Bottom row: due date + assigned agent (when not in progress) */}
        {!isAgentWorking && (task.dueDate || task.assignedTo) && (
          <div className="flex items-center gap-1 mt-0.5">
            {task.dueDate && (
              <span className="text-[10px] text-app-text-muted">
                {new Date(task.dueDate).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            )}
            {task.assignedTo && (
              <span
                className="ml-auto text-[10px]"
                title={task.assignedTo}
              >
                {task.fingerprint ?? '🤖'}
              </span>
            )}
          </div>
        )}

        {/* Pending approval banner */}
        {approval && (
          <div className="mt-1" onClick={e => e.stopPropagation()}>
            <ApprovalBanner approval={approval} onReview={onReviewApproval} />
          </div>
        )}
      </div>

      {/* Delete button (shown on hover) */}
      <button
        className="flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 text-app-text-muted/40
                   hover:text-red-400 transition-opacity"
        onClick={e => {
          e.stopPropagation();
          onDelete?.(task.id);
        }}
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}
