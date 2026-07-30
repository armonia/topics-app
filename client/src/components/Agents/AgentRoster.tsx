import { useState, useEffect, useCallback, useRef } from 'react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { AgentProfileCard } from './AgentProfileCard';
import { AgentProfileEditor } from './AgentProfileEditor';
import { AgentAssignPanel } from './AgentAssignPanel';
import { HeartbeatTimeline } from './HeartbeatTimeline';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';
import { useModalDialog } from '../../hooks/useModalDialog';
import type { WSMessage } from '../../types';

type StatusFilter = 'all' | AgentProfile['status'];

export function AgentRoster({ onMessage }: { onMessage?: (handler: (msg: WSMessage) => void) => () => void } = {}) {
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

  // I due modali scritti in linea qui sotto (scelta del topic, storico sessioni)
  // si chiudevano SOLO dalla loro ×: Escape passava oltre e finiva a interrompere
  // il turno dell'AI sotto.
  const topicPickerRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<HTMLDivElement>(null);
  const closeTopicPicker = useCallback(() => setAssigningProfile(null), []);
  const closeSessions = useCallback(() => setViewingSessions(null), []);
  useModalDialog({
    open: !!assigningProfile && !assignTopicId,
    onClose: closeTopicPicker,
    panelRef: topicPickerRef,
  });
  useModalDialog({ open: !!viewingSessions, onClose: closeSessions, panelRef: sessionsRef });

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

  // Il roster caricava UNA volta al mount e mai più: due finestre sullo stesso
  // progetto, modifichi un agente in una, l'altra restava indietro finché non
  // veniva rimontata. Il server annunciava già `agent:profile:created/updated/
  // deleted` — nessuno li ascoltava.
  //
  // Si applica il payload invece di rifare la GET: l'evento porta il profilo
  // intero, che il server ha già costruito.
  //
  // `agent:assigned` / `agent:unassigned` restano fuori di proposito: la card
  // non mostra le assegnazioni, quindi qui non c'è niente da aggiornare — e
  // `AgentAssignPanel`, che le mostra, ricarica già dopo la propria azione.
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      const m = msg as { type?: string; profile?: AgentProfile; profileId?: string };
      if (m.type === 'agent:profile:created' && m.profile) {
        const p = m.profile;
        setProfiles((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
      } else if (m.type === 'agent:profile:updated' && m.profile) {
        const p = m.profile;
        setProfiles((prev) => prev.map((x) => (x.id === p.id ? p : x)));
      } else if (m.type === 'agent:profile:deleted' && m.profileId) {
        const id = m.profileId;
        setProfiles((prev) => prev.filter((x) => x.id !== id));
      }
    });
  }, [onMessage]);

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
        <div className={MODAL_OVERLAY} onClick={closeTopicPicker}>
          <div
            ref={topicPickerRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Assign ${assigningProfile.name}`}
            onClick={e => e.stopPropagation()}
            className={`w-[320px] flex flex-col ${MODAL_PANEL}`}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
              <span className="text-lg">{assigningProfile.avatarEmoji}</span>
              <span className="text-[13px] font-semibold text-app-text flex-1">Assign {assigningProfile.name}</span>
              <button
                onClick={closeTopicPicker}
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
        <div className={MODAL_OVERLAY} onClick={closeSessions}>
          <div
            ref={sessionsRef}
            role="dialog"
            aria-modal="true"
            aria-label={viewingSessions.name}
            onClick={e => e.stopPropagation()}
            className={`w-[400px] max-h-[70vh] flex flex-col ${MODAL_PANEL}`}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
              <span className="text-lg">{viewingSessions.avatarEmoji}</span>
              <span className="text-[13px] font-semibold text-app-text flex-1">{viewingSessions.name}</span>
              <button
                onClick={closeSessions}
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
