/**
 * AgentsBoardSection — kanban view of all active sessions, at the top of the
 * global board (AllBoardsPane). interactive-claude-primitive.
 *
 * Columns by status (Ti aspetta / In lavoro / Concluse); each session is a card
 * with its state, a short preview, and the recommended action. FREE by design:
 * reads session state (getSessions) — no model call. Autopilot only auto-runs
 * SAFE closures (concluded/idle/empty); never the model, never the Master.
 * Deep reasoning is delegated to the on-demand Claude Code Master.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Circle, MessageSquareDot, X, Bot } from 'lucide-react';
import { masterApi, type MasterSession, type MasterSessionState } from '../../lib/api';
import { recommendSessionAction, selectAutopilotClosures, type BoardSession } from '../../state/agentBoard';
import type { WSMessage } from '../../types';

const AUTOPILOT_KEY = 'topics:agents-board:autopilot';
const REFRESH_EVENTS = new Set([
  'task:created', 'task:updated', 'message:new', 'stream:end',
  'session:state', 'terminal:activity', 'terminal:sessions', 'unread:updated',
]);

function toBoard(s: MasterSession): BoardSession {
  return { topicId: s.topicId, name: s.name, sessionType: s.sessionType, state: s.state, unread: s.unread, lastAt: s.lastAt };
}
function isTerminal(s: MasterSession): boolean {
  return s.sessionType === 'claude-code-terminal' || s.topicId.startsWith('terminal:');
}
function closeUrl(s: MasterSession): string {
  return isTerminal(s)
    ? `/api/terminal/sessions/${s.topicId.replace(/^terminal:/, '')}`
    : `/api/topics/${s.topicId}`;
}
function StateDot({ state }: { state: MasterSessionState }) {
  if (state === 'streaming') return <Loader2 size={12} className="text-yellow-300 animate-spin flex-shrink-0" />;
  if (state === 'update') return <MessageSquareDot size={12} className="text-emerald-300 flex-shrink-0" />;
  if (state === 'waiting') return <Circle size={8} className="text-blue-300 fill-blue-300 flex-shrink-0" />;
  return <Circle size={8} className="text-app-text-muted/40 fill-app-text-muted/40 flex-shrink-0" />;
}

type ColKey = 'attend' | 'work' | 'done';
const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'attend', label: 'Ti aspetta' },
  { key: 'work', label: 'In lavoro' },
  { key: 'done', label: 'Concluse' },
];

function columnOf(s: MasterSession): ColKey {
  if (s.state === 'streaming' || s.state === 'waiting') return 'work';
  return recommendSessionAction(toBoard(s)).action === 'open' ? 'attend' : 'done';
}

interface Props {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onJumpToTopic?: (topicId: string) => void;
}

export function AgentsBoardSection({ onMessage, onJumpToTopic }: Props) {
  const [sessions, setSessions] = useState<MasterSession[]>([]);
  const [autopilot, setAutopilot] = useState<boolean>(() => {
    try { return localStorage.getItem(AUTOPILOT_KEY) === '1'; } catch { return false; }
  });
  const autopilotRef = useRef(autopilot);
  autopilotRef.current = autopilot;
  const closingRef = useRef<Set<string>>(new Set());

  const closeSession = useCallback(async (s: MasterSession) => {
    if (closingRef.current.has(s.topicId)) return;
    closingRef.current.add(s.topicId);
    try { await fetch(closeUrl(s), { method: 'DELETE' }); } catch { /* ignore */ }
    setSessions((prev) => prev.filter((x) => x.topicId !== s.topicId));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { sessions: next } = await masterApi.getSessions();
      setSessions(next);
      if (autopilotRef.current) {
        const candidates = next.filter((s) => s.name !== 'Master');
        const byId = new Map(next.map((s) => [s.topicId, s]));
        for (const c of selectAutopilotClosures(candidates.map(toBoard))) {
          const full = byId.get(c.topicId);
          if (full) void closeSession(full);
        }
      }
    } catch { /* ignore */ }
  }, [closeSession]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = onMessage((msg: WSMessage) => {
      if (!REFRESH_EVENTS.has(msg.type)) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { void refresh(); }, 400);
    });
    return () => { if (t) clearTimeout(t); unsub?.(); };
  }, [onMessage, refresh]);

  const toggleAutopilot = () => {
    setAutopilot((v) => {
      const next = !v;
      try { localStorage.setItem(AUTOPILOT_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      if (next) void refresh();
      return next;
    });
  };

  const grouped: Record<ColKey, MasterSession[]> = { attend: [], work: [], done: [] };
  for (const s of sessions) grouped[columnOf(s)].push(s);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Bot size={13} className="text-app-text-muted flex-shrink-0" />
        <span className="text-[12px] font-medium text-app-text">Agenti</span>
        <span className="text-[11px] text-app-text-muted tabular-nums">{sessions.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          data-testid="agents-autopilot-toggle"
          onClick={toggleAutopilot}
          aria-pressed={autopilot}
          title={autopilot
            ? 'Autopilot ON — chiude da solo le sessioni concluse e inattive (azione meccanica, gratis). Clic per spegnere.'
            : 'Autopilot OFF — clic per far chiudere automaticamente le sessioni concluse (solo azioni sicure, niente modello).'}
          className={`flex items-center gap-1 px-1.5 py-[2px] rounded text-[11px] transition-colors ${
            autopilot ? 'bg-emerald-500/20 text-emerald-300' : 'bg-app-bg/50 text-app-text-muted hover:text-app-text'
          }`}
        >
          <Circle size={7} className={autopilot ? 'fill-emerald-400 text-emerald-400' : 'fill-app-text-muted/40 text-app-text-muted/40'} />
          Autopilot
        </button>
      </div>

      {/* Kanban columns by status */}
      <div className="flex-1 min-h-0 flex gap-2 px-2 pb-2 overflow-x-auto">
        {COLUMNS.map((col) => (
          <div key={col.key} className="flex-1 min-w-[150px] flex flex-col">
            <div className="flex items-center gap-1.5 px-1 pb-1 sticky top-0">
              <span className="text-[11px] font-medium text-app-text-muted uppercase tracking-wide">{col.label}</span>
              <span className="text-[10px] text-app-text-muted/60 tabular-nums">{grouped[col.key].length}</span>
            </div>
            <div className="flex flex-col gap-1 overflow-y-auto">
              {grouped[col.key].map((s) => {
                return (
                  <div
                    key={s.topicId}
                    role="button"
                    tabIndex={0}
                    onClick={() => onJumpToTopic?.(s.topicId)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onJumpToTopic?.(s.topicId); }}
                    className="group relative rounded border border-app-border/50 bg-surface px-1.5 py-1 cursor-pointer hover:border-primary/30 transition-colors"
                    title={s.lastPreview || s.name}
                  >
                    <div className="flex items-center gap-1.5">
                      <StateDot state={s.state} />
                      <span className="flex-1 min-w-0 truncate text-[12px] text-app-text">{s.name}</span>
                      {col.key === 'done' && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void closeSession(s); }}
                          title="Chiudi sessione"
                          className="flex-shrink-0 text-app-text-muted/50 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                    {s.lastPreview && (
                      <div className="mt-0.5 pl-[18px] text-[10px] text-app-text-muted/70 truncate">{s.lastPreview}</div>
                    )}
                  </div>
                );
              })}
              {grouped[col.key].length === 0 && (
                <div className="px-1 py-1 text-[10px] text-app-text-muted/40">—</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
