import { useState, useEffect } from 'react';
import { X, UserPlus, UserMinus } from 'lucide-react';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';

interface AgentAssignPanelProps {
  topicId: string;
  topicName: string;
  onClose: () => void;
}

export function AgentAssignPanel({ topicId, topicName, onClose }: AgentAssignPanelProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agentProfilesApi.list()
      .then(data => { setProfiles(data); setError(null); })
      .catch(err => { console.error('Failed to load profiles:', err); setError('Failed to load agent profiles'); })
      .finally(() => setLoading(false));
  }, []);

  const assignedProfiles = profiles.filter(p =>
    p.assignments?.some(a => a.topicId === topicId)
  );
  const availableProfiles = profiles.filter(p =>
    !p.assignments?.some(a => a.topicId === topicId)
  );

  const handleAssign = async (profileId: string, role: 'lead' | 'worker' = 'worker') => {
    try {
      await agentProfilesApi.assign(profileId, topicId, role);
      const updated = await agentProfilesApi.list();
      setProfiles(updated);
      setError(null);
    } catch (err: any) {
      console.error('Failed to assign:', err);
      setError('Failed to assign agent');
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleUnassign = async (profileId: string) => {
    try {
      await agentProfilesApi.unassign(profileId, topicId);
      const updated = await agentProfilesApi.list();
      setProfiles(updated);
      setError(null);
    } catch (err: any) {
      console.error('Failed to unassign:', err);
      setError('Failed to unassign agent');
      setTimeout(() => setError(null), 3000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface border border-app-border rounded-lg shadow-xl w-[360px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <UserPlus size={14} className="text-primary" />
          <div className="flex-1 min-w-0">
            <span className="text-[13px] font-semibold text-app-text block">Assign Agents</span>
            <span className="text-[10px] text-app-text-muted truncate block">{topicName}</span>
          </div>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <div className="text-[10px] text-red-400 px-4 py-1.5">{error}</div>}
          {loading ? (
            <div className="px-4 py-8 text-center text-[11px] text-app-text-muted">Loading...</div>
          ) : (
            <>
              {/* Assigned */}
              {assignedProfiles.length > 0 && (
                <div className="px-4 py-2">
                  <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2">
                    Assigned ({assignedProfiles.length})
                  </div>
                  <div className="space-y-1">
                    {assignedProfiles.map(p => {
                      const assignment = p.assignments?.find(a => a.topicId === topicId);
                      return (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded bg-primary/5 border border-primary/10"
                        >
                          <span className="text-base">{p.avatarEmoji}</span>
                          <span className="text-[11px] text-app-text font-medium flex-1">{p.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                            {assignment?.role || 'worker'}
                          </span>
                          <button
                            onClick={() => handleUnassign(p.id)}
                            className="text-app-text-muted hover:text-red-500 transition-colors"
                            title="Remove"
                          >
                            <UserMinus size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Available */}
              <div className="px-4 py-2">
                <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-2">
                  Available ({availableProfiles.length})
                </div>
                {availableProfiles.length === 0 ? (
                  <div className="text-[11px] text-app-text-muted py-2">No available agents</div>
                ) : (
                  <div className="space-y-1">
                    {availableProfiles.map(p => (
                      <div
                        key={p.id}
                        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <span className="text-base">{p.avatarEmoji}</span>
                        <div className="flex-1 min-w-0">
                          <span className="text-[11px] text-app-text font-medium block">{p.name}</span>
                          <span className="text-[9px] text-app-text-muted">{p.role} &middot; {p.status}</span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleAssign(p.id, 'worker')}
                            className="text-[9px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium"
                          >
                            Worker
                          </button>
                          <button
                            onClick={() => handleAssign(p.id, 'lead')}
                            className="text-[9px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors font-medium"
                          >
                            Lead
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
