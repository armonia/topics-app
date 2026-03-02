import { Filter, X } from 'lucide-react';
import type { TaskStatus, Tag } from '../../lib/api';

const PRIORITY_LABELS: Record<number, string> = {
  0: 'Critical',
  1: 'High',
  2: 'Medium',
  3: 'Low',
  4: 'None',
};

interface TaskFiltersProps {
  tags: Tag[];
  stats: {
    total: number;
    backlog: number;
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    pending: number;
  };
  statusFilter: TaskStatus | null;
  priorityFilter: number | null;
  assignedFilter: string | null;
  onStatusFilter: (status: TaskStatus | null) => void;
  onPriorityFilter: (priority: number | null) => void;
  onAssignedFilter: (assigned: string | null) => void;
}

export function TaskFilters({
  stats,
  statusFilter,
  priorityFilter,
  assignedFilter,
  onStatusFilter,
  onPriorityFilter,
  onAssignedFilter,
}: TaskFiltersProps) {
  const hasFilters = statusFilter !== null || priorityFilter !== null || !!assignedFilter;

  return (
    <div className="flex items-center gap-1.5 px-1 py-1 text-[10px]">
      <Filter size={12} className="text-app-text-muted flex-shrink-0" />

      {/* Status filter */}
      <select
        value={statusFilter || ''}
        onChange={e => onStatusFilter(e.target.value ? e.target.value as TaskStatus : null)}
        className="bg-surface border border-app-border rounded px-1.5 py-0.5 text-[10px] text-app-text focus:outline-none focus:border-primary"
      >
        <option value="">All Status</option>
        <option value="backlog">Backlog ({stats.backlog})</option>
        <option value="todo">Todo ({stats.todo})</option>
        <option value="in_progress">In Progress ({stats.inProgress})</option>
        <option value="review">Review ({stats.review})</option>
        <option value="done">Done ({stats.done})</option>
      </select>

      {/* Priority filter */}
      <select
        value={priorityFilter ?? ''}
        onChange={e => onPriorityFilter(e.target.value !== '' ? parseInt(e.target.value) : null)}
        className="bg-surface border border-app-border rounded px-1.5 py-0.5 text-[10px] text-app-text focus:outline-none focus:border-primary"
      >
        <option value="">All Priority</option>
        {Object.entries(PRIORITY_LABELS).map(([val, label]) => (
          <option key={val} value={val}>{label}</option>
        ))}
      </select>

      {/* Assigned filter */}
      <input
        type="text"
        value={assignedFilter || ''}
        onChange={e => onAssignedFilter(e.target.value || null)}
        placeholder="Assigned to..."
        className="bg-surface border border-app-border rounded px-1.5 py-0.5 text-[10px] text-app-text w-24 focus:outline-none focus:border-primary"
      />

      {/* Active filter count */}
      {hasFilters && (
        <button
          onClick={() => { onStatusFilter(null); onPriorityFilter(null); onAssignedFilter(null); }}
          className="flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
        >
          <X size={10} />
          Clear
        </button>
      )}

      {/* Task count */}
      <span className="ml-auto text-app-text-muted">
        {stats.pending} open / {stats.total} total
      </span>
    </div>
  );
}
