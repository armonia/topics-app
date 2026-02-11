import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, CheckSquare, Circle, Clock, CheckCircle2, Loader2 } from 'lucide-react';
import { tasksApi, type Task } from '../../lib/api';
import type { WSMessage } from '../../types';

interface TaskBoardProps {
  topicId: string;
  projectId: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

const COLLAPSE_KEY = 'topics-taskboard-collapsed';

export function TaskBoard({ topicId, projectId, onWSMessage }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [newTaskText, setNewTaskText] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Load tasks
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    tasksApi.list(projectId)
      .then(data => setTasks(data.tasks))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Listen for WebSocket task events
  useEffect(() => {
    const unsub = onWSMessage((msg: WSMessage) => {
      if (msg.projectId !== projectId) return;

      if (msg.type === 'task:created') {
        setTasks(prev => {
          // Avoid duplicates
          if (prev.some(t => t.id === msg.task.id)) return prev;
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
    return unsub;
  }, [onWSMessage, projectId]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch {}
      return next;
    });
  }, []);

  const handleAddTask = useCallback(async () => {
    if (!newTaskText.trim()) return;
    try {
      const task = await tasksApi.create(projectId, newTaskText.trim(), topicId);
      setTasks(prev => [...prev, task]);
      setNewTaskText('');
      setShowInput(false);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  }, [newTaskText, projectId, topicId]);

  const handleToggleStatus = useCallback(async (task: Task) => {
    const newStatus = task.status === 'done' ? 'todo' : 'done';
    try {
      const updated = await tasksApi.update(projectId, task.id, { status: newStatus });
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  }, [projectId]);

  const handleSetInProgress = useCallback(async (task: Task) => {
    try {
      const updated = await tasksApi.update(projectId, task.id, { status: 'in_progress' });
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  }, [projectId]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    try {
      await tasksApi.remove(projectId, taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }, [projectId]);

  const handleStartEdit = useCallback((task: Task) => {
    setEditingId(task.id);
    setEditText(task.text);
    setTimeout(() => editInputRef.current?.focus(), 50);
  }, []);

  const handleFinishEdit = useCallback(async () => {
    if (!editingId || !editText.trim()) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await tasksApi.update(projectId, editingId, { text: editText.trim() });
      setTasks(prev => prev.map(t => t.id === editingId ? updated : t));
    } catch (err) {
      console.error('Failed to update task:', err);
    }
    setEditingId(null);
  }, [editingId, editText, projectId]);

  // Focus input when showing
  useEffect(() => {
    if (showInput) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [showInput]);

  // Group tasks by status
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const todo = tasks.filter(t => t.status === 'todo');
  const done = tasks.filter(t => t.status === 'done');
  const pendingCount = inProgress.length + todo.length;

  return (
    <div className="border-b border-[#e8e8e8] dark:border-[#2a2a2a]">
      {/* Header */}
      <button
        onClick={toggleCollapse}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-[#666] dark:text-[#999] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <CheckSquare size={13} />
        <span>Tasks</span>
        {pendingCount > 0 && (
          <span className="ml-auto bg-[var(--primary)] text-white text-[9px] px-1.5 py-0.5 rounded-full leading-none font-bold">
            {pendingCount}
          </span>
        )}
      </button>

      {/* Task list */}
      {!collapsed && (
        <div className="px-1 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 size={14} className="animate-spin text-[#888]" />
            </div>
          ) : (
            <>
              {/* In Progress */}
              {inProgress.length > 0 && (
                <div className="mb-1.5">
                  <div className="text-[10px] font-semibold text-yellow-600 dark:text-yellow-400 px-1 py-0.5 uppercase tracking-wider">
                    In Progress
                  </div>
                  {inProgress.map(task => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      editingId={editingId}
                      editText={editText}
                      editInputRef={editInputRef}
                      onToggle={handleToggleStatus}
                      onSetInProgress={handleSetInProgress}
                      onDelete={handleDeleteTask}
                      onStartEdit={handleStartEdit}
                      onEditTextChange={setEditText}
                      onFinishEdit={handleFinishEdit}
                    />
                  ))}
                </div>
              )}

              {/* Todo */}
              {todo.length > 0 && (
                <div className="mb-1.5">
                  <div className="text-[10px] font-semibold text-[#888] dark:text-[#666] px-1 py-0.5 uppercase tracking-wider">
                    Todo
                  </div>
                  {todo.map(task => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      editingId={editingId}
                      editText={editText}
                      editInputRef={editInputRef}
                      onToggle={handleToggleStatus}
                      onSetInProgress={handleSetInProgress}
                      onDelete={handleDeleteTask}
                      onStartEdit={handleStartEdit}
                      onEditTextChange={setEditText}
                      onFinishEdit={handleFinishEdit}
                    />
                  ))}
                </div>
              )}

              {/* Done */}
              {done.length > 0 && (
                <div className="mb-1.5">
                  <div className="text-[10px] font-semibold text-green-600 dark:text-green-400 px-1 py-0.5 uppercase tracking-wider">
                    Done
                  </div>
                  {done.map(task => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      editingId={editingId}
                      editText={editText}
                      editInputRef={editInputRef}
                      onToggle={handleToggleStatus}
                      onSetInProgress={handleSetInProgress}
                      onDelete={handleDeleteTask}
                      onStartEdit={handleStartEdit}
                      onEditTextChange={setEditText}
                      onFinishEdit={handleFinishEdit}
                    />
                  ))}
                </div>
              )}

              {tasks.length === 0 && !showInput && (
                <div className="text-[11px] text-[#bbb] dark:text-[#555] px-1 py-2 text-center">
                  No tasks yet
                </div>
              )}

              {/* Add task input */}
              {showInput ? (
                <div className="flex items-center gap-1 px-1 mt-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={newTaskText}
                    onChange={e => setNewTaskText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleAddTask();
                      if (e.key === 'Escape') { setShowInput(false); setNewTaskText(''); }
                    }}
                    placeholder="Task description..."
                    className="flex-1 text-[11px] bg-white dark:bg-[#222] border border-[#ddd] dark:border-[#333] rounded px-2 py-1 focus:outline-none focus:border-[var(--primary)] text-[#333] dark:text-[#ccc] placeholder-[#bbb] dark:placeholder-[#555]"
                  />
                  <button
                    onClick={handleAddTask}
                    className="text-[10px] bg-[var(--primary)] text-white px-2 py-1 rounded hover:bg-[#0055dd] transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setShowInput(false); setNewTaskText(''); }}
                    className="text-[10px] text-[#888] hover:text-[#555] dark:hover:text-[#ccc] px-1 py-1"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowInput(true)}
                  className="flex items-center gap-1 px-1 py-1 text-[11px] text-[#888] hover:text-[var(--primary)] transition-colors w-full"
                >
                  <Plus size={12} />
                  <span>Add task</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Individual task item component
interface TaskItemProps {
  task: Task;
  editingId: string | null;
  editText: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  onToggle: (task: Task) => void;
  onSetInProgress: (task: Task) => void;
  onDelete: (id: string) => void;
  onStartEdit: (task: Task) => void;
  onEditTextChange: (text: string) => void;
  onFinishEdit: () => void;
}

function TaskItem({
  task,
  editingId,
  editText,
  editInputRef,
  onToggle,
  onSetInProgress,
  onDelete,
  onStartEdit,
  onEditTextChange,
  onFinishEdit,
}: TaskItemProps) {
  const isEditing = editingId === task.id;
  const isDone = task.status === 'done';
  const isInProgress = task.status === 'in_progress';

  return (
    <div className="group flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-black/3 dark:hover:bg-white/3">
      {/* Status toggle */}
      <button
        onClick={() => onToggle(task)}
        className={`flex-shrink-0 transition-colors ${
          isDone ? 'text-green-500' : isInProgress ? 'text-yellow-500' : 'text-[#ccc] dark:text-[#444] hover:text-[var(--primary)]'
        }`}
        title={isDone ? 'Mark as todo' : 'Mark as done'}
      >
        {isDone ? <CheckCircle2 size={14} /> : isInProgress ? <Clock size={14} /> : <Circle size={14} />}
      </button>

      {/* Text */}
      {isEditing ? (
        <input
          ref={editInputRef}
          type="text"
          value={editText}
          onChange={e => onEditTextChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onFinishEdit();
            if (e.key === 'Escape') onFinishEdit();
          }}
          onBlur={onFinishEdit}
          className="flex-1 text-[11px] bg-white dark:bg-[#222] border border-[var(--primary)] rounded px-1.5 py-0.5 focus:outline-none text-[#333] dark:text-[#ccc]"
        />
      ) : (
        <span
          onClick={() => onStartEdit(task)}
          className={`flex-1 text-[11px] cursor-text truncate ${
            isDone 
              ? 'text-[#aaa] dark:text-[#555] line-through' 
              : 'text-[#333] dark:text-[#ccc]'
          }`}
          title="Click to edit"
        >
          {task.text}
        </span>
      )}

      {/* Actions (visible on hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isDone && !isInProgress && (
          <button
            onClick={() => onSetInProgress(task)}
            className="text-[#bbb] hover:text-yellow-500 p-0.5 rounded transition-colors"
            title="Set in progress"
          >
            <Clock size={11} />
          </button>
        )}
        <button
          onClick={() => onDelete(task.id)}
          className="text-[#bbb] hover:text-red-500 p-0.5 rounded transition-colors"
          title="Delete task"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
