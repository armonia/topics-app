/**
 * WHAT THE CHAT IS WAITING ON, the last row of the transcript.
 *
 * A turn that ends with an Agent, a Bash, a Monitor or a Workflow still running
 * leaves the chat with no turn open and nothing on screen: no phrase, no timer,
 * no spinner, while the CLI waits for its own work and will wake to answer it.
 * This line names that work, from the tasks of the chat's attention state
 * (`useTopicBackgroundTasks`, the frame the grey glyph and the fill read too,
 * ATTN-12), and goes away with it. The poll of `/api/topics/streaming` adds
 * only what the attention state does not carry: the process of each
 * `run_command` (its link to the Processes pane) and when the CLI last said
 * something about the work (the stale readout).
 *
 * NO STOP HERE. The composer already offers it with an empty field
 * (`composerAction.ts`), and two commands for one thing read as two things; the
 * tooltip says where it is.
 *
 * IT SITS UNDER THE LAST MESSAGE, NOT ABOVE THE COMPOSER. Mounted among the
 * strips of the composer block, every start and end of the work grew or shrank
 * that block: the composer jumped by the line's height and the transcript lost
 * it. As the last row of the list (Virtuoso's `Footer`, in `MessageList`) it
 * scrolls with the conversation, answers the turn it belongs to, and its
 * height reaches the list through `totalListHeightChanged`, the same hook that
 * keeps a chat at the bottom pinned while a reader scrolled up stays put.
 * `chat-measure` and the row padding put it on the message column, as
 * `QueuedTurns` beside it.
 *
 * Past `WORK_STALE_AFTER_MS` without news the line says for how long, with the
 * amber of `LabeledLoader`'s stale readout: the CLI may have stopped reporting.
 *
 * THE NAMES ARE WHAT THE LINE IS FOR, so they are the last thing to give up
 * room. On one row that cannot wrap, the label and the readout held their text
 * and the names took what was left: on a 375px phone, with work gone stale,
 * that was nothing. The row wraps instead. The names keep a 6rem floor on the
 * label's line, and whatever does not fit beside them (the readout first,
 * then the names themselves) goes below at full width. The glyph and the label
 * are one piece, so the ring never sits alone on a line.
 *
 * EACH TASK SAYS WHAT IT IS AND FOR HOW LONG (BGVIS-06), as Claude Code's own
 * list does: a Monitor carries the icon of the Monitor tool row, and every task
 * with a start time its running time. The CLI lists a Monitor as a plain
 * `local_bash`; the server recognises it from the tool call that armed it.
 *
 * A COMMAND OF TOPICS IS WORK TOO (BGVIS-07). A process the agent started with
 * `run_command` lives in Topics' registry, not in the CLI, and the chat showed
 * nothing while it ran (30/09: "no UI at all, I don't know what it is doing").
 * It is listed here like the CLI's tasks, with a terminal icon, its running
 * time and, when its end will wake the chat, that it will. A click opens it in
 * the Processes pane of the chat's project window, where its Stop is: the
 * composer's Stop stops the CLI's work, and a command outlives the CLI.
 *
 * A NEW TURN DOES NOT TAKE IT AWAY. The work of an earlier turn keeps running
 * while the next one is open, and the line keeps naming it until it ends
 * (BGVIS-05). Only the tooltip changes: with a turn open the chat is not free,
 * and the composer's Stop is the turn's.
 */
import { memo } from 'react';
import { Activity, SquareTerminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTopicBackgroundDetail, useTopicBackgroundTasks, useTopicLoading } from '../../state/signals';
import type { TopicBackgroundWork } from '../../state/backgroundWork';
import type { AttentionTask } from '../../../../shared/attention';
import type { BackgroundTaskSummary } from '../../../../shared/background-work';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact, formatRunningFor } from '../../state/workLongevity';
import { CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import { OrbitLoader } from '../Layout/StreamingIndicator';
import { OPEN_PROCESS_LOG_EVENT } from '../Layout/fileOpenScope';

export const BackgroundWorkLine = memo(function BackgroundWorkLine({ topicId, projectPath, isMobile }: { topicId: string; projectPath?: string; isMobile: boolean }) {
  const tasks = useTopicBackgroundTasks(topicId);
  const detail = useTopicBackgroundDetail(topicId);
  const work = tasks.length > 0 ? lineWork(tasks, detail) : undefined;
  const turnOpen = useTopicLoading(topicId);
  // Mounted only while there is work, so the shared clock ticks only then.
  return work ? (
    <div className={`chat-measure pb-2 ${isMobile ? 'px-2' : 'px-4'}`}>
      <Line work={work} turnOpen={turnOpen} projectPath={projectPath} />
    </div>
  ) : null;
});

/**
 * What the line names: the attention state's tasks, in its order, with the
 * poll's detail where it has one. A `command` of the attention state stands
 * for every `run_command` of the chat: the poll lists them one by one, with
 * the process the click opens. A Monitor is a `monitor` here and in the poll.
 */
function lineWork(tasks: readonly AttentionTask[], detail: TopicBackgroundWork | undefined): TopicBackgroundWork {
  const commands = (detail?.tasks ?? []).filter((t) => t.type === 'command');
  const named: BackgroundTaskSummary[] = [];
  for (const t of tasks) {
    // A queued wake is no work: it is the CLI about to answer a report. It
    // keeps the line up and is named by «about to resume» (n = 0 below), the
    // branch that otherwise no attention state could reach.
    if (t.kind === 'wake') continue;
    if (t.kind === 'command' && commands.length > 0) { named.push(...commands); continue; }
    const startedAt = Date.parse(t.startedAt);
    named.push({ type: t.kind, description: t.label, ...(Number.isFinite(startedAt) ? { startedAt } : {}) });
  }
  return { sessionKey: detail?.sessionKey ?? '', tasks: named, lastSignalAt: detail?.lastSignalAt ?? 0 };
}

/**
 * Opens a command's log as a pane of the project window that hosts this chat
 * (`useProjectFileOpen`, scoped by project like `open-file-diff`). A chat with
 * no project window around it has nobody listening, and nothing opens.
 */
function openCommandProcess(task: BackgroundTaskSummary, projectPath: string | undefined): void {
  if (!task.processId) return;
  window.dispatchEvent(new CustomEvent(OPEN_PROCESS_LOG_EVENT, {
    detail: { processId: task.processId, scriptName: task.description, projectPath },
  }));
}

function Line({ work, turnOpen, projectPath }: { work: TopicBackgroundWork; turnOpen: boolean; projectPath?: string }) {
  const tr = useT();
  const now = useSharedNow();
  const n = work.tasks.length;
  const names = work.tasks.map((t) => t.description).join(', ');
  // Commands only: the composer's Stop has nothing to stop, their own Stop is in the Processes pane.
  const commandsOnly = n > 0 && work.tasks.every((t) => t.type === 'command');
  // With no task listed a report is waking the CLI right now: that is news.
  const { isStale, elapsedMs } = deriveWorkLongevity(n > 0 && work.lastSignalAt > 0 ? work.lastSignalAt : undefined, now);
  return (
    <div
      data-testid="background-work-line"
      data-stale={isStale ? 'true' : undefined}
      className="rounded-lg border border-app-border/60 bg-app-hover/40 text-app-text"
      title={[names, turnOpen ? '' : tr(commandsOnly ? 'chat.background.freeCommands' : 'chat.background.free')].filter(Boolean).join('\n')}
    >
      <div className={`${CHAT_STRIP_ROW} flex-wrap gap-y-0.5`}>
        <span className="flex min-w-0 items-center gap-2">
          <span className={`flex flex-shrink-0 ${isStale ? 'opacity-70' : ''}`}>
            <OrbitLoader state="background" />
          </span>
          <span className="min-w-0 truncate text-compact text-app-text-secondary">
            {n === 0
              ? tr('chat.background.resuming')
              : n === 1 ? tr('chat.background.waitingOne') : tr('chat.background.waitingMany', { n })}
          </span>
        </span>
        {n > 0 && (
          <span data-testid="background-work-names" className="min-w-0 grow basis-24 truncate text-compact text-app-text">
            {work.tasks.map((t, i) => <Task key={`${i}:${t.processId ?? t.description}`} task={t} now={now} last={i === n - 1} projectPath={projectPath} />)}
          </span>
        )}
        {isStale && (
          <span className="flex-shrink-0 text-micro tabular-nums text-amber-600 dark:text-amber-400">
            {tr('chat.background.stale', { t: formatElapsedCompact(elapsedMs) })}
          </span>
        )}
      </div>
    </div>
  );
}

function Task({ task, now, last, projectPath }: { task: BackgroundTaskSummary; now: number; last: boolean; projectPath?: string }) {
  const tr = useT();
  const monitor = task.type === 'monitor';
  const command = task.type === 'command';
  const running = task.startedAt ? formatRunningFor(Math.max(0, now - task.startedAt)) : '';
  const body = (
    <>
      {monitor && (
        <Activity className="mr-0.5 inline h-3 w-3 align-[-1px] text-app-text-secondary" role="img" aria-label={tr('chat.background.monitor')} />
      )}
      {command && (
        <SquareTerminal className="mr-0.5 inline h-3 w-3 align-[-1px] text-app-text-secondary" role="img" aria-label={tr('chat.background.command')} />
      )}
      {task.description}
      {running && (
        <span data-testid="background-work-running" className="tabular-nums text-app-text-secondary">{` ${running}`}</span>
      )}
      {command && task.wakes && (
        <span data-testid="background-work-wakes" className="text-app-text-secondary">{` · ${tr('chat.background.wakes')}`}</span>
      )}
    </>
  );
  return (
    <span data-testid="background-work-task" data-type={task.type} data-process-id={task.processId}>
      {command && task.processId ? (
        <button
          type="button"
          data-testid="background-work-open"
          onClick={() => openCommandProcess(task, projectPath)}
          title={tr('chat.background.openProcess')}
          className="inline max-w-full truncate text-left underline-offset-2 hover:underline"
        >
          {body}
        </button>
      ) : body}
      {!last && ', '}
    </span>
  );
}
