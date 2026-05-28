import type { AgentProfile } from '../../lib/api';

interface AgentProfileCardProps {
  profile: AgentProfile;
  onEdit?: () => void;
  onAssign?: () => void;
  onViewSessions?: () => void;
}

function statusColor(status: AgentProfile['status']): string {
  switch (status) {
    case 'available': return 'bg-green-500';
    case 'busy': return 'bg-yellow-500 animate-pulse';
    case 'paused': return 'bg-gray-400';
    case 'offline': return 'bg-red-500';
    default: return 'bg-gray-400';
  }
}

function statusLabel(status: AgentProfile['status']): string {
  switch (status) {
    case 'available': return 'Available';
    case 'busy': return 'Busy';
    case 'paused': return 'Paused';
    case 'offline': return 'Offline';
    default: return status;
  }
}

function roleBadge(role: AgentProfile['role']): { label: string; className: string } {
  switch (role) {
    case 'lead': return { label: 'Lead', className: 'bg-purple-500/20 text-purple-400' };
    case 'worker': return { label: 'Worker', className: 'bg-blue-500/20 text-blue-400' };
    case 'specialist': return { label: 'Specialist', className: 'bg-amber-500/20 text-amber-400' };
    default: return { label: role, className: 'bg-gray-500/20 text-gray-400' };
  }
}

export function AgentProfileCard({ profile, onEdit, onAssign, onViewSessions }: AgentProfileCardProps) {
  const role = roleBadge(profile.role);

  return (
    <div className="bg-app-surface border border-app-border rounded-lg p-3 flex flex-col gap-2 hover:border-primary/40 transition-colors">
      {/* Header: avatar + name + status */}
      <div className="flex items-center gap-2">
        <span className="text-xl flex-shrink-0" aria-hidden="true">{profile.avatarEmoji}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-app-text truncate">{profile.name}</span>
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor(profile.status)}`} title={statusLabel(profile.status)} />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${role.className}`}>
              {role.label}
            </span>
            {profile.modelPreference && (
              <span className="text-[11px] text-app-text-tertiary bg-app-hover px-1 rounded">
                {profile.modelPreference}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Capabilities */}
      {profile.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {profile.capabilities.map((cap) => (
            <span
              key={cap}
              className="text-[11px] px-1.5 py-0.5 rounded bg-app-hover text-app-text-secondary"
            >
              {cap}
            </span>
          ))}
        </div>
      )}

      {/* Footer: actions */}
      <div className="flex items-center gap-2 mt-auto pt-1">
        <span className="text-[11px] text-app-text-tertiary">
          Max tasks: {profile.maxConcurrentTasks}
        </span>
        <div className="flex-1" />
        {onViewSessions && (
          <button
            onClick={onViewSessions}
            className="text-[11px] px-2 py-0.5 rounded bg-app-hover text-app-text-secondary hover:text-app-text transition-colors"
          >
            Sessions
          </button>
        )}
        {onAssign && (
          <button
            onClick={onAssign}
            className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            Assign
          </button>
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            className="text-[11px] px-2 py-0.5 rounded bg-app-hover text-app-text-secondary hover:text-app-text transition-colors"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

