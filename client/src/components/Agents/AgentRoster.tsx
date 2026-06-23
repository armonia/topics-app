import { useState, useEffect, useCallback } from 'react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { useSuppressNativeBrowser } from '../../lib/browserSuppress';
import { AgentProfileCard } from './AgentProfileCard';
import { AgentProfileEditor } from './AgentProfileEditor';
import { AgentAssignPanel } from './AgentAssignPanel';
import { HeartbeatTimeline } from './HeartbeatTimeline';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';

type StatusFilter = 'all' | AgentProfile['status'];

export function AgentRoster() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  // Modal state
  const [editingProfile, setEditingProfile] = useState<AgentProfile | null | undefined>(undefined); // undefined = closed, null = create new
  const [viewingSessions, setViewingSessions] = useState<AgentProfile | null>(null);
  const [assigningProfile, setAssigningProfile] = useState<AgentProfile | null>(null);
  const [assignTopicId, setAssignTopicId] = useState<string>('');

  // The roster is a pane view, not a modal — but its inline "sessions" overlay
  // is a full-screen MODAL_OVERLAY that would render behind a native browser
  // pane in a sibling split. (editingProfile/assigningProfile open
  // AgentProfileEditor/AgentAssignPanel, which suppress themselves.)
  useSuppressNativeBrowser(!!viewingSessions);

  const fetchProfiles = useCallback(async () => {
    try {
      const data = await agentProfilesApi.list();
      setProfiles(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const filtered = profiles.filter((p) => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.role.toLowerCase().includes(q) ||
        p.capabilities.some((c) => c.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const statusCounts = profiles.reduce<Record<string, number>>(
    (acc, p) => {
      acc[p.status] = (acc[p.status] || 0) + 1;
      return acc;
    },
    {}
  );

  const handleSaveProfile = useCallback((saved: AgentProfile) => {
    setProfiles(prev => {
      const exists = prev.some(p => p.id === saved.id);
      if (exists) return prev.map(p => p.id === saved.id ? saved : p);
      return [...prev, saved];
    });
    setEditingProfile(undefined);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8 text-app-text-tertiary text-sm">
        Loading agent profiles...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-2">
        <span className="text-red-400 text-sm">{error}</span>
        <button
          onClick={fetchProfiles}
          className="text-xs px-3 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-app-text flex-1">Agent Roster</h2>
        <button
          onClick={() => setEditingProfile(null)}
          className="text-xs px-3 py-1 rounded bg-primary text-white hover:bg-primary/90 transition-colors"
        >
          + Create Agent
        </button>
      </div>

      {/* Search + Filter */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents..."
          className="flex-1 text-xs bg-app-hover border border-app-border rounded px-2 py-1.5 text-app-text placeholder:text-app-text-tertiary focus:outline-none focus:border-primary/50"
        />
        <div className="flex items-center gap-1">
          {(['all', 'available', 'busy', 'paused', 'offline'] as StatusFilter[]).map((s) => {
            const count = s === 'all' ? profiles.length : (statusCounts[s] || 0);
            const isActive = statusFilter === s;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`text-[11px] px-2 py-1 rounded transition-colors ${
                  isActive
                    ? 'bg-primary/20 text-primary'
                    : 'bg-app-hover text-app-text-tertiary hover:text-app-text-secondary'
                }`}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                {count > 0 && <span className="ml-1 opacity-60">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-app-text-tertiary">
          <span className="text-2xl mb-2">{profiles.length === 0 ? '\uD83E\uDD16' : '\uD83D\uDD0D'}</span>
          <span className="text-sm">
            {profiles.length === 0
              ? 'No agents yet. Create one to get started.'
              : 'No agents match your filters.'}
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {filtered.map((profile) => (
            <AgentProfileCard
              key={profile.id}
              profile={profile}
              onEdit={() => setEditingProfile(profile)}
              onAssign={() => setAssigningProfile(profile)}
              onViewSessions={() => setViewingSessions(profile)}
            />
          ))}
        </div>
      )}

      {/* Profile editor modal (create or edit) */}
      {editingProfile !== undefined && (
        <AgentProfileEditor
          profile={editingProfile}
          onSave={handleSaveProfile}
          onClose={() => setEditingProfile(undefined)}
        />
      )}

      {/* Topic selector before opening assign panel */}
      {assigningProfile && !assignTopicId && (
        <div className={MODAL_OVERLAY}>
          <div className={`w-[320px] flex flex-col ${MODAL_PANEL}`}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
              <span className="text-lg">{assigningProfile.avatarEmoji}</span>
              <span className="text-[13px] font-semibold text-app-text flex-1">Assign {assigningProfile.name}</span>
              <button
                onClick={() => setAssigningProfile(null)}
                className="text-app-text-muted hover:text-app-text text-[13px]"
              >
                &times;
              </button>
            </div>
            <div className="px-4 py-3">
              <label className="text-[11px] text-app-text-muted uppercase tracking-wider block mb-1">Topic ID</label>
              <form onSubmit={e => { e.preventDefault(); const input = (e.target as HTMLFormElement).elements.namedItem('topicInput') as HTMLInputElement; if (input.value.trim()) setAssignTopicId(input.value.trim()); }}>
                <input
                  name="topicInput"
                  type="text"
                  placeholder="Enter topic ID..."
                  className="w-full text-xs bg-app-hover border border-app-border rounded px-2 py-1.5 text-app-text placeholder:text-app-text-tertiary focus:outline-none focus:border-primary/50 mb-2"
                  autoFocus
                />
                <button
                  type="submit"
                  className="w-full text-[11px] px-3 py-1.5 rounded bg-primary text-white hover:bg-primary/90 transition-colors"
                >
                  Continue
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Agent assign panel (its own modal) */}
      {assigningProfile && assignTopicId && (
        <AgentAssignPanel
          topicId={assignTopicId}
          topicName={assignTopicId}
          onClose={() => { setAssigningProfile(null); setAssignTopicId(''); }}
        />
      )}

      {/* Session history modal */}
      {viewingSessions && (
        <div className={MODAL_OVERLAY}>
          <div className={`w-[400px] max-h-[70vh] flex flex-col ${MODAL_PANEL}`}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
              <span className="text-lg">{viewingSessions.avatarEmoji}</span>
              <span className="text-[13px] font-semibold text-app-text flex-1">{viewingSessions.name}</span>
              <button
                onClick={() => setViewingSessions(null)}
                className="text-app-text-muted hover:text-app-text text-[13px]"
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <HeartbeatTimeline
                agentId={viewingSessions.id}
                agentName={viewingSessions.name}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
