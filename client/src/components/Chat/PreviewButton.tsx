/**
 * Starts the live preview of a chat that works in its own worktree.
 *
 * The server answers 202 at once and reports the outcome (link and shot, or why
 * it did not start) as a service message in this same chat, so the button only
 * has to ask. It is not drawn for a chat without a worktree (the live checkout
 * already is the preview) nor for an archived one.
 */
import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { CHAT_STRIP, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import { useToast } from '../Shared/Toast';
import type { Topic } from '../../types';

interface PreviewButtonProps {
  topic: Pick<Topic, 'id' | 'worktreeId' | 'archived'>;
}

export function PreviewButton({ topic }: PreviewButtonProps) {
  const tr = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!topic.worktreeId || topic.archived) return null;

  const start = async () => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/topics/${encodeURIComponent(topic.id)}/preview`, { method: 'POST' });
      if (!res.ok) toast.error(tr('chat.preview.failed'));
    } catch {
      toast.error(tr('chat.preview.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="chat-preview-strip" className={`${CHAT_STRIP} border border-app-border/60 bg-app-hover/40`}>
      <button
        type="button"
        data-testid="chat-preview-button"
        disabled={busy}
        onClick={() => { void start(); }}
        title={tr('chat.preview.title')}
        className={`${CHAT_STRIP_ROW} disabled:opacity-60`}
      >
        {busy
          ? <Loader2 size={13} className="flex-shrink-0 animate-spin text-app-text-secondary" />
          : <Eye size={13} className="flex-shrink-0 text-app-text-secondary" />}
        <span className="text-mini font-medium text-app-text-secondary">{tr('chat.preview.button')}</span>
      </button>
    </div>
  );
}
