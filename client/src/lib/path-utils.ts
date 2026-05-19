/**
 * Small path helpers shared across the client. Everything in here is
 * a pure function — no React, no I/O — so it can be imported from
 * components, hooks, contexts, or non-component utilities without
 * dragging in a render dependency.
 *
 * The functions deliberately mirror the POSIX semantics most of our
 * paths use (forward slashes, no Windows-style separators) since the
 * server normalises to POSIX before sending paths down.
 */

/**
 * Last segment of a POSIX-style path, falling back to the input when
 * the path contains no separator. Used to render display labels for
 * files, directories, projects, and Git artefacts.
 *
 * Examples:
 *   basename('/Users/a/foo.txt') → 'foo.txt'
 *   basename('foo.txt')          → 'foo.txt'
 *   basename('/Users/a/')        → 'a'   (trailing slashes ignored)
 *   basename('')                 → ''
 *
 * Trailing slashes are stripped so a directory path renders as the
 * directory name, not the empty string.
 */
export function basename(path: string): string {
  if (!path) return path;
  // Strip trailing slashes so '/foo/bar/' → 'bar', not ''.
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
