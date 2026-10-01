/**
 * THE SUB-AGENT CARD (SUBAGENT-16): the card of a `spawn_agent` call and of
 * each result a child reports, as `Agent` has its own. The name the parent
 * chose, the profile, the model the child really ran, its live state, and once
 * a turn has ended, how it ended. Icons from lucide, labels from i18n.
 *
 * A result row is the machine's (`server/services/subagent-wake.ts`): a `user`
 * row when it woke the chat, an `assistant` row when it could not. Either way
 * it is drawn as cards, never as the person's bubble.
 */
import { useMemo, type ComponentType } from 'react';
import { Bot, CircleCheck, CircleStop, CircleX, Hourglass, Loader2, MailX, SquareTerminal, Unplug } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTerminalSessions } from '../../contexts/TopicsContext';
import type { SubagentResultCard, ToolCallDetail } from '../../types';
import type { SubagentResultBlock } from './machineRow';
import { foregroundSpawnResult, reasonText, spawnCardState, useSubagentResult, type SpawnCardState } from './subagentResult';

const STATUS_ICON: Record<SubagentResultCard['status'], { icon: ComponentType<{ size?: number; className?: string }>; tone: string }> = {
  completed: { icon: CircleCheck, tone: 'text-emerald-500' },
  failed: { icon: CircleX, tone: 'text-red-500' },
  stopped: { icon: CircleStop, tone: 'text-amber-500' },
  undelivered: { icon: MailX, tone: 'text-amber-500' },
  lost: { icon: Unplug, tone: 'text-red-500' },
};

function openPane(agentId: string, name: string): void {
  window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', { detail: { sessionId: agentId, name } }));
}

/** Profile and model, the two facts the parent chose or inherited. */
function Facts({ agentType, model }: { agentType?: string; model?: string }) {
  if (!agentType && !model) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-app-text-muted">
      {agentType && <span className="font-mono text-purple-500">{agentType}</span>}
      {model && <span className="truncate font-mono" data-testid="subagent-model">{model}</span>}
    </span>
  );
}

/** One ended turn: its status, why, and the child's words or the last line seen. */
export function SubAgentResultView({ card }: { card: SubagentResultCard }) {
  const tr = useT();
  const { icon: Icon, tone } = STATUS_ICON[card.status] ?? STATUS_ICON.failed;
  const reason = reasonText(tr, card.reason);
  const text = card.text.trim();
  return (
    <div
      data-testid="subagent-result-card"
      data-agent-id={card.agentId}
      data-status={card.status}
      className="space-y-1 rounded border border-app-border bg-app-surface/60 px-2.5 py-1.5 text-mini"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot size={12} className="flex-shrink-0 text-app-text-muted" />
        <span className="truncate font-medium text-app-text">{card.name}</span>
        <Icon size={12} className={`flex-shrink-0 ${tone}`} />
        <span className="truncate text-app-text-secondary" data-testid="subagent-status">{tr(`chat.subagent.status.${card.status}`)}</span>
        {card.turn > 1 && <span className="flex-shrink-0 text-app-text-muted">{tr('chat.subagent.turn', { n: card.turn })}</span>}
        <span className="ml-auto" />
        <Facts agentType={card.agentType} model={card.model} />
      </div>
      {reason && <div className="italic text-app-text-muted">{reason}</div>}
      {card.status === 'completed'
        ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-app-text-secondary">{text || tr('chat.subagent.noOutput')}</pre>
        : text && (
          <div>
            <div className="text-app-text-muted">{tr('chat.subagent.lastSeen')}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 border-app-border pl-2 text-app-text-muted">{text}</pre>
          </div>
        )}
      {card.branch && <div className="font-mono text-app-text-muted">{card.branch}</div>}
    </div>
  );
}

/** A row of the chat that carries sub-agent results: one card each, no bubble. */
export function SubAgentResultRow({ messageId, block }: { messageId?: string; block: SubagentResultBlock }) {
  const tr = useT();
  return (
    <div data-testid="subagent-result-row" data-message-id={messageId} title={tr('chat.subagent.rowTitle')} className="my-1 space-y-1 px-2">
      {block.results.map((card) => <SubAgentResultView key={`${card.agentId}:${card.turn}:${card.status}`} card={card} />)}
    </div>
  );
}

const PHASE_ICON: Record<SpawnCardState, { icon: ComponentType<{ size?: number; className?: string }>; className: string }> = {
  starting: { icon: Loader2, className: 'animate-spin text-app-text-muted' },
  'waiting-prompt': { icon: Hourglass, className: 'text-amber-500' },
  working: { icon: Loader2, className: 'animate-spin text-blue-500' },
  finished: { icon: CircleCheck, className: 'text-blue-500' },
  ended: { icon: CircleStop, className: 'text-app-text-muted' },
};

/** The card of a `spawn_agent` call: who it started, and where that child is now. */
export function SpawnAgentCard({ detail, sessionKey, isRunning }: {
  detail: Extract<ToolCallDetail, { type: 'sub_agent' }>;
  sessionKey?: string;
  isRunning?: boolean;
}) {
  const tr = useT();
  const terminals = useTerminalSessions();
  // A later turn's row wins; a foreground call's first result is only in its own answer.
  const rowResult = useSubagentResult(sessionKey, detail.agentId);
  const answered = useMemo(() => foregroundSpawnResult(detail.result, detail.agentId), [detail.result, detail.agentId]);
  const result = rowResult ?? answered;
  const live = detail.agentId ? terminals.find((s) => s.id === detail.agentId) ?? null : null;
  const state = spawnCardState({ live, result, isRunning: !!isRunning });
  const { icon: Icon, className } = PHASE_ICON[state];
  const name = detail.name ?? result?.name ?? detail.description ?? tr('chat.subagent.title');
  return (
    <div className="space-y-1.5" data-testid="spawn-agent-card" data-state={state} data-agent-id={detail.agentId}>
      <div className="flex min-w-0 items-center gap-1.5 text-mini">
        <Icon size={12} className={`flex-shrink-0 ${className}`} />
        <span className="truncate font-medium text-app-text" data-testid="spawn-agent-name">{name}</span>
        <span className="flex-shrink-0 text-app-text-secondary" data-testid="spawn-agent-phase">{tr(`chat.subagent.phase.${state}`)}</span>
        <span className="ml-auto" />
        <Facts agentType={detail.subAgentType} model={result?.model ?? detail.model} />
        {live && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openPane(live.id, name); }}
            title={tr('chat.subagent.open')}
            aria-label={tr('chat.subagent.open')}
            className="flex-shrink-0 rounded p-0.5 text-app-text-muted hover:bg-app-hover hover:text-app-text"
          >
            <SquareTerminal size={12} />
          </button>
        )}
      </div>
      {detail.name && detail.description && <div className="line-clamp-2 text-mini text-app-text-muted">{detail.description}</div>}
      {result && <SubAgentResultView card={result} />}
    </div>
  );
}
