import { useCallback, useEffect, useRef, useState } from 'react';
import { guestMeets, type GuestLevel } from './guestLevel';
import { MessageSquarePlus, Pencil } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { STATUS_LABEL, isProjectlessId } from '../../lib/board';
import type { TaskStatus } from '../../../../shared/board';

/**
 * ONE SHARED CARD, AT THE LEVEL IT WAS SHARED AT.
 *
 * Lives in its own file because it holds the half of the scale the guest side
 * did not have. The server has enforced three levels since the write scope
 * landed - `read`, `comment`, `edit` - while this screen printed "read only"
 * at everybody and offered no way to write: the only POST to a comments
 * endpoint anywhere in the client (`lib/board.ts`) goes to
 * `/boards/:projectId/tasks/:id/comments`, a path `isGuestAllowedPath` does
 * not list, so a guest granted `edit` could not reach the capability from the
 * product at all. Two sentences, one on each side of the same permission,
 * saying opposite things.
 *
 * The two writes here are exactly the two the gate opens
 * (`GUEST_WRITE_ROUTES`): `POST /api/tasks/:id/comments` and
 * `PATCH /api/tasks/:id`. Nothing else is offered, at any level - starting a
 * run, approving, publishing are not steps on this scale.
 */

export interface SharedTask {
  id: string;
  text: string;
  status: string;
  project_id: string | null;
  preview_image: string | null;
  /** What this guest may do here. Absent from an older server: `read`, the
   *  least power, which is what that server enforced anyway. */
  level?: GuestLevel;
}

interface ThreadComment {
  id: string;
  author: string;
  content: string;
  createdAt: string;
  kind?: string;
}

export function GuestCard({ task, onChanged }: {
  task: SharedTask;
  /** The inventory is the single source for the card list: after a write the
   *  parent refetches it rather than this card patching a copy of the row. */
  onChanged: () => void;
}) {
  const tr = useT();
  const level: GuestLevel = task.level ?? 'read';
  const [thread, setThread] = useState<ThreadComment[] | null>(null);
  const [comment, setComment] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const readThread = useCallback(async () => {
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json() as { comments?: ThreadComment[] };
      // `status` entries are the board's own transition log, not somebody
      // talking: showing them to a guest would be showing our internals.
      setThread((b.comments ?? []).filter((c) => (c.kind ?? 'comment') === 'comment'));
    } catch { /* the list stays as it was: a failed read is not an empty thread */ }
  }, [task.id]);

  useEffect(() => { if (guestMeets(level, 'comment')) void readThread(); }, [level, readThread]);

  useEffect(() => { if (draft !== null) areaRef.current?.focus(); }, [draft]);

  const send = async () => {
    const content = comment.trim();
    if (!content || busy) return;
    setBusy(true); setFailed(false);
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content }),
      });
      if (!r.ok) { setFailed(true); return; }
      setComment('');
      await readThread();
      onChanged();
    } catch { setFailed(true); } finally { setBusy(false); }
  };

  const saveText = async () => {
    const text = (draft ?? '').trim();
    if (!text || busy) return;
    if (text === task.text) { setDraft(null); return; }
    setBusy(true); setFailed(false);
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      });
      if (!r.ok) { setFailed(true); return; }
      setDraft(null);
      onChanged();
    } catch { setFailed(true); } finally { setBusy(false); }
  };

  return (
    <li className="rounded-lg border border-app-border px-3 py-2.5" data-testid="guest-card">
      {draft !== null ? (
        <div className="space-y-1.5">
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={tr('guest.editText')}
            data-testid="guest-edit-text"
            rows={3}
            className="w-full resize-y rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-body leading-snug text-app-text outline-none focus:border-primary"
          />
          <div className="flex gap-1.5">
            <button
              disabled={busy}
              onClick={() => void saveText()}
              data-testid="guest-edit-save"
              className="rounded-md bg-primary px-2 py-1 text-mini text-white disabled:opacity-50"
            >
              {tr('common.save')}
            </button>
            <button
              disabled={busy}
              onClick={() => setDraft(null)}
              className="rounded-md border border-app-border px-2 py-1 text-mini text-app-text-secondary disabled:opacity-50"
            >
              {tr('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-body leading-snug text-app-text">{task.text}</div>
          {guestMeets(level, 'edit') && (
            <button
              onClick={() => setDraft(task.text)}
              aria-label={tr('guest.editText')}
              data-testid="guest-edit-open"
              className="flex-shrink-0 rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-app-text"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      )}

      <div className="mt-1 flex items-center gap-2 text-mini text-app-text-muted">
        {/* The guest is the one person here who is NOT a Topics user:
            `in_progress` and a project slug are our internals, and this is the
            only screen where they were printed raw. Same two helpers the board
            card uses. */}
        <span>{STATUS_LABEL[task.status as TaskStatus] ?? task.status}</span>
        {task.project_id && !isProjectlessId(task.project_id) && <span>· {task.project_id}</span>}
        {/* WHAT YOU MAY DO, on the card it applies to. A single line at the
            bottom of the page cannot say it: two cards can be shared at two
            different levels, and the page-wide sentence was wrong for at
            least one of them. */}
        <span data-testid="guest-level" className="ml-auto">{tr(`guest.level.${level}`)}</span>
      </div>

      {task.preview_image && (
        // The preview clears the gate only when it belongs to a granted task:
        // the path is open, the content is not.
        <img
          src={`/media${task.preview_image.replace(/^.*\/\.topics\/media/, '')}`}
          alt=""
          className="mt-2 max-h-64 w-full rounded-md object-contain"
          loading="lazy"
        />
      )}

      {guestMeets(level, 'comment') && (
        <div className="mt-2 border-t border-app-border pt-2">
          {thread && thread.length > 0 && (
            <ul className="mb-2 space-y-1.5" data-testid="guest-thread">
              {thread.map((c) => (
                <li key={c.id} className="text-compact leading-snug text-app-text-secondary">
                  <span className="text-app-text-muted">{c.author}</span> {c.content}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-1.5">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={tr('guest.commentPlaceholder')}
              aria-label={tr('guest.commentPlaceholder')}
              data-testid="guest-comment-input"
              rows={2}
              className="min-w-0 flex-1 resize-y rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-compact text-app-text outline-none focus:border-primary"
            />
            <button
              disabled={busy || comment.trim().length === 0}
              onClick={() => void send()}
              aria-label={tr('guest.sendComment')}
              data-testid="guest-comment-send"
              className="flex-shrink-0 rounded-md border border-app-border p-1.5 text-app-text-tertiary hover:bg-app-hover hover:text-app-text disabled:opacity-40"
            >
              <MessageSquarePlus size={13} />
            </button>
          </div>
        </div>
      )}

      {failed && <p className="mt-1.5 text-mini text-red-500">{tr('guest.writeFailed')}</p>}
    </li>
  );
}
