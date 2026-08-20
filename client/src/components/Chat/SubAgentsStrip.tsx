import { memo } from 'react';
import { useT } from '../../hooks/useT';
import { Bot, Loader2 } from 'lucide-react';
import { useTerminalSessions } from '../../contexts/TopicsContext';

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
 */
function SubAgentRow({ id, name, busy }: { id: string; name: string; busy: boolean }) {
  const tr = useT();
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: id, name } }))}
      title={busy ? tr('subagent.busy', { name }) : tr('subagent.open', { name })}
      className="flex items-center gap-1.5 rounded-full border border-app-border bg-app-surface/60 px-2.5 py-1 text-[11px] text-app-text hover:bg-app-surface transition-colors max-w-[200px]"
    >
      {busy
        ? <Loader2 size={11} className="animate-spin text-blue-500 flex-shrink-0" />
        : <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500/80 flex-shrink-0" />}
      <span className="truncate">{name}</span>
    </button>
  );
}

export const SubAgentsStrip = memo(function SubAgentsStrip({ topicSessionKey }: { topicSessionKey: string }) {
  const terminals = useTerminalSessions();
  const subAgents = terminals.filter((s) => s.parentSessionKey === topicSessionKey);
  if (subAgents.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-app-border bg-app-bg/40 overflow-x-auto">
      <span className="flex items-center gap-1 text-[11px] text-app-text-muted flex-shrink-0">
        <Bot size={12} />
        <span>Sotto-agenti</span>
      </span>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {subAgents.map((s) => (
          <SubAgentRow key={s.id} id={s.id} name={s.name} busy={!!s.busy} />
        ))}
      </div>
    </div>
  );
});
