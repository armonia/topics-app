/**
 * Where a row of the changed-files strip opens.
 *
 * A row counted on the task's diff range (`inRange`) opens the task's drawer
 * on that file: the editor's diff compares HEAD with the disk, which after a
 * land is empty and in the shared checkout is somebody else's work, while the
 * drawer draws the range the counts came from. Any other row opens the
 * editor's diff in the tree the route read, or the file itself outside a
 * repository.
 *
 * Pure on purpose, like `changesStripBranch`: the cases are pinned in the
 * co-located test, the click in `tests/e2e/chat-changed-files-task-range.spec.ts`.
 */
import { diffFocusFor } from '../components/Board/constants';
import type { TopicChanges } from '../../../shared/topic-changes';

export type ChangedFileOpen =
  | { kind: 'task'; taskId: string; focusPaneId: string }
  | { kind: 'diff'; filePath: string; projectPath: string }
  | { kind: 'file'; path: string };

/** `projectPath` is the topic's folder, the fallback when git gave no root. `null` = nowhere to open it. */
export function changedFileOpen(changes: TopicChanges | null, path: string, projectPath: string): ChangedFileOpen | null {
  const taskId = changes?.taskId;
  if (taskId && changes.files.some((f) => f.path === path && f.inRange)) {
    return { kind: 'task', taskId, focusPaneId: diffFocusFor(path) };
  }
  const root = changes?.git?.root ?? projectPath;
  if (!root) return null;
  return changes?.git ? { kind: 'diff', filePath: path, projectPath: root } : { kind: 'file', path };
}
