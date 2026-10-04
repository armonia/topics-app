/**
 * Where a PLAIN row of the changed-files strip opens: one the topic's changeset
 * does not hold (a file outside the repository, past `MAX_GIT_PATHS`, a write
 * outside the task's range). The rows of the changeset open in the strip's own
 * diff (`ChangedFilesStrip`); these open the editor's diff in the tree the
 * route read, or the file itself outside a repository.
 *
 * Pure on purpose, like `changesStripBranch`: the cases are pinned in the
 * co-located test.
 */
import type { TopicChanges } from '../../../shared/topic-changes';

export type ChangedFileOpen =
  | { kind: 'diff'; filePath: string; projectPath: string }
  | { kind: 'file'; path: string };

/** `projectPath` is the topic's folder, the fallback when git gave no root. `null` = nowhere to open it. */
export function changedFileOpen(changes: TopicChanges | null, path: string, projectPath: string): ChangedFileOpen | null {
  const root = changes?.git?.root ?? projectPath;
  if (!root) return null;
  return changes?.git ? { kind: 'diff', filePath: path, projectPath: root } : { kind: 'file', path };
}
