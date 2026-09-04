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
 */
import { useCallback, useState } from 'react';
import { FileDiff, Terminal } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { splitPath, useTopicChanges } from '../../hooks/useTopicChanges';
import { buildTerminalSessionBody } from '../../lib/terminalAgents';
import type { WSMessage } from '../../types';
import type { TopicChangedFile } from '../../../../shared/topic-changes';

interface ChangedFilesStripProps {
  topicId: string;
  /** The folder the topic works in, needed to open a diff in the editor pane. */
  projectPath?: string;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

/** The one letter that says what happened, and the colour that says it faster. */
const KIND_MARK: Record<TopicChangedFile['kind'], { letter: string; tone: string }> = {
  created: { letter: 'A', tone: 'text-emerald-500' },
  modified: { letter: 'M', tone: 'text-amber-500' },
  deleted: { letter: 'D', tone: 'text-red-500' },
};

export function ChangedFilesStrip({ topicId, projectPath, onWSMessage }: ChangedFilesStripProps) {
  const tr = useT();
  const changes = useTopicChanges(topicId, onWSMessage);
  const [open, setOpen] = useState(false);

  const files = changes?.files ?? [];
  const root = changes?.git?.root ?? projectPath ?? '';

  const openDiff = useCallback((file: TopicChangedFile) => {
    if (!root) return;
    // Same bus the project's git panel uses (`components/Project/GitChanges`):
    // the diff opens as a pane in the editor, deduplicated by file path.
    const event = changes?.git ? 'open-file-diff' : 'open-file';
    window.dispatchEvent(new CustomEvent(event, changes?.git
      ? { detail: { filePath: file.path, projectPath: root } }
      : { detail: { path: file.path } }));
  }, [changes, root]);

  const openTerminal = useCallback(async () => {
    if (!root) return;
    try {
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTerminalSessionBody('shell', { cwd: root })),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { id: string; name?: string };
      window.dispatchEvent(new CustomEvent('topics:open-terminal-pane', {
        detail: { sessionId: data.id, name: data.name || '' },
      }));
    } catch {
      // Nothing to say: the terminal either opens or it does not.
    }
  }, [root]);

  if (!files.length) return null;

  return (
    <div data-testid="chat-changes-strip" className="chat-measure flex-shrink-0 border-b border-app-border">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          data-testid="chat-changes-chip"
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          title={tr('chat.changes.chipTitle')}
          className="flex items-center gap-1.5 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-heading hover:bg-white/10"
        >
          <FileDiff size={12} className="flex-shrink-0 text-app-text-secondary" />
          {tr('chat.changes.chip', { n: String(files.length) })}
        </button>
        {changes?.git && (
          <span className="min-w-0 truncate text-[11px] text-app-text-muted" title={changes.git.root}>
            {changes.git.branch}
          </span>
        )}
        <span className="flex-1" />
        {root && (
          <button
            type="button"
            data-testid="chat-changes-terminal"
            onClick={(e) => { e.stopPropagation(); void openTerminal(); }}
            title={tr('chat.changes.openTerminalTitle')}
            className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-app-text-muted hover:bg-white/10 hover:text-app-text"
          >
            <Terminal size={12} />
            {tr('chat.changes.openTerminal')}
          </button>
        )}
      </div>
      {open && (
        <ul data-testid="chat-changes-list" className="max-h-48 overflow-y-auto px-3 pb-1.5">
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
