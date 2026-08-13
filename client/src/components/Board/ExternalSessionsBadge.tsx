/**
 * ExternalSessionsBadge — "questo progetto è vivo anche senza card".
 *
 * The board is how a human (and the master agent) judges a project's state, and
 * it only knows the sessions Topics started. A repo with three bare `claude`
 * sessions in a terminal and zero tasks therefore reads as idle while it's the
 * busiest thing on the machine. This chip is the missing half: a count of the
 * sessions running outside the kanban, with a popover naming the directory, the
 * branch and the last activity of each — and, on each row, the one thing you
 * can actually DO with them: «Continua qui», che le adotta in una topic.
 *
 * L'etichetta dice DOVE stanno, non dove non stanno. Diceva «fuori kanban», e
 * per definizione ciò che è fuori dalla kanban è tutto il resto del mondo: non
 * si capiva né cosa fossero né perché fossero in quella barra («non ne capisco
 * l'utilità», Attilio 13/08). «In terminale» dice la cosa vera, e il popover
 * apre con quello che il chip serve a fare invece che con la sua definizione.
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
  const tone = active > 0 ? 'text-amber-300/90 hover:bg-amber-400/10' : 'text-app-text-muted hover:bg-white/5';

  return (
    <>
      <button
        ref={btnRef}
        data-testid="external-sessions-badge"
        onClick={() => setOpen((o) => !o)}
        title={`${sessions.length} sessioni Claude avviate a mano in un terminale${active ? ` · ${active} attive ora` : ''}. Aprile per riprenderne una dentro una topic.`}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${tone}`}
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        <span>{active > 0 ? active : sessions.length}</span>
        <span className="hidden sm:inline">in terminale</span>
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={300}>
        <div className="px-3 py-2.5 text-xs text-app-text-heading">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">Sessioni fuori dalla kanban</p>
          {/* Prima qui c'era la definizione («Topics le vede, non le governa»),
              cioè un fatto che non chiede niente a chi legge. Adesso c'è quello
              che il pannello serve a fare: la riga sotto ognuna è un bottone. */}
          <p className="mt-1 text-[11px] leading-snug text-app-text-muted">
            Claude avviato a mano in un terminale. «Continua qui» ne riprende una dentro una topic: la stessa conversazione, non una nuova.
          </p>
          <ul className="mt-2 space-y-1.5">
            {sessions.slice(0, 12).map((s) => (
              <li key={s.sessionId} className="flex items-start gap-2 border-t border-app-border-subtle pt-1.5 first:border-0 first:pt-0">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${s.state === 'active' ? 'bg-amber-400' : 'bg-app-text-faint'}`}
                  title={s.state === 'active' ? 'attiva ora' : 'inattiva da un po’'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-app-text" title={s.cwd}>
                    {showProject && s.projectPath ? `${basename(s.projectPath)} · ` : ''}{basename(s.cwd)}
                  </span>
                  <span className="block truncate text-[10px] text-app-text-muted">
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
            <p className="mt-1.5 text-[10px] text-app-text-faint">…e altre {sessions.length - 12}.</p>
          )}
        </div>
      </Menu>
    </>
  );
}
