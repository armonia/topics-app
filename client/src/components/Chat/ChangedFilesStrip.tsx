/**
 * What this conversation touched, without leaving the conversation.
 *
 * A turn that writes files leaves its trace scattered through the transcript,
 * one `write`/`edit` row at a time: to see the whole of it you scrolled back,
 * or you opened a terminal and ran `git status`, which answers a wider
 * question (everything dirty in the repo, whoever did it). The chip counts the
 * files THIS topic wrote and opens the list; a row opens the file's diff in the
 * editor pane, the same one the project's git panel opens.
 *
 * Silent by construction: a topic that wrote nothing renders nothing, so the
 * chip is a signal and not decoration.
 *
 * WHERE IT HANGS. Above the composer, in the bottom block of `ChatPane`, on the
 * same column and the same geometry as the other strips that sit there
 * (`chatStripStyles`): what the topic touched is read where the next message
 * is written, not in the chrome above the tabs and not inside the transcript.
 *
 * THE BRANCH. Named only for a topic bound to an isolated worktree, where it is
 * the topic's own branch and nothing else on screen says it; in the project's
 * own checkout the sidebar already shows it (`lib/changesStripBranch`).
 */
import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, FileDiff, GitBranch } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTopicChanges } from '../../hooks/useTopicChanges';
import { ChangedFileList } from '../Git/ChangedFileList';
import { rowFromTopicChange, type ChangedFileRow } from '../Git/changedFiles';
import { branchLabelFor } from '../../lib/changesStripBranch';
import { CHAT_STRIP_NEUTRAL, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import type { Topic, WSMessage } from '../../types';

interface ChangedFilesStripProps {
  /** Id for the endpoint, folder to open a diff in, worktree binding for the branch. */
  topic: Pick<Topic, 'id' | 'projectPath' | 'worktreeId'>;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function ChangedFilesStrip({ topic, onWSMessage }: ChangedFilesStripProps) {
  const tr = useT();
  const changes = useTopicChanges(topic.id, onWSMessage);
  const [open, setOpen] = useState(false);

  const files = changes?.files;
  const root = changes?.git?.root ?? topic.projectPath ?? '';
  const branch = branchLabelFor(topic, changes?.git ?? null);
  // The strip speaks the wire shape of `/topics/:id/changes`; the list speaks
  // the one shape every surface draws (`Git/changedFiles`).
  const rows = useMemo(() => files?.map(rowFromTopicChange) ?? [], [files]);

  const openDiff = useCallback((file: ChangedFileRow) => {
    if (!root) return;
    // Same bus the project's git panel uses (`components/Project/GitChanges`):
    // the diff opens as a pane in the editor, deduplicated by file path.
    const event = changes?.git ? 'open-file-diff' : 'open-file';
    window.dispatchEvent(new CustomEvent(event, changes?.git
      ? { detail: { filePath: file.path, projectPath: root } }
      : { detail: { path: file.path } }));
  }, [changes, root]);

  if (!rows.length) return null;

  return (
    <div data-testid="chat-changes-strip" className={CHAT_STRIP_NEUTRAL}>
      <button
        type="button"
        data-testid="chat-changes-chip"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={tr('chat.changes.chipTitle')}
        className={CHAT_STRIP_ROW}
      >
        <ChevronRight
          size={13}
          className={`flex-shrink-0 text-app-text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <FileDiff size={13} className="flex-shrink-0 text-app-text-secondary" />
        <span className="flex-shrink-0 text-[11px] font-medium tabular-nums text-app-text-secondary">
          {tr('chat.changes.chip', { n: String(rows.length) })}
        </span>
        {branch && (
          <span
            data-testid="chat-changes-branch"
            className="flex min-w-0 items-center gap-1 text-[11px] text-app-text-muted"
            title={changes?.git?.root}
          >
            <GitBranch size={12} className="flex-shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-app-border/50 px-2.5 py-1.5">
          <ChangedFileList testId="chat-changes-list" rows={rows} onOpen={openDiff} />
        </div>
      )}
    </div>
  );
}
