/**
 * "WHO IS SPENDING": the five heaviest Claude sessions of the last 24 hours, on
 * the Dashboard's usage section (card 8cb978eb). Read once when the panel
 * opens from `GET /api/usage/top-sessions`. With no transcripts the section is
 * not drawn at all.
 *
 * Actions: "Open" copies the command that resumes the session in its folder;
 * "Write" sends a message into it through the server.
 */
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import type { TopSession, TopSessionsResult } from '../../../../shared/top-sessions';

function openFor(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : `${h}h`;
}

const compactTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function modelName(model: string): string {
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1].toLowerCase() : model;
}

export function TopSessionsSection() {
  const tr = useT();
  const [sessions, setSessions] = useState<TopSession[]>([]);
  const [writing, setWriting] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/usage/top-sessions')
      .then((r) => (r.ok ? (r.json() as Promise<TopSessionsResult>) : null))
      .then((d) => { if (alive && d) setSessions(d.sessions); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (sessions.length === 0) return null;

  const open = (s: TopSession) => {
    void navigator.clipboard?.writeText(`claude --resume ${s.id}`).then(() => setNote(tr('topSessions.copied')), () => {});
  };
  const send = async (s: TopSession) => {
    const res = await apiFetch('/api/usage/top-sessions/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, text }) });
    setNote(res.ok ? tr('topSessions.sent') : tr('topSessions.sendFailed'));
    if (res.ok) { setText(''); setWriting(null); }
  };

  return (
    <div data-testid="top-sessions" className="mb-2 border-b border-app-border pb-2">
      <div className="px-1 pb-1 text-mini font-medium text-app-text">{tr('topSessions.title')}</div>
      {sessions.map((s) => (
        <div key={s.id} data-testid="top-session-row" className="px-1 py-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-app-text" title={s.cwd ?? undefined}>{s.title || s.id.slice(0, 8)}</span>
            {s.dominatesProject && <span data-testid="top-session-badge" className="flex-shrink-0 rounded bg-primary/15 px-1 text-mini text-primary">{tr('topSessions.dominates')}</span>}
            <span className="w-10 flex-shrink-0 text-right tabular-nums text-app-text-secondary">{Math.round(s.weekShare * 100)}%</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-mini text-app-text-faint">
            <span>{tr(`topSessions.origin.${s.origin}`)}</span>
            <span>{modelName(s.model)}</span>
            <span>{tr('topSessions.context', { tokens: compactTokens(s.avgContext) })}</span>
            <span>{tr('topSessions.open', { time: openFor(s.openMs) })}</span>
            <span className="ml-auto flex gap-1">
              <button type="button" data-testid="top-session-open" onClick={() => open(s)} className="rounded px-1 text-app-text-secondary hover:bg-app-hover">{tr('topSessions.openAction')}</button>
              <button type="button" data-testid="top-session-write" onClick={() => setWriting(writing === s.id ? null : s.id)} className="rounded px-1 text-app-text-secondary hover:bg-app-hover">{tr('topSessions.writeAction')}</button>
            </span>
          </div>
          {writing === s.id && (
            <form className="mt-1 flex gap-1" onSubmit={(e) => { e.preventDefault(); void send(s); }}>
              <input data-testid="top-session-input" value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 rounded border border-app-border bg-transparent px-1 text-mini" />
              <button type="submit" disabled={!text.trim()} className="rounded px-1 text-mini text-primary disabled:opacity-40">{tr('topSessions.send')}</button>
            </form>
          )}
        </div>
      ))}
      {note && <div className="px-1 pt-1 text-mini text-app-text-faint">{note}</div>}
    </div>
  );
}
