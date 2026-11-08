/**
 * THE AGENTS ROW, next to Automations: the door to the always-on agents'
 * sessions (Jarvis, Visione…), which the sidebar no longer lists as projects.
 * Its tail says how many agents are at work right now, nothing when none is.
 */
import { Bot } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { useAgentGroups } from '@/state/agentGroups';
import { workingAgentCount } from '@/lib/agentSessions';
import { sidebarRowCard, ROW_PX, ROW_H, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT, TAB_LABEL_TYPE } from '@/lib/selectionStyles';
import { SEGNALE_OK } from './chromeSignals';

export function AgentsRow({ open }: { open: boolean }) {
  const tr = useT();
  const groups = useAgentGroups();
  if (groups.length === 0) return null;
  const n = workingAgentCount(groups);
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={open}
      data-testid="sidebar-agents"
      onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'agents' } }))}
      className={`flex flex-shrink-0 items-center gap-2 leading-none ${ROW_PX} ${ROW_H} select-none ${sidebarRowCard({ focused: open })}`}
      style={{ width: `calc(100% - ${ROW_INSET * 2}px)` }}
    >
      <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="glyph">
        <Bot size={ROW_GLYPH} className="text-app-text-secondary" aria-hidden="true" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-left ${TAB_LABEL_TYPE}`}>{tr('agents.open')}</span>
      <span data-testid="sidebar-agents-tail" className="flex-shrink-0 text-mini tabular-nums">
        {n > 0 ? <span className={SEGNALE_OK}>{tr('agents.working', { n })}</span> : null}
      </span>
    </button>
  );
}
