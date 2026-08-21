/**
 * SessionPane — the agent's session for a task, WHOLE, as a pane of the task's
 * workspace tab group.
 *
 * Until now the session existed only as slivers: a collapsed toggle above every
 * thread row holding "the steps that produced this reply". Each one was shut by
 * default and re-shut on every 3s poll, so reading what the agent actually did
 * meant opening a dozen boxes that closed again behind you. The session was in
 * the drawer and still unreadable.
 *
 * Here it is one scrollable read, in the same tab group as the browser tabs,
 * the plan and the attachments — the things you look AT while the thread stays
 * where you write. The comment boundaries are not lost: `sessionPaneRows` keeps
 * them as hairlines between stretches of steps, so where a reply landed is
 * still visible without cutting the session into pieces.
 *
 * The pane exists only when the task has a topic assigned. A task with no
 * session gets no tab at all, rather than an empty one saying so.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Square } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { ChatMarkdown } from '../ChatMarkdown';
import { ReasoningRow } from '../Chat/ReasoningRow';
import { Spinner } from '../Shared/Spinner';
import { COMPACT_MD_CLS } from './constants';
import { fmtLive } from './format';
import { taskActionWord } from './taskActionWords';
import { sessionPaneRows, type SessionBuckets, type SessionMsg } from './sessionBuckets';

/** Live "how long has this been running" ticker (anchored server-side). */
export function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live ticker: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtLive(ms) : '0s'}</>;
}

/**
 * A stretch of agent turns, drawn exactly like the topic chat draws them:
 * thinking through the SAME `ReasoningRow`, then the prose through the same
 * markdown renderer. One definition, because the thread's live preview and the
 * pane must never disagree about what a step looks like.
 */
export function SessionSteps({ msgs }: { msgs: readonly SessionMsg[] }) {
  return (
    <div className="space-y-2">
      {msgs.map((m, i) => (
        <div key={i} className="space-y-1">
          {m.thinking?.trim() && <ReasoningRow content={m.thinking} />}
          {m.content.trim() && (
            <div className="flex gap-1.5 text-xs leading-relaxed">
              <span className="shrink-0 font-semibold text-app-text-muted">⏺</span>
              <div className={`min-w-0 flex-1 text-app-text-heading ${COMPACT_MD_CLS}`}>
                <ChatMarkdown components={{}}>{m.content}</ChatMarkdown>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * "How is it going", in ONE definition used by both surfaces.
 *
 * The thread keeps this row even though the steps left it: the question it
 * answers is asked where you write, not where you read, and a composer with no
 * sign of life above it reads as an agent that stopped. In the thread the
 * preview is a button that brings the session tab forward (`onOpenPane`); in
 * the pane itself there is nowhere to jump to, so it is plain text.
 */
export function SessionLiveRow({ phase, since, stopping, preview, onStop, onOpenPane }: {
  /** Already-translated dispatch phase ("queued…", "starting agent…", …). */
  phase: string;
  /** Start of the current run, when it is actually running: drives the ticker. */
  since?: string | null;
  stopping: boolean;
  preview: string | null;
  onStop: () => void;
  onOpenPane?: () => void;
}) {
  const tr = useT();
  const stopWord = taskActionWord('stop', tr);
  const previewText = preview ? `…${preview}` : null;
  return (
    <div className="space-y-1.5" data-testid="task-session-live">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-2">
          {[0, 150, 300].map((d) => (
            <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400/80" style={{ animationDelay: `${d}ms` }} />
          ))}
          <span className="ml-1.5 text-[11px] text-app-text-secondary">
            {phase}
            {since && <span className="text-app-text-muted"> <Ticker since={since} /></span>}
          </span>
        </div>
        <button
          disabled={stopping} onClick={onStop}
          title={stopWord.title}
          className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
        >{stopping ? <Spinner size="sm" tone="current" /> : <Square className="h-3 w-3 fill-current" />} {stopWord.label}</button>
      </div>
      {previewText && (onOpenPane ? (
        <button
          type="button"
          onClick={onOpenPane}
          data-testid="task-stream-preview"
          title={tr('board.task.openSessionPane')}
          className="line-clamp-2 block w-full rounded-md border border-app-border-subtle bg-white/[0.02] px-2.5 py-1.5 text-left text-[11px] italic leading-snug text-app-text-muted hover:text-app-text-heading"
        >{previewText}</button>
      ) : (
        <p
          data-testid="task-stream-preview"
          title={tr('board.task.streamPreviewTitle')}
          className="line-clamp-2 rounded-md border border-app-border-subtle bg-white/[0.02] px-2.5 py-1.5 text-[11px] italic leading-snug text-app-text-muted"
        >{previewText}</p>
      ))}
    </div>
  );
}

/** The pane body: the live row on top, then the session, scrollable. */
export function SessionPane({ buckets, boundaryIds, live }: {
  buckets: SessionBuckets;
  /** The thread's comment ids in order — the marks are cut against these. */
  boundaryIds: readonly string[];
  /** The running turn, or null when nothing is in flight. */
  live: ReactNode;
}) {
  const tr = useT();
  const rows = useMemo(() => sessionPaneRows(buckets, boundaryIds), [buckets, boundaryIds]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the agent while it talks, but only while the reader is ALREADY at
  // the bottom: scrolling up to re-read something the agent said two minutes
  // ago must not be undone by the next poll. `scrollTop` rather than
  // `scrollIntoView`, which would also scroll every ancestor of the pane.
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="task-session-pane">
      {live && <div className="shrink-0 border-b border-app-border px-3 py-2">{live}</div>}
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {rows.length === 0 ? (
          <p data-testid="task-session-empty" className="text-xs text-app-text-muted">{tr('board.task.sessionEmpty')}</p>
        ) : rows.map((r) => (r.kind === 'mark' ? (
          <div key={`mark-${r.id}`} className="flex items-center gap-2 py-1">
            <span className="h-px flex-1 bg-app-border-subtle" />
            <span className="text-[10px] uppercase tracking-wide text-app-text-faint">{tr('board.task.sessionReplied')}</span>
            <span className="h-px flex-1 bg-app-border-subtle" />
          </div>
        ) : (
          <SessionSteps key={`steps-${r.id}`} msgs={r.msgs} />
        )))}
      </div>
    </div>
  );
}
