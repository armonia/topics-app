import { memo, useMemo } from 'react';
import { useT } from '../../hooks/useT';
import { Bot, CircleCheck, Hourglass, Loader2, X } from 'lucide-react';
import { useTerminalSessions } from '../../contexts/TopicsContext';
import { dismissSubAgent, subAgentRowsFor, useEndedSubAgents, type SubAgentRow as Row } from '../../state/endedSubAgents';

/**
 * In-chat strip listing the sub-agents this topic spawned (via the MCP
 * `spawn_agent` tool → a claude-code PTY whose `parentSessionKey` is this
 * chat's `sessionKey`). It answers the user's "potrebbe uscire nella ui del
 * topic da cui parte": the sub-agent is now visible from the very chat it was
 * launched from, not only nested in the sidebar tree.
 *
 * Clicking a row opens/focuses that sub-agent's terminal pane. Routing goes
 * through the `topics:open-terminal-pane` CustomEvent bus (handled in App.tsx)
 * so this leaf component doesn't need `handleTerminalClick` threaded down three
 * layout layers — the same handler the sidebar rows use, landing on the exact
 * (now non-blank) terminal pane.
 *
 * The row's click stops at the row: see the comment on it for why.
 *
 * A sub-agent that ENDS keeps its row, marked ended with the calm "done" check,
 * until the user dismisses it or the chat is archived: before, the row (and a
 * one-row strip with it) vanished the moment the process left the live roster,
 * which read as "the sub-agent disappeared". See state/endedSubAgents.ts.
 */
function SubAgentRow({ row }: { row: Row }) {
  const tr = useT();
  const { id, name, state } = row;
  const title = state === 'busy' ? tr('subagent.busy', { name })
    : state === 'waiting' ? tr('subagent.waiting', { name })
    : state === 'ended' ? tr('subagent.ended', { name })
    : tr('subagent.open', { name });
  return (
    <span
      data-testid="subagent-row"
      data-subagent-id={id}
      data-state={state}
      className={`flex items-center rounded-full border border-app-border bg-app-surface/60 text-mini max-w-[220px] ${state === 'ended' ? 'text-app-text-muted' : 'text-app-text'}`}
    >
      <button
        type="button"
        onClick={(e) => {
          // The chat panel around the strip focuses ITSELF on click
          // (`ChatPanel` onClick={onFocus}). Left to bubble, that focus landed
          // after the terminal's and took the front back: the row opened a tab
          // the user never got to see.
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: id, name } }));
        }}
        title={title}
        aria-label={title}
        className={`flex min-w-0 items-center gap-1.5 rounded-full py-1 hover:bg-app-surface transition-colors ${state === 'ended' ? 'pl-2.5 pr-1' : 'px-2.5'}`}
      >
        {state === 'busy'
          ? <Loader2 size={11} className="animate-spin text-blue-500 flex-shrink-0" />
          : state === 'waiting'
            ? <Hourglass size={11} aria-hidden="true" className="text-amber-500 flex-shrink-0" />
          : state === 'ended'
            ? <CircleCheck size={11} aria-hidden="true" className="text-blue-500 flex-shrink-0" />
            : <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500/80 flex-shrink-0" />}
        <span className="truncate">{name}</span>
      </button>
      {state === 'ended' && (
        <button
          type="button"
          data-testid="subagent-dismiss"
          onClick={() => dismissSubAgent(id)}
          title={tr('subagent.dismiss', { name })}
          aria-label={tr('subagent.dismiss', { name })}
          className="flex-shrink-0 rounded-full p-1 mr-0.5 hover:bg-app-surface hover:text-app-text transition-colors"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export const SubAgentsStrip = memo(function SubAgentsStrip({ topicSessionKey }: { topicSessionKey: string }) {
  const tr = useT();
  const terminals = useTerminalSessions();
  const ended = useEndedSubAgents();
  const rows = useMemo(() => subAgentRowsFor(topicSessionKey, terminals, ended), [topicSessionKey, terminals, ended]);
  if (rows.length === 0) return null;

  return (
    <div data-testid="subagents-strip" className="flex items-center gap-2 px-3 py-1.5 border-t border-app-border bg-app-bg/40 overflow-x-auto">
      <span className="flex items-center gap-1 text-mini text-app-text-muted flex-shrink-0">
        <Bot size={12} />
        <span>{tr('subagent.strip')}</span>
      </span>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {rows.map((row) => (
          <SubAgentRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
});
