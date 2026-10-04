/**
 * What this conversation touched, without leaving the conversation.
 *
 * A turn that writes files leaves its trace scattered through the transcript,
 * one `write`/`edit` row at a time: to see the whole of it you scrolled back,
 * or you opened a terminal and ran `git status`, which answers a wider
 * question (everything dirty in the repo, whoever did it). The chip counts the
 * files THIS topic wrote and opens its changeset (`useTopicChangeSet`) with the
 * board's own panel, `UnifiedDiff`: a row expands in place into its diff, the
 * Before/After of a picture, the rendered page or the whole file, read-only.
 * On a card's topic the changeset is the card's range, the drawer's, and a link
 * opens the drawer on the file, where review notes are written. The rows the
 * changeset does not hold (a file outside the repository, a write outside the
 * card's range) stay plain rows under the diff and open in the editor.
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
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, FileDiff, GitBranch } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useTopicChanges } from '../../hooks/useTopicChanges';
import { useTopicChangeSet } from '../../hooks/useTopicChangeSet';
import { ChangedFileList } from '../Git/ChangedFileList';
import { rowFromTopicChange, type ChangedFileRow } from '../Git/changedFiles';
import { diffFocusFor } from '../Board/constants';
import { branchLabelFor } from '../../lib/changesStripBranch';
import { openTaskInApp } from '../../lib/openTaskLink';
import { changedFileOpen } from '../../lib/changesStripOpen';
import { CHAT_STRIP_NEUTRAL, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';
import type { DiffPanelSource } from '../../lib/board';
import { DockedStripPanel } from './DockedStripPanel';
import type { Topic, WSMessage } from '../../types';

// The board's diff panel is fetched when a strip opens, not with the chat: every
// chat mounts this strip, and few of them ever open it.
const UnifiedDiff = lazy(async () => {
  const { UnifiedDiff: panel } = await import('../Board/UnifiedDiff');
  return { default: panel };
});

interface ChangedFilesStripProps {
  /** Id for the endpoint, folder to open a diff in, worktree binding for the branch. */
  topic: Pick<Topic, 'id' | 'projectPath' | 'worktreeId'>;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export function ChangedFilesStrip({ topic, onWSMessage }: ChangedFilesStripProps) {
  const tr = useT();
  const changes = useTopicChanges(topic.id, onWSMessage);
  const [open, setOpen] = useState(false);

  const { changeSet, reload } = useTopicChangeSet(topic.id, open, changes);
  // The file last opened in the diff: where the link to the card lands.
  const [opened, setOpened] = useState<string | null>(null);

  const files = changes?.files;
  const projectPath = topic.projectPath ?? '';
  const branch = branchLabelFor(topic, changes?.git ?? null);
  // The strip speaks the wire shape of `/topics/:id/changes`; the list speaks
  // the one shape every surface draws (`Git/changedFiles`).
  const rows = useMemo(() => files?.map(rowFromTopicChange) ?? [], [files]);
  // What the diff does not draw stays a plain row. A changeset that could not
  // be read leaves every row plain, as the strip was before it had one.
  const plainRows = useMemo(() => {
    if (!changeSet) return rows;
    const drawn = new Set(changeSet.stat.map((f) => f.path));
    return rows.filter((r) => !drawn.has(r.path));
  }, [rows, changeSet]);
  const source = useMemo<DiffPanelSource>(() => ({ kind: 'topic', topicId: topic.id }), [topic.id]);
  const taskId = changes?.taskId;
  const cardFocus = opened ?? changeSet?.stat[0]?.path ?? null;

  const openPlain = useCallback((file: ChangedFileRow) => {
    const target = changedFileOpen(changes, file.path, projectPath);
    if (!target) return;
    // Same bus the project's git panel uses (`components/Project/GitChanges`):
    // the diff opens as a pane in the editor, deduplicated by file path.
    window.dispatchEvent(target.kind === 'diff'
      ? new CustomEvent('open-file-diff', { detail: { filePath: target.filePath, projectPath: target.projectPath } })
      : new CustomEvent('open-file', { detail: { path: target.path } }));
  }, [changes, projectPath]);

  if (!rows.length) return null;

  return (
    <div data-testid="chat-changes-strip" className={CHAT_STRIP_NEUTRAL}>
      {/* Above the header, in the strip's flow: see `DockedStripPanel`. */}
      <DockedStripPanel open={open} testId="chat-changes-panel" className="max-h-[60vh] space-y-1.5 overflow-y-auto px-2.5 py-1.5">
        {taskId && (
          <button
            type="button"
            data-testid="chat-changes-open-card"
            onClick={() => openTaskInApp({ taskId }, cardFocus ? diffFocusFor(cardFocus) : undefined)}
            // A real box and not `.tap-expand`: the diff sits 6px below, and a
            // projected 44 would take its first file's header under a finger.
            className="flex min-h-6 items-center gap-1 rounded px-1 py-0.5 text-mini text-indigo-700 coarse:min-h-11 hover:bg-indigo-500/10 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
          >
            <ExternalLink size={12} className="flex-shrink-0" />
            {tr('chat.changes.openInCard')}
          </button>
        )}
        {changeSet === undefined && <ChangedFileList testId="chat-changes-loading" rows={null} loading />}
        {changeSet && changeSet.stat.length > 0 && (
          <div data-testid="chat-changes-diff">
            <Suspense fallback={<ChangedFileList rows={null} loading />}>
              <UnifiedDiff bundle={changeSet} source={source} onStale={reload} onFileOpened={setOpened} />
            </Suspense>
          </div>
        )}
        {changeSet !== undefined && plainRows.length > 0 && (
          <div>
            {changeSet && changeSet.stat.length > 0 && (
              <div className="px-1 pb-0.5 text-mini text-app-text-muted">{tr('chat.changes.outside')}</div>
            )}
            <ChangedFileList testId="chat-changes-list" rows={plainRows} onOpen={openPlain} />
          </div>
        )}
      </DockedStripPanel>
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
          className={`flex-shrink-0 text-app-text-muted transition-transform ${open ? '-rotate-90' : ''}`}
        />
        <FileDiff size={13} className="flex-shrink-0 text-app-text-secondary" />
        <span className="flex-shrink-0 text-mini font-medium tabular-nums text-app-text-secondary">
          {tr('chat.changes.chip', { n: String(rows.length) })}
        </span>
        {branch && (
          <span
            data-testid="chat-changes-branch"
            className="flex min-w-0 items-center gap-1 text-mini text-app-text-muted"
            title={changes?.git?.root}
          >
            <GitBranch size={12} className="flex-shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
      </button>
    </div>
  );
}
