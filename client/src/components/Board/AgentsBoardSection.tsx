/**
 * AgentsBoardSection — status of all active sessions with a recommended action,
 * an expandable preview, and a (free, mechanical) Autopilot. Lives at the top of
 * the global board (AllBoardsPane). interactive-claude-primitive.
 *
 * FREE by design: it reads session state (getSessions) and previews (terminal
 * buffer / last message) — no model call. Recommendations are heuristic
 * (agentBoard.ts). Autopilot only auto-runs SAFE closures (close concluded/idle
 * or empty sessions); it never invokes the model. Deep reasoning is delegated to
 * the on-demand Claude Code Master (the "Apri Master" button).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Circle, MessageSquareDot, ExternalLink, X, Bot } from 'lucide-react';
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
  if (state === 'streaming') return <Loader2 size={13} className="text-yellow-300 animate-spin flex-shrink-0" />;
  if (state === 'update') return <MessageSquareDot size={13} className="text-emerald-300 flex-shrink-0" />;
  if (state === 'waiting') return <Circle size={9} className="text-blue-300 fill-blue-300 flex-shrink-0" />;
  return <Circle size={9} className="text-app-text-muted/40 fill-app-text-muted/40 flex-shrink-0" />;
}

interface Props {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onJumpToTopic?: (topicId: string) => void;
}

export function AgentsBoardSection({ onMessage, onJumpToTopic }: Props) {
  const [sessions, setSessions] = useState<MasterSession[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, string>>({});
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
      // Autopilot: auto-close only safe closures, never the Master itself.
      if (autopilotRef.current) {
        const candidates = next.filter((s) => s.name !== 'Master');
        const toClose = selectAutopilotClosures(candidates.map(toBoard));
        const byId = new Map(next.map((s) => [s.topicId, s]));
        for (const c of toClose) {
          const full = byId.get(c.topicId);
          if (full) void closeSession(full);
        }
      }
    } catch { /* ignore */ }
  }, [closeSession]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh on relevant WS events (debounced) — free, read-only.
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

  const toggleExpand = async (s: MasterSession) => {
    const id = s.topicId;
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (isTerminal(s) && preview[id] === undefined) {
      try {
        const r = await fetch(`/api/terminal/sessions/${s.topicId.replace(/^terminal:/, '')}/buffer`);
        const body = await r.json().catch(() => ({}));
        const buf = typeof body?.buffer === 'string' ? body.buffer : '';
        setPreview((p) => ({ ...p, [id]: buf.slice(-1200) || '(vuoto)' }));
      } catch {
        setPreview((p) => ({ ...p, [id]: '(non disponibile)' }));
      }
    }
  };

  if (sessions.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-b border-app-border/60 bg-app-bg/30">
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

      <div className="max-h-[28vh] overflow-y-auto pb-1">
        {sessions.map((s) => {
          const rec = recommendSessionAction(toBoard(s));
          const isOpen = expanded === s.topicId;
          return (
            <div key={s.topicId} className="px-2">
              <div className="group flex items-center gap-2 px-1.5 py-1 rounded hover:bg-app-hover">
                <button type="button" onClick={() => void toggleExpand(s)} className="flex-shrink-0 text-app-text-muted/50 hover:text-app-text-muted" title="Anteprima">
                  <ChevronRight size={12} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                </button>
                <StateDot state={s.state} />
                <button type="button" onClick={() => onJumpToTopic?.(s.topicId)} className="flex-1 min-w-0 text-left text-[12px] text-app-text truncate hover:underline" title={s.name}>
                  {s.name}
                </button>
                <span className="text-[11px] text-app-text-muted/70 flex-shrink-0">{rec.reason}</span>
                {rec.action === 'open' && (
                  <button type="button" onClick={() => onJumpToTopic?.(s.topicId)} className="flex-shrink-0 flex items-center gap-1 px-1.5 py-[2px] rounded text-[11px] bg-blue-500/15 text-blue-300 hover:bg-blue-500/30">
                    <ExternalLink size={10} /> Apri
                  </button>
                )}
                {rec.action === 'close' && (
                  <button type="button" onClick={() => void closeSession(s)} className="flex-shrink-0 flex items-center gap-1 px-1.5 py-[2px] rounded text-[11px] bg-app-bg/60 text-app-text-muted hover:bg-red-500/20 hover:text-red-300">
                    <X size={10} /> Chiudi
                  </button>
                )}
              </div>
              {isOpen && (
                <pre className="ml-7 mb-1 mr-2 max-h-40 overflow-auto rounded bg-black/30 px-2 py-1 text-[10px] leading-snug text-app-text-muted whitespace-pre-wrap break-words">
                  {isTerminal(s) ? (preview[s.topicId] ?? '…') : (s.lastPreview || '(nessun messaggio)')}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
