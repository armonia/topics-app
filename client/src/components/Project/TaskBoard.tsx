import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, CheckSquare, Circle, Clock, CheckCircle2, Loader2, LayoutGrid } from 'lucide-react';
import { boardsApi, type BoardTask, type TaskStatus } from '../../lib/api';
import type { WSMessage } from '../../types';

interface TaskBoardProps {
  topicId: string;
  projectId: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onOpenBoard?: () => void;
}

const COLLAPSE_KEY = 'topics-taskboard-collapsed';

export function TaskBoard({ topicId, projectId, onWSMessage, onOpenBoard }: TaskBoardProps) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; }
  });

  // Load tasks
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    boardsApi.listTasks(projectId)
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
      if (msg.type === 'task:updated' || msg.type === 'task:moved') {
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

  const pendingCount = useMemo(() =>
    tasks.filter(t => t.status !== 'done').length,
  [tasks]);

  return (
    <div className="border-b border-app-border">
      <div
        onClick={toggleCollapse}
        className="w-full flex items-center gap-2 px-3 h-8 text-[12px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer select-none"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <CheckSquare size={14} />
        <span>Tasks</span>
        {pendingCount > 0 && (
          <span className="ml-1 bg-primary text-white text-[9px] px-1.5 py-0.5 rounded-full leading-none font-bold">
            {pendingCount}
          </span>
        )}
        {onOpenBoard && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenBoard(); }}
            className="ml-auto w-6 h-6 flex items-center justify-center text-emerald-500 hover:text-emerald-400 hover:bg-black/10 dark:hover:bg-white/10 rounded transition-colors"
            title="Open full Board"
          >
            <LayoutGrid size={12} />
          </button>
        )}
      </div>

      {/* Content — list view only */}
      {!collapsed && (
        <div className="px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 size={14} className="animate-spin text-app-text-muted" />
            </div>
          ) : (
            <TaskList
              tasks={tasks}
              projectId={projectId}
              topicId={topicId}
              onUpdate={setTasks}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Compact list view for sidebar
function TaskList({
  tasks,
  projectId,
  topicId,
  onUpdate,
}: {
  tasks: BoardTask[];
  projectId: string;
  topicId: string;
  onUpdate: (tasks: BoardTask[]) => void;
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
      const task = await boardsApi.createTask(projectId, { text: newText.trim(), status: 'todo', chatId: topicId });
      onUpdate([...tasks, task]);
      setNewText('');
      setShowInput(false);
    } catch {}
  };

  const handleToggle = async (task: BoardTask) => {
    const newStatus: TaskStatus = task.status === 'done' ? 'todo' : 'done';
    try {
      const updated = await boardsApi.moveTask(projectId, task.id, newStatus);
      onUpdate(tasks.map(t => t.id === task.id ? updated : t));
    } catch {}
  };

  const handleDelete = async (taskId: string) => {
    try {
      await boardsApi.deleteTask(projectId, taskId);
      onUpdate(tasks.filter(t => t.id !== taskId));
    } catch {}
  };

  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const todo = tasks.filter(t => t.status === 'todo');
  const backlog = tasks.filter(t => t.status === 'backlog' || t.status === 'review');
  const done = tasks.filter(t => t.status === 'done');

  const renderGroup = (label: string, items: BoardTask[], colorClass: string) =>
    items.length > 0 && (
      <div className="mb-1.5">
        <div className={`text-[10px] font-semibold ${colorClass} px-1 py-0.5 uppercase tracking-wider`}>{label}</div>
        {items.map(task => (
          <div key={task.id} className="group flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-black/3 dark:hover:bg-white/3">
            <button onClick={() => handleToggle(task)} className={`flex-shrink-0 ${task.status === 'done' ? 'text-green-500' : task.status === 'in_progress' ? 'text-yellow-500' : 'text-app-placeholder hover:text-primary'}`}>
              {task.status === 'done' ? <CheckCircle2 size={14} /> : task.status === 'in_progress' ? <Clock size={14} /> : <Circle size={14} />}
            </button>
            <span className={`flex-1 text-[11px] truncate ${task.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}>{task.text}</span>
            <button onClick={() => handleDelete(task.id)} className="opacity-0 group-hover:opacity-100 text-app-placeholder hover:text-red-500 p-0.5 transition-all"><Trash2 size={11} /></button>
          </div>
        ))}
      </div>
    );

  return (
    <>
      {renderGroup('In Progress', inProgress, 'text-yellow-600 dark:text-yellow-400')}
      {renderGroup('Todo', todo, 'text-blue-600 dark:text-blue-400')}
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
