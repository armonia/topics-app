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
  /** Under `worktree`, which content of the file: see `afterBlobId`. */
  version?: string;
}

/**
 * The id git gave the After of a file's block (`index <before>..<after>`).
 * On a live worktree the After keeps the name `worktree` while the agent
 * rewrites the file: this id is what changes, the blob git hashed from the
 * disk when the bundle was read.
 */
export function afterBlobId(block: string | undefined): string | undefined {
  return block ? /^index [0-9a-f]+\.\.([0-9a-f]+)/m.exec(block)?.[1] : undefined;
}

/**
 * The Before and After of a file, `null` for the side that does not exist: an
 * added file has no Before, a deleted one no After, and a renamed or copied
 * file had its Before at the old path. `block` is the file's patch in the
 * bundle, which dates a `worktree` After.
 */
export function previewSides(row: ChangedFileRow, revs: DiffRevs, block?: string): { before: PreviewSide | null; after: PreviewSide | null } {
  const isNew = row.status === 'added' || row.status === 'untracked';
  const version = revs.head === null ? afterBlobId(block) : undefined;
  return {
    before: isNew ? null : { path: row.origPath ?? row.path, rev: revs.base },
    after: row.status === 'deleted' ? null : { path: row.path, rev: revs.head ?? 'worktree', ...(version ? { version } : {}) },
  };
}

/** The side a rendered preview shows: the After, or the Before of a deleted file. */
export function renderedSide(row: ChangedFileRow, revs: DiffRevs, block?: string): PreviewSide | null {
  const { before, after } = previewSides(row, revs, block);
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
 * After an `<img>` failed: when the byte read failed because the bundle's
 * revisions moved on (`409`, the card landed between the list and the click),
 * `onStale` re-reads the bundle instead of leaving a dead picture. Asked
 * separately because an image element never sees the status.
 */
export async function reportStaleBlob(source: DiffPanelSource, side: PreviewSide, onStale: () => void): Promise<void> {
  try {
    const res = await fetch(diffBlobPath(source, side.path, side.rev));
    await res.body?.cancel();
    if (res.status === 409) onStale();
  } catch {
    // Offline or refused: nothing says the bundle moved, the picture stays "unavailable".
  }
}

/**
 * The text of a file at one revision (the `.md` to render). On a `409` it calls
 * `onStale`, which re-reads the bundle, and has no text: `null`.
 */
export async function fetchDiffText(source: DiffPanelSource, side: PreviewSide, onStale: () => void): Promise<string | null> {
  const res = await fetch(diffBlobPath(source, side.path, side.rev));
  if (res.status === 409) {
    await res.body?.cancel();
    onStale();
    return null;
  }
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}
