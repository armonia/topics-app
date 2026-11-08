/**
 * The hunks of one file, read by whoever mounts `HunkActions` and handed to it
 * as `seed` (see there): `FilePane` reads them together with the diff so the
 * text and the hunk strip land in one commit.
 */
import { gitApi } from '../../lib/api';
import type { GitHunkSummary } from '../../types';

export type HunkSeed = { side: 'staged' | 'unstaged'; hunks: GitHunkSummary[] };

/**
 * The hunks on the side there is something to act on: outside the index first
 * (the common case), inside it when outside is empty, or the side the caller
 * names. Never throws: a failed read is an empty list, as in `HunkActions`.
 */
export async function fetchHunks(projectPath: string, file: string, side?: 'staged' | 'unstaged'): Promise<HunkSeed> {
  try {
    if (side) return { side, hunks: (await gitApi.hunks(projectPath, file, side)).hunks };
    const outside = await gitApi.hunks(projectPath, file, 'unstaged');
    if (outside.hunks.length > 0) return { side: 'unstaged', hunks: outside.hunks };
    return { side: 'staged', hunks: (await gitApi.hunks(projectPath, file, 'staged')).hunks };
  } catch {
    return { side: side ?? 'unstaged', hunks: [] };
  }
}
