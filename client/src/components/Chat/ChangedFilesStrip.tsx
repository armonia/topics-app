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
import { useCallback, useState } from 'react';
import { ChevronRight, FileDiff, GitBranch } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { splitPath, useTopicChanges } from '../../hooks/useTopicChanges';
import { branchLabelFor } from '../../lib/changesStripBranch';
import { CHAT_STRIP_NEUTRAL, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import type { Topic, WSMessage } from '../../types';
import type { TopicChangedFile } from '../../../../shared/topic-changes';

interface ChangedFilesStripProps {
  /** Id for the endpoint, folder to open a diff in, worktree binding for the branch. */
  topic: Pick<Topic, 'id' | 'projectPath' | 'worktreeId'>;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

/** The one letter that says what happened, and the colour that says it faster. */
const KIND_MARK: Record<TopicChangedFile['kind'], { letter: string; tone: string }> = {
  created: { letter: 'A', tone: 'text-emerald-500' },
  modified: { letter: 'M', tone: 'text-amber-500' },
  deleted: { letter: 'D', tone: 'text-red-500' },
};

export function ChangedFilesStrip({ topic, onWSMessage }: ChangedFilesStripProps) {
  const tr = useT();
  const changes = useTopicChanges(topic.id, onWSMessage);
  const [open, setOpen] = useState(false);

  const files = changes?.files ?? [];
  const root = changes?.git?.root ?? topic.projectPath ?? '';
  const branch = branchLabelFor(topic, changes?.git ?? null);

  const openDiff = useCallback((file: TopicChangedFile) => {
    if (!root) return;
    // Same bus the project's git panel uses (`components/Project/GitChanges`):
    // the diff opens as a pane in the editor, deduplicated by file path.
    const event = changes?.git ? 'open-file-diff' : 'open-file';
    window.dispatchEvent(new CustomEvent(event, changes?.git
      ? { detail: { filePath: file.path, projectPath: root } }
      : { detail: { path: file.path } }));
  }, [changes, root]);

  if (!files.length) return null;

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
          {tr('chat.changes.chip', { n: String(files.length) })}
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
        <ul data-testid="chat-changes-list" className="max-h-48 overflow-y-auto border-t border-app-border/50 px-2.5 py-1.5">
          {files.map((file) => {
            const { dir, name } = splitPath(file.path);
            const mark = KIND_MARK[file.kind];
            return (
              <li key={file.path}>
                <button
                  type="button"
                  data-testid="chat-changes-row"
                  data-path={file.path}
                  onClick={(e) => { e.stopPropagation(); openDiff(file); }}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-white/5"
                >
                  <span className={`w-3 flex-shrink-0 font-mono ${mark.tone}`}>{mark.letter}</span>
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    <span className="text-app-text-muted">{dir}</span>
                    <span className="text-app-text">{name}</span>
                  </span>
                  {file.binary ? (
                    <span className="flex-shrink-0 text-app-text-muted">{tr('chat.changes.binary')}</span>
                  ) : (
                    <>
                      {file.added !== undefined && file.added > 0 && (
                        <span className="flex-shrink-0 font-mono text-emerald-500">+{file.added}</span>
                      )}
                      {file.removed !== undefined && file.removed > 0 && (
                        <span className="flex-shrink-0 font-mono text-red-500">-{file.removed}</span>
                      )}
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
