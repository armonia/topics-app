import { useState, useEffect, useCallback, useMemo } from 'react';
import { boardsApi, approvalsApi, type BoardTask, type TaskStatus, type Tag, type Approval, type BoardMemory, tagsApi, boardMemoryApi } from '../lib/api';
import type { WSMessage } from '../types';

interface UseBoardOptions {
  projectId: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function useBoard({ projectId, onWSMessage }: UseBoardOptions) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [boardMemory, setBoardMemory] = useState<BoardMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<number | null>(null);
  const [assignedFilter, setAssignedFilter] = useState<string | null>(null);

  // Selected task for detail panel
  const [selectedTask, setSelectedTask] = useState<BoardTask | null>(null);

  // Agent heartbeat timestamps: agentId -> last heartbeat timestamp
  const [agentHeartbeats, setAgentHeartbeats] = useState<Map<string, number>>(new Map());

  // Escalation messages (for toast display)
  const [escalations, setEscalations] = useState<Array<{
    agentId: string;
    agentName: string;
    message: string;
    taskId: string | null;
    projectId: string;
    timestamp: number;
  }>>([]);

  // Load tasks + tags + approvals + memory
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);

    const filters: any = {};
    if (statusFilter) filters.status = statusFilter;
    if (priorityFilter !== null) filters.priority = String(priorityFilter);
    if (assignedFilter) filters.assignedTo = assignedFilter;

    Promise.all([
      boardsApi.listTasks(projectId, filters),
      tagsApi.list(),
      approvalsApi.list(projectId, 'pending').catch(() => ({ approvals: [] })),
      boardMemoryApi.list(projectId, { limit: 50 }).catch(() => []),
    ])
      .then(([tasksData, tagsData, approvalsData, memoryData]) => {
        setTasks(tasksData.tasks);
        setTags(tagsData.tags);
        setApprovals(approvalsData.approvals);
        setBoardMemory(memoryData);
      })
      .catch(err => {
        console.error('Failed to load board:', err);
        setError(err.message);
        setTasks([]);
      })
      .finally(() => setLoading(false));
  }, [projectId, statusFilter, priorityFilter, assignedFilter]);

  // WS sync
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.type === 'task:created' || msg.type === 'task:moved') {
        if (msg.projectId !== projectId) return;
        setTasks(prev => {
          const exists = prev.some(t => t.id === msg.task.id);
          if (exists) return prev.map(t => t.id === msg.task.id ? msg.task : t);
          return [...prev, msg.task];
        });
      }
      if (msg.type === 'task:updated') {
        if (msg.projectId !== projectId) return;
        setTasks(prev => prev.map(t => t.id === msg.task.id ? msg.task : t));
        setSelectedTask(prev => prev && prev.id === msg.task.id ? { ...prev, ...msg.task } : prev);
      }
      if (msg.type === 'task:deleted' || msg.type === 'task:archived') {
        if (msg.projectId !== projectId) return;
        setTasks(prev => prev.filter(t => t.id !== msg.taskId));
        setSelectedTask(prev => prev && prev.id === msg.taskId ? null : prev);
      }
      if (msg.type === 'task:unarchived') {
        if (msg.projectId !== projectId) return;
        setTasks(prev => {
          const exists = prev.some(t => t.id === msg.task.id);
          if (exists) return prev.map(t => t.id === msg.task.id ? msg.task : t);
          return [...prev, msg.task];
        });
      }
      // Approval events
      if (msg.type === 'approval:created') {
        if (msg.projectId !== projectId) return;
        setApprovals(prev => [msg.approval, ...prev]);
      }
      if (msg.type === 'approval:approved' || msg.type === 'approval:rejected') {
        setApprovals(prev => prev.filter(a => a.id !== msg.approvalId));
      }

      // Agent heartbeat events
      if (msg.type === 'agent:heartbeat') {
        setAgentHeartbeats(prev => {
          const next = new Map(prev);
          next.set(msg.agentId, Date.now());
          // Prune entries older than 5 minutes
          const cutoff = Date.now() - 5 * 60_000;
          for (const [id, ts] of next) {
            if (ts < cutoff) next.delete(id);
          }
          return next;
        });
      }

      // Escalation events
      if (msg.type === 'agent:escalation') {
        if (msg.projectId !== projectId) return;
        setEscalations(prev => [...prev, {
          agentId: msg.agentId,
          agentName: msg.agentName,
          message: msg.message,
          taskId: msg.taskId,
          projectId: msg.projectId,
          timestamp: Date.now(),
        }]);
      }

      // Board memory events
      if (msg.type === 'board:memory_added') {
        if (msg.projectId !== projectId) return;
        setBoardMemory(prev => [msg.memory, ...prev]);
      }

    });
    return unsub;
  }, [onWSMessage, projectId]);

  // Dismiss escalation
  const dismissEscalation = useCallback((index: number) => {
    setEscalations(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Lookup: pending approval by taskId
  const approvalsByTaskId = useMemo(() => {
    const map = new Map<string, Approval>();
    for (const a of approvals) {
      if (a.status === 'pending') map.set(a.taskId, a);
    }
    return map;
  }, [approvals]);

  // Lookup: heartbeat by agent ID assigned to a task
  const heartbeatByTaskId = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.assignedAgentId && agentHeartbeats.has(t.assignedAgentId)) {
        map.set(t.id, agentHeartbeats.get(t.assignedAgentId)!);
      }
    }
    return map;
  }, [tasks, agentHeartbeats]);

  // Group tasks by status column
  const columns = useMemo(() => {
    const groups: Record<TaskStatus, BoardTask[]> = {
      backlog: [], todo: [], in_progress: [], review: [], done: [],
    };
    for (const t of tasks) {
      const col = groups[t.status] || groups.todo;
      col.push(t);
    }
    for (const col of Object.values(groups)) {
      col.sort((a, b) => (a.kanbanOrder ?? 0) - (b.kanbanOrder ?? 0));
    }
    return groups;
  }, [tasks]);

  // Task actions
  const createTask = useCallback(async (data: { text: string; description?: string; status?: TaskStatus; priority?: number; assignedTo?: string; tagIds?: string[] }) => {
    const task = await boardsApi.createTask(projectId, data);
    setTasks(prev => [...prev, task]);
    return task;
  }, [projectId]);

  const updateTask = useCallback(async (taskId: string, updates: Partial<BoardTask>) => {
    const task = await boardsApi.updateTask(projectId, taskId, updates as any);
    setTasks(prev => prev.map(t => t.id === taskId ? task : t));
    setSelectedTask(prev => prev && prev.id === taskId ? task : prev);
    return task;
  }, [projectId]);

  const deleteTask = useCallback(async (taskId: string) => {
    await boardsApi.deleteTask(projectId, taskId);
    setTasks(prev => prev.filter(t => t.id !== taskId));
    setSelectedTask(prev => prev && prev.id === taskId ? null : prev);
  }, [projectId]);

  const archiveTask = useCallback(async (taskId: string) => {
    await boardsApi.archiveTask(projectId, taskId);
    setTasks(prev => prev.filter(t => t.id !== taskId));
    setSelectedTask(prev => prev && prev.id === taskId ? null : prev);
  }, [projectId]);

  const moveTask = useCallback(async (taskId: string, status: TaskStatus, kanbanOrder?: number) => {
    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status, kanbanOrder: kanbanOrder ?? t.kanbanOrder } : t
    ));
    try {
      const task = await boardsApi.moveTask(projectId, taskId, status, kanbanOrder);
      setTasks(prev => prev.map(t => t.id === taskId ? task : t));
      return task;
    } catch (err: any) {
      // Rollback on conflict (e.g., blocked by dependencies)
      const data = await boardsApi.listTasks(projectId);
      setTasks(data.tasks);
      throw err;
    }
  }, [projectId]);

  const reorderInColumn = useCallback(async (status: TaskStatus, orderedIds: string[]) => {
    const snapshot = tasks; // for rollback
    // Optimistic reorder
    setTasks(prev => {
      const others = prev.filter(t => t.status !== status);
      const colTasks = orderedIds.map((id, i) => {
        const task = prev.find(t => t.id === id);
        return task ? { ...task, kanbanOrder: i } : null;
      }).filter(Boolean) as BoardTask[];
      return [...others, ...colTasks];
    });

    // Persist
    try {
      await Promise.all(
        orderedIds.map((id, i) =>
          boardsApi.updateTask(projectId, id, { kanbanOrder: i })
        )
      );
    } catch (err) {
      console.error('Failed to persist order:', err);
      setTasks(snapshot); // rollback
    }
  }, [projectId, tasks]);

  // Approval actions
  const approveApproval = useCallback(async (approvalId: string, comment?: string) => {
    await approvalsApi.approve(approvalId, comment);
    setApprovals(prev => prev.filter(a => a.id !== approvalId));
    // Refresh tasks to get updated status
    boardsApi.listTasks(projectId).then(data => setTasks(data.tasks)).catch(() => {});
  }, [projectId]);

  const rejectApproval = useCallback(async (approvalId: string, comment?: string) => {
    await approvalsApi.reject(approvalId, comment);
    setApprovals(prev => prev.filter(a => a.id !== approvalId));
  }, []);

  // Stats
  const stats = useMemo(() => ({
    total: tasks.length,
    backlog: columns.backlog.length,
    todo: columns.todo.length,
    inProgress: columns.in_progress.length,
    review: columns.review.length,
    done: columns.done.length,
    pending: tasks.length - columns.done.length,
  }), [tasks, columns]);

  return {
    tasks,
    columns,
    tags,
    approvals,
    approvalsByTaskId,
    loading,
    error,
    stats,
    // Agent-related
    agentHeartbeats,
    heartbeatByTaskId,
    escalations,
    dismissEscalation,
    // Board memory
    boardMemory,
    // Selected task
    selectedTask, setSelectedTask,
    // Actions
    createTask,
    updateTask,
    deleteTask,
    archiveTask,
    moveTask,
    reorderInColumn,
    // Approval actions
    approveApproval,
    rejectApproval,
    // Filters
    statusFilter, setStatusFilter,
    priorityFilter, setPriorityFilter,
    assignedFilter, setAssignedFilter,
  };
}
