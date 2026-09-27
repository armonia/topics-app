/**
 * What the diff panel shows of a changed file besides its lines: which side
 * exists at which revision, and where a picture inside a rendered `.md` is
 * read from.
 *
 * Out of the component because these are the answers that can be wrong without
 * anything looking broken: the Before of a renamed picture read from the new
 * path is a 404 drawn as "preview unavailable", and a README's image read from
 * the disk shows the main checkout's copy under a delivery that changed it.
 */
import { diffBlobPath, type DiffPanelSource } from '../../lib/board';
import { previewTypeOf } from '../../../../shared/preview-kind';
import type { DiffRevs } from '../../../../shared/diff-revs';
import type { ChangedFileRow } from '../Git/changedFiles';

/** One side of a changed file: the path it has there and the revision to read it at. */
export interface PreviewSide {
  path: string;
  /** A SHA of `revs`, or `worktree` for the After of a live worktree. */
  rev: string;
}

/**
 * The Before and After of a file, `null` for the side that does not exist: an
 * added file has no Before, a deleted one no After, and a renamed or copied
 * file had its Before at the old path.
 */
export function previewSides(row: ChangedFileRow, revs: DiffRevs): { before: PreviewSide | null; after: PreviewSide | null } {
  const isNew = row.status === 'added' || row.status === 'untracked';
  return {
    before: isNew ? null : { path: row.origPath ?? row.path, rev: revs.base },
    after: row.status === 'deleted' ? null : { path: row.path, rev: revs.head ?? 'worktree' },
  };
}

/** The side a rendered preview shows: the After, or the Before of a deleted file. */
export function renderedSide(row: ChangedFileRow, revs: DiffRevs): PreviewSide | null {
  const { before, after } = previewSides(row, revs);
  return after ?? before;
}

/**
 * The repository path an image `src` inside a rendered `.md` points at, resolved
 * from the `.md`'s own folder (a leading `/` is the repository root), or `null`
 * when it leaves the root or is not a picture the byte route serves. `null` is
 * drawn as the alternative text.
 */
export function resolveMarkdownImagePath(mdPath: string, src: string): string | null {
  let target: string;
  try {
    target = decodeURI(src.split(/[?#]/)[0] ?? '');
  } catch {
    return null;
  }
  // A scheme or a protocol-relative URL is not a file of this repository.
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const out = target.startsWith('/') ? [] : mdPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const path = out.join('/');
  const kind = previewTypeOf(path)?.kind;
  return kind === 'image' || kind === 'svg' ? path : null;
}

/**
 * Did a byte read fail because the bundle's revisions moved on (`409`)? Asked
 * only after an `<img>` failed, since an image element never sees the status:
 * then the panel re-reads the bundle instead of showing a dead picture.
 */
export async function isStaleBlob(source: DiffPanelSource, side: PreviewSide): Promise<boolean> {
  try {
    const res = await fetch(diffBlobPath(source, side.path, side.rev));
    await res.body?.cancel();
    return res.status === 409;
  } catch {
    return false;
  }
}

/** The text of a file at one revision (the `.md` to render); `'stale'` on a `409`. */
export async function fetchDiffText(source: DiffPanelSource, side: PreviewSide): Promise<string | 'stale'> {
  const res = await fetch(diffBlobPath(source, side.path, side.rev));
  if (res.status === 409) return 'stale';
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}
