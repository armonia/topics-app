import { memo, Suspense, useState, type MouseEvent } from 'react';
import { AlarmClock, CircleCheck, ExternalLink, Hourglass, Loader2, Server, Square, SquareTerminal, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { scriptsApi } from '../../lib/api';
import { useToast } from '../Shared/Toast';
import { listenLabel, listenUrl } from '../../../../shared/background-work';
import type { LiveAgentRow, LiveCommandRow } from '../../../../shared/live-work';
import { dismissSubAgent, useDismissedSubAgents } from '../../state/endedSubAgents';
import { useLiveWork, visibleRows } from '../../state/liveWork';
import { CHAT_STRIP_NEUTRAL } from '../../lib/chatStripStyles';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { subscribeFrames } from '../../lib/wsFrameBus';
import { lazyWarm } from '../../lib/lazyWarm';
import { loadProcessLog } from '../../state/pane/panePreload';
import { DockedStripPanel } from './DockedStripPanel';
import type { WSMessage } from '../../types';

// The log opens on a click: its pane stays out of the entry chunk, as everywhere else
// (`panePreload`). Imported statically here it added 2.8 kB gz to the entry and broke `check:bundle`.
const ProcessLogPane = lazyWarm(loadProcessLog, (m) => m.ProcessLogPane);

/**
 * WHAT WORKS NOW FOR THIS CHAT, one row each, under the chat (chat-live-work):
 * the sub-agents it spawned that are working or waiting for their prompt
 * (native and CLI), and the processes it runs (`run_command`, a `run_script`
 * of its agent), each with the line it is on. The rows come from the server
 * (`state/liveWork.ts`); no rows, no strip.
 *
 * On 07/10 the Prince of Persia chat showed three sub-agents ended hours before
 * and nothing of the 58 minutes Muse was working, which is what the person was
 * waiting on. So an ended sub-agent stays one minute with its check, then
 * leaves, and a command is a row like a sub-agent.
 *
 * A row opens what it is: a CLI child's terminal, a native child's chat, a
 * command's live log, docked above the rows (`DockedStripPanel`) so the chat
 * keeps its place. A server has its address and «Open» on the row.
 *
 * A command is also where it stops («Stop», the Processes panel's route) and
 * where it says that its end will wake the chat. Both used to be two more
 * rows under the transcript, the background line and a server's row
 * (BGVIS-07/08), which named the same commands a second time: on 07/10 the
 * Prince of Persia chat showed Muse and the clip server twice. The background
 * line keeps the CLI's own work (a background Bash, a Monitor, an Agent),
 * which no row here lists.
 *
 * Every click stops at the row: the chat panel around the strip focuses ITSELF
 * on click (`ChatPanel` onClick={onFocus}), and left to bubble that focus
 * landed after the terminal's and took the front back.
 */

const ROW = 'flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-left text-mini hover:bg-app-hover transition-colors';
const SIDE_BUTTON = 'flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 mr-1 text-mini text-app-text-secondary hover:bg-app-hover hover:text-app-text';

/** The log's live updates, on the frame bus every window already has. */
const onScriptFrames = (handler: (msg: WSMessage) => void) =>
  subscribeFrames((frame) => handler(frame as WSMessage), { types: ['scripts:output'] });

function AgentRow({ row }: { row: LiveAgentRow }) {
  const tr = useT();
  const { id, name, state } = row;
  const title = state === 'working' ? tr('subagent.busy', { name })
    : state === 'waiting' ? tr('subagent.waiting', { name })
    : tr('subagent.ended', { name });
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    // A native child has no terminal: its agentId is its chat's topic id.
    if (row.runtime === 'topics') {
      window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId: id, mode: 'permanent', reveal: true } }));
    } else {
      window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: id, name } }));
    }
  };
  const preview = state === 'ended' ? row.preview || tr('livework.finished') : row.preview;
  return (
    <div data-testid="subagent-row" data-subagent-id={id} data-state={state} data-runtime={row.runtime} className="flex min-w-0 items-center">
      <button type="button" onClick={open} title={title} aria-label={title} className={ROW}>
        {state === 'working'
          ? <Loader2 size={11} aria-hidden="true" className="animate-spin text-blue-500 flex-shrink-0" />
          : state === 'waiting'
            ? <Hourglass size={11} aria-hidden="true" className="text-amber-500 flex-shrink-0" />
            : <CircleCheck size={11} aria-hidden="true" className="text-blue-500 flex-shrink-0" />}
        <span className={`max-w-[40%] flex-shrink-0 truncate ${state === 'ended' ? 'text-app-text-muted' : 'text-app-text'}`}>{name}</span>
        {preview && <span data-testid="live-work-preview" className="min-w-0 flex-1 truncate text-app-text-tertiary">{preview}</span>}
      </button>
      {state === 'ended' && (
        <button
          type="button"
          data-testid="subagent-dismiss"
          onClick={(e) => { e.stopPropagation(); dismissSubAgent(id); }}
          title={tr('subagent.dismiss', { name })}
          aria-label={tr('subagent.dismiss', { name })}
          className="flex-shrink-0 rounded-full p-1 mr-1 text-app-text-muted hover:bg-app-hover hover:text-app-text transition-colors"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function CommandRow({ row, open, onToggle }: { row: LiveCommandRow; open: boolean; onToggle: () => void }) {
  const tr = useT();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  // The server puts the page first when the command serves more than one port.
  const first = row.listen[0];
  const url = first ? listenUrl(first) : '';
  const title = tr('livework.logTitle', { name: row.name });
  const wakes = tr('chat.background.wakes');
  // The row leaves once the server sees the process end; until then its Stop stays pressed.
  const stop = async () => {
    setStopping(true);
    try { await scriptsApi.stop(row.id); } catch { toast.error(tr('livework.stopFailed', { name: row.name })); setStopping(false); }
  };
  return (
    <div data-testid="live-command-row" data-process-id={row.id} data-open={open ? 'true' : 'false'} className="flex min-w-0 items-center" title={row.wakes ? `${row.command}\n${wakes}` : row.command}>
      <button type="button" aria-expanded={open} aria-label={title} onClick={(e) => { e.stopPropagation(); onToggle(); }} className={ROW}>
        {first
          ? <Server size={11} aria-hidden="true" className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          : <SquareTerminal size={11} aria-hidden="true" className="text-app-text-secondary flex-shrink-0" />}
        <span className="max-w-[40%] flex-shrink-0 truncate text-app-text">{row.name}</span>
        {first && <span data-testid="live-work-address" className="flex-shrink-0 tabular-nums text-app-text-secondary">{row.listen.map(listenLabel).join(', ')}</span>}
        <span data-testid="live-work-preview" className="min-w-0 flex-1 truncate font-mono text-app-text-tertiary">{row.preview}</span>
      </button>
      {row.wakes && (
        <span data-testid="live-work-wakes" role="img" aria-label={wakes} title={wakes} className="flex flex-shrink-0 px-1 text-app-text-secondary">
          <AlarmClock size={11} aria-hidden="true" />
        </span>
      )}
      {url && (
        <button
          type="button"
          data-testid="live-work-open"
          className={SIDE_BUTTON}
          title={tr('chat.service.openTitle', { url })}
          onClick={(e) => { e.stopPropagation(); openLink(url, { external: isExternalLinkGesture(e), origin: e.currentTarget }); }}
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />{tr('chat.service.open')}
        </button>
      )}
      <button
        type="button"
        data-testid="live-work-stop"
        className={`${SIDE_BUTTON} disabled:opacity-50`}
        disabled={stopping}
        title={tr('livework.stopTitle', { name: row.name })}
        onClick={(e) => { e.stopPropagation(); void stop(); }}
      >
        <Square className="h-3 w-3" aria-hidden="true" />{tr('chat.service.stop')}
      </button>
    </div>
  );
}

export const SubAgentsStrip = memo(function SubAgentsStrip({ topicId }: { topicId: string }) {
  const dismissed = useDismissedSubAgents();
  const rows = visibleRows(useLiveWork(topicId), dismissed);
  // The log stays open when its command ends and its row leaves: its end is what one opens it to read.
  const [log, setLog] = useState<{ id: string; name: string } | null>(null);
  if (rows.length === 0 && !log) return null;

  return (
    <div data-testid="subagents-strip" className={`${CHAT_STRIP_NEUTRAL} overflow-hidden`}>
      <DockedStripPanel open={!!log} testId="live-work-log">
        {log && (
          <div className="h-56">
            <Suspense fallback={null}>
              <ProcessLogPane key={log.id} processId={log.id} scriptName={log.name} onMessage={onScriptFrames} onClose={() => setLog(null)} />
            </Suspense>
          </div>
        )}
      </DockedStripPanel>
      <div className="max-h-[7.5rem] overflow-y-auto">
        {rows.map((row) => (row.kind === 'agent'
          ? <AgentRow key={row.id} row={row} />
          : <CommandRow key={row.id} row={row} open={log?.id === row.id} onToggle={() => setLog(log?.id === row.id ? null : { id: row.id, name: row.name })} />))}
      </div>
    </div>
  );
});
