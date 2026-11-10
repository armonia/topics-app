import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { stripMarkdown } from '../../lib/stripMarkdown';

/**
 * A machine's note, folded under the «show» toggle. It is never the card's body on its
 * own: the body carries the agent's word, and the note waits one click away.
 */
export function SystemNoteFold({ note }: { note: { content: string } }) {
  const tr = useT();
  const [aperta, setAperta] = useState(false);
  return (
    <div>
      <button
        data-testid="card-system-note-toggle"
        onClick={(e) => { e.stopPropagation(); setAperta((v) => !v); }}
        className="inline-flex min-h-[24px] min-w-[24px] items-center coarse:min-h-[44px] coarse:min-w-[44px] text-compact leading-4 md:text-mini text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
      >
        {aperta ? tr('board.card.commentLess') : tr('board.card.noteShow')}
      </button>
      {aperta && (
        <p data-testid="card-system-note" className="mt-1 break-words text-compact leading-snug text-app-text-muted">
          <Terminal className="mr-1 inline h-2.5 w-2.5 align-middle" />{tr('board.card.systemNote')}: {stripMarkdown(note.content)}
        </p>
      )}
    </div>
  );
}
