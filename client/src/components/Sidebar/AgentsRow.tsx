/**
 * THE AGENTS ROW, next to Automations: the door to the always-on agents'
 * sessions (Jarvis, Visione…), which the sidebar no longer lists as projects.
 * Its tail says how many sessions are at work and how many wait on you, with
 * the amber dot of every other wait; nothing when neither. It counts only the
 * always-on agents: «Agents and jobs» in the System menu counts more, and the
 * title says so.
 */
import { Bot } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { useAgentGroups } from '@/state/agentGroups';
import { agentTotals } from '@/lib/agentSessions';
import { agentsWaitingText } from '@/lib/agentsWaitingText';
import { sidebarRowCard, ROW_PX, ROW_H, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT, TAB_LABEL_TYPE } from '@/lib/selectionStyles';
import { PALLINO_ATTESA, SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';

export function AgentsRow({ open }: { open: boolean }) {
  const tr = useT();
  const groups = useAgentGroups();
  if (groups.length === 0) return null;
  const { working, waiting } = agentTotals(groups);
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={open}
      data-testid="sidebar-agents"
      title={tr('agents.rowTitle')}
      onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'agents' } }))}
      className={`flex flex-shrink-0 items-center gap-2 leading-none ${ROW_PX} ${ROW_H} select-none ${sidebarRowCard({ focused: open })}`}
      style={{ width: `calc(100% - ${ROW_INSET * 2}px)` }}
    >
      <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="glyph">
        <Bot size={ROW_GLYPH} className="text-app-text-secondary" aria-hidden="true" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-left ${TAB_LABEL_TYPE}`}>{tr('agents.open')}</span>
      <span data-testid="sidebar-agents-tail" className="flex-shrink-0 text-mini tabular-nums">
        {working > 0 ? <span className={SEGNALE_OK}>{tr('agents.working', { n: working })}</span> : null}
        {working > 0 && waiting > 0 ? <span className="text-app-text-muted"> · </span> : null}
        {waiting > 0 ? (
          <span className={`inline-flex items-center gap-1 ${SEGNALE_ATTESA}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${PALLINO_ATTESA}`} aria-hidden="true" />
            {agentsWaitingText(waiting, tr)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
