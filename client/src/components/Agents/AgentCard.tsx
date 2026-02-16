import type { AgentSession } from '../../hooks/useAgents';

interface AgentCardProps {
  session: AgentSession;
  onNavigateToTopic?: (topicId: string) => void;
}

function statusDot(status: AgentSession['status']): string {
  switch (status) {
    case 'active': return 'bg-green-500 animate-pulse';
    case 'idle': return 'bg-yellow-500';
    case 'error': return 'bg-red-500';
    case 'completed': return 'bg-gray-400';
    default: return 'bg-gray-400';
  }
}

function kindIcon(kind: AgentSession['kind']): string {
  switch (kind) {
    case 'main': return '\ud83c\udfe0';
    case 'group': return '\ud83d\udc65';
    case 'subagent': return '\ud83e\udd16';
    case 'cron': return '\u23f0';
    case 'hook': return '\ud83d\udd17';
    default: return '\ud83d\udcbb';
  }
}

function channelBadge(channel: string): string {
  switch (channel) {
    case 'telegram': return 'TG';
    case 'discord': return 'DC';
    case 'whatsapp': return 'WA';
    case 'webchat': return 'Web';
    case 'internal': return 'Int';
    default: return channel.slice(0, 3);
  }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function shortModelName(model?: string): string {
  if (!model) return '';
  // Shorten common model names
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('gpt-4')) return 'gpt-4';
  if (model.includes('gpt-3.5')) return 'gpt-3.5';
  // Return last part after last hyphen, or truncate
  const parts = model.split('-');
  return parts.length > 2 ? parts.slice(-2).join('-') : model.slice(0, 12);
}

export function AgentCard({ session, onNavigateToTopic }: AgentCardProps) {
  const canNavigate = session.topicId && onNavigateToTopic;

  return (
    <div
      className={`flex items-start gap-2 px-2.5 py-2 rounded-md transition-colors ${
        canNavigate ? 'cursor-pointer hover:bg-app-hover' : ''
      } ${session.status === 'active' ? 'bg-primary/5' : ''}`}
      onClick={() => canNavigate && onNavigateToTopic(session.topicId!)}
      role={canNavigate ? 'button' : undefined}
      tabIndex={canNavigate ? 0 : undefined}
      onKeyDown={(e) => {
        if (canNavigate && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onNavigateToTopic(session.topicId!);
        }
      }}
    >
      {/* Status dot */}
      <div className="flex-shrink-0 pt-1.5">
        <div className={`w-2 h-2 rounded-full ${statusDot(session.status)}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name + model */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px]" aria-hidden="true">{kindIcon(session.kind)}</span>
          <span className="text-[12px] font-medium text-app-text truncate">
            {session.displayName}
          </span>
          {session.model && (
            <span className="text-[10px] text-app-text-tertiary bg-app-hover px-1 rounded flex-shrink-0">
              {shortModelName(session.model)}
            </span>
          )}
        </div>

        {/* Channel + last activity */}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-app-text-tertiary">
            {channelBadge(session.channel)}
          </span>
          <span className="text-[10px] text-app-text-tertiary">
            {formatRelativeTime(session.updatedAt)}
          </span>
          {session.totalTokens != null && session.totalTokens > 0 && (
            <span className="text-[10px] text-app-text-tertiary">
              {formatTokens(session.totalTokens)} tok
            </span>
          )}
        </div>

        {/* Token usage bar */}
        {session.totalTokens != null && session.contextTokens != null && session.contextTokens > 0 && (
          <div className="mt-1">
            <div className="h-1 bg-app-border rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${session.contextTokens ? Math.min(100, (session.totalTokens! / session.contextTokens) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Last message preview */}
        {session.lastMessage && (
          <p className="text-[10px] text-app-text-tertiary mt-1 truncate italic">
            {session.lastMessage}
          </p>
        )}
      </div>
    </div>
  );
}
