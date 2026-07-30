/**
 * ExternalSessionsBadge — "questo progetto è vivo anche senza card".
 *
 * The board is how a human (and the master agent) judges a project's state, and
 * it only knows the sessions Topics started. A repo with three bare `claude`
 * sessions in a terminal and zero tasks therefore reads as idle while it's the
 * busiest thing on the machine. This chip is the missing half: a READ-ONLY
 * count of the sessions running outside the kanban, with a popover naming the
 * directory, the branch and the last activity of each.
 *
 * Renders nothing when there's nothing outside — zero chrome for the common case.
 */
import { useRef, useState } from 'react';
import { TerminalSquare, ArrowRightToLine } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { fmtUpdatedAt } from './format';
import { topicsApi } from '../../lib/api';
import type { ExternalSession } from '../../hooks/useExternalSessions';

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export function ExternalSessionsBadge({ sessions, showProject, onOpenTopic }: {
  sessions: ExternalSession[];
  /** Global board: name the project too (the chip spans many). */
  showProject?: boolean;
  /** Adopt a session into a topic, then focus it. Omit to hide the action. */
  onOpenTopic?: (topicId: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  // Bring a bare terminal session INTO Topics: bind it to a new topic (next turn
  // resumes the same CLI conversation) and replay its history into the chat.
  const adopt = async (s: ExternalSession) => {
    if (!onOpenTopic || adopting) return;
    setAdopting(s.sessionId);
    try {
      const topic = await topicsApi.adoptClaudeSession(s.sessionId, basename(s.cwd));
      setOpen(false);
      onOpenTopic(topic.id);
    } catch (err) {
      console.warn('[ExternalSessionsBadge] adopt failed', err);
    } finally {
      setAdopting(null);
    }
  };

  const active = sessions.filter((s) => s.state === 'active').length;
  // Amber = somebody is typing in that repo right now; grey = only recent traces.
  const tone = active > 0 ? 'text-amber-300/90 hover:bg-amber-400/10' : 'text-neutral-500 hover:bg-white/5';

  return (
    <>
      <button
        ref={btnRef}
        data-testid="external-sessions-badge"
        onClick={() => setOpen((o) => !o)}
        title={`${sessions.length} sessioni Claude fuori dalla kanban${active ? ` — ${active} attive ora` : ''}`}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${tone}`}
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        <span>{active > 0 ? active : sessions.length}</span>
        <span className="hidden sm:inline">fuori kanban</span>
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={300}>
        <div className="px-3 py-2.5 text-xs text-neutral-300">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Sessioni fuori dalla kanban</p>
          <p className="mt-1 text-[11px] leading-snug text-neutral-500">
            Claude avviato a mano (terminale, altro tool). Topics le vede, non le governa.
          </p>
          <ul className="mt-2 space-y-1.5">
            {sessions.slice(0, 12).map((s) => (
              <li key={s.sessionId} className="flex items-start gap-2 border-t border-white/5 pt-1.5 first:border-0 first:pt-0">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${s.state === 'active' ? 'bg-amber-400' : 'bg-neutral-600'}`}
                  title={s.state === 'active' ? 'attiva ora' : 'inattiva da un po’'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-neutral-200" title={s.cwd}>
                    {showProject && s.projectPath ? `${basename(s.projectPath)} · ` : ''}{basename(s.cwd)}
                  </span>
                  <span className="block truncate text-[10px] text-neutral-500">
                    {s.branch ? `${s.branch} · ` : ''}{fmtUpdatedAt(new Date(s.lastActivityMs).toISOString())}
                  </span>
                </span>
                {onOpenTopic && (
                  <button
                    data-testid="adopt-external-session"
                    onClick={() => adopt(s)}
                    disabled={adopting !== null}
                    title="Continua questa sessione in una topic"
                    className="mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-sky-300/90 hover:bg-sky-400/10 disabled:opacity-40"
                  >
                    <ArrowRightToLine className="h-3 w-3" />
                    <span>{adopting === s.sessionId ? '…' : 'Continua qui'}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {sessions.length > 12 && (
            <p className="mt-1.5 text-[10px] text-neutral-600">…e altre {sessions.length - 12}.</p>
          )}
        </div>
      </Menu>
    </>
  );
}
