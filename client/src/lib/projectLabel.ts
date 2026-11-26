import { basename } from './path-utils';

/**
 * Friendly display label for a workspace project path: the basename, with
 * the full path as a fallback if basename can't extract one (e.g. relative
 * or single-segment paths).
 *
 * Every surface that shows a project name (sidebar, command palette, master
 * strip, chat tab project chip, the bell) reads from here. Don't reimplement
 * the `.split('/').pop()` dance at a call site.
 *
 * A server on Windows sends its paths with backslashes (a terminal's cwd,
 * seen in the bell on 05/11 as the whole `C:\Users\...` path): they count as
 * separators here too, so the label is the folder's name there as well.
 *
 * Its own module on purpose: the bell's ledger is computed at boot, and
 * importing this from `buildSidebarItems` pulled the whole sidebar builder
 * into the first download (about 14 KB, measured on 22/11).
 */
export function getProjectLabel(projectPath: string): string {
  return basename(projectPath.replace(/\\/g, '/')) || projectPath;
}
