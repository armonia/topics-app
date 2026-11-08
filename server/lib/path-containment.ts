/**
 * Is a path inside a directory? One answer, for every platform.
 *
 * The rule this module exists for: containment is NOT a string prefix, and the
 * separator is NOT `/`. Both halves have already cost a bug.
 *
 * 1. A bare `startsWith(root)` lets in the SIBLING with the right prefix:
 *    with root `/home/me/proj`, `/home/me/proj-secret` passes.
 *
 * 2. Appending `"/"` by hand fixes the sibling and breaks Windows, where a
 *    child is `root + "\\"`. Measured on the first Windows run of the e2e
 *    suite: inside a known project EVERY file and EVERY subfolder fell outside
 *    the boundary, and 48 file-explorer/git specs timed out against a product
 *    that was answering correctly according to its own wrong boundary.
 *
 * So the comparison goes through `path.relative`, which knows the separator of
 * the platform it runs on: a descendant produces a relative path that neither
 * escapes upwards nor is absolute.
 *
 * The caller passes REAL paths. `../` is normalised here, a symlink is not: a
 * link inside an allowed root pointing at `/etc` would produce a string that is
 * impeccable. Resolving touches the disk, deciding does not, and the decision
 * is the part worth testing.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** A path is inside a directory (or is the directory itself)? */
export function isInsideDir(candidate: string, dir: string): boolean {
  const child = resolve(candidate);
  const root = resolve(dir);
  if (child === root) return true;
  const rel = relative(root, child);
  // Empty means "same path" (already handled); an absolute result means the two
  // live on different volumes, which on Windows is the honest answer to
  // `relative("C:\\a", "D:\\b")` and is NOT containment.
  if (!rel || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}
