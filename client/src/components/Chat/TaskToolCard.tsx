/**
 * THE CARD OF A BOARD CALL: what a chat that creates, moves, comments on,
 * sends back or lands a card shows in its transcript, in place of the raw tool
 * row. Same family as the sub-agent card (`SubAgentResultCard`): a name, a live
 * state, the facts that were chosen, and a click that opens the thing itself.
 *
 * The state is NOT read from the call: it comes from the board store, so a card
 * that goes from todo to working to review changes under the reader without a
 * reload. The call only says which card and what this turn did to it.
 */
import { useEffect, type ComponentType } from 'react';
import { Ban, CheckCheck, CircleCheck, CircleX, Cpu, GitBranch, Hourglass, Inbox, ListTodo, ShieldCheck, ShieldX } from 'lucide-react';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { useT } from '../../hooks/useT';
import { openTaskInApp } from '../../lib/openTaskLink';
import { getMediaUrl } from '../../lib/api';
import { hasLoadedBoardTasks, requestBoardTasksRefresh, useBoardTasks } from '../../lib/boardTasksStore';
import { taskCardPhase, type TaskCardPhase } from '../../lib/taskCardState';
import { useMachines, machineLabel } from '../../state/machinesStore';
import type { BoardTask } from '../../lib/board';
import type { ToolCallDetail } from '../../types';

type Icon = ComponentType<{ size?: number; className?: string }>;
const SparkIcon = () => <SparkLoader className="flex-shrink-0" />;

const PHASE_ICON: Record<TaskCardPhase, { icon: Icon; tone: string }> = {
  backlog: { icon: Inbox, tone: 'text-app-text-muted' },
  todo: { icon: Hourglass, tone: 'text-amber-500' },
  working: { icon: SparkIcon, tone: '' },
  review: { icon: CircleCheck, tone: 'text-blue-500' },
  done: { icon: CheckCheck, tone: 'text-emerald-500' },
  failed: { icon: CircleX, tone: 'text-red-500' },
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/** The agent's own state while the card is being worked, as the dispatcher reports it. */
const AGENT_STATES = new Set(['queued', 'starting', 'working', 'needs_input']);

function titleOf(task: BoardTask | undefined, args: Record<string, unknown> | undefined, fallback: string): string {
  if (task) return task.text;
  return typeof args?.text === 'string' && args.text ? args.text : fallback;
}

function Ci({ task }: { task: BoardTask }) {
  const tr = useT();
  if (!task.checksState || task.checksState === 'unknown') return null;
  const pass = task.checksState === 'pass';
  const fail = task.checksState === 'fail';
  const Icon = fail ? ShieldX : pass ? ShieldCheck : Hourglass;
  const tone = fail ? 'text-red-500' : pass ? 'text-emerald-500' : 'text-amber-500';
  return (
    <span className="inline-flex items-center gap-1" data-testid="task-card-ci" data-state={task.checksState}>
      <Icon size={11} className={tone} />
      <span className="text-app-text-secondary">{tr(`chat.taskCard.ci.${task.checksState}`)}</span>
    </span>
  );
}

export function TaskToolCard({ detail, isRunning, isError, error }: {
  detail: Extract<ToolCallDetail, { type: 'task_card' }>;
  isRunning?: boolean;
  isError?: boolean;
  error?: string;
}) {
  const tr = useT();
  const tasks = useBoardTasks();
  const machines = useMachines();
  useEffect(() => { if (!hasLoadedBoardTasks()) requestBoardTasksRefresh(); }, []);
  const task = detail.taskId ? tasks.find((t) => t.id === detail.taskId) : undefined;
  const phase = task ? taskCardPhase(task) : undefined;
  const phaseIcon = phase ? PHASE_ICON[phase] : undefined;
  const Phase = phaseIcon?.icon ?? ListTodo;
  const refused = isError || !!error;
  const title = titleOf(task, detail.args, tr('chat.taskCard.title'));
  const open = () => { if (detail.taskId) openTaskInApp({ taskId: detail.taskId }); };
  const agent = task?.dispatchState && AGENT_STATES.has(task.dispatchState) ? task.dispatchState : null;
  const machine = task?.machineId ? machineLabel(machines, task.machineId) : task?.runComputerName ?? null;
  const preview = task?.previewImage && IMAGE_EXT.test(task.previewImage) ? getMediaUrl(task.previewImage) : null;
  const canOpen = !!detail.taskId && !refused;

  return (
    <div
      data-testid="task-tool-card"
      data-task-id={detail.taskId}
      data-phase={phase}
      data-action={detail.action}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={canOpen ? (e) => { e.stopPropagation(); open(); } : undefined}
      onKeyDown={canOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); } } : undefined}
      title={canOpen ? tr('chat.taskCard.open') : undefined}
      className={`space-y-1.5 text-mini ${canOpen ? 'cursor-pointer rounded-lg hover:bg-app-hover/40' : ''}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {refused
          ? <Ban size={12} className="flex-shrink-0 text-red-500" />
          : <Phase size={12} className={`flex-shrink-0 ${phaseIcon?.tone ?? 'text-app-text-muted'}`} />}
        <span className="min-w-0 max-w-full grow basis-24 truncate font-medium text-app-text" data-testid="task-card-title">{title}</span>
        <span className="flex-shrink-0 text-app-text-secondary" data-testid="task-card-phase">
          {refused ? tr('chat.taskCard.refused') : phase ? tr(`chat.taskCard.phase.${phase}`) : isRunning ? tr('chat.taskCard.loading') : tr('chat.taskCard.unknown')}
        </span>
        {agent && <span className="flex-shrink-0 text-app-text-muted" data-testid="task-card-agent">{tr(`chat.taskCard.agent.${agent}`)}</span>}
        {task?.model && <span className="truncate font-mono text-app-text-muted" data-testid="task-card-model">{task.model}</span>}
        {machine && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 text-app-text-muted" data-testid="task-card-machine">
            <Cpu size={11} />{machine}
          </span>
        )}
      </div>
      <div className="italic text-app-text-muted" data-testid="task-card-action">{tr(`chat.taskCard.action.${detail.action}`)}</div>
      {detail.reason && <div className="line-clamp-3 text-app-text-secondary" data-testid="task-card-reason">{detail.reason}</div>}
      {refused && error && <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-red-500/5 px-2 py-1.5 text-red-500">{error}</pre>}
      {task && (task.deliveryBranch || task.checksState) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-app-text-muted">
          {task.deliveryBranch && (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono" data-testid="task-card-branch">
              <GitBranch size={11} className="flex-shrink-0" /><span className="truncate">{task.deliveryBranch}</span>
            </span>
          )}
          <Ci task={task} />
        </div>
      )}
      {preview && <img src={preview} alt={tr('chat.taskCard.preview')} loading="lazy" data-testid="task-card-preview" className="max-h-40 rounded-lg border border-app-border object-cover" />}
    </div>
  );
}
