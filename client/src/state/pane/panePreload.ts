/**
 * THE CHUNK OF A PANE THAT IS ALREADY OPEN IS NOT A LAZY CHUNK.
 *
 * Every pane body is a `React.lazy` import (ProjectWindow, StandaloneChatGroup):
 * the board, the terminal, the file pane, the editor. That is right for a pane
 * you have never opened - it keeps it out of the first bundle. It is wrong for
 * the pane you are LOOKING AT when you reload, because then the chunk request
 * only leaves after React has mounted, discovered the pane, and hit the
 * suspense boundary. Until it answers the pane is a spinner.
 *
 * Measured on a reload with the board open: the columns arrived 222-347 ms
 * AFTER the app shell had painted - and the same figure came back for the file
 * tree, the editor and the terminal, which is the tell that it was never about
 * their data. Their data was already local. It was the code that was late.
 *
 * So: the local pane-store snapshot is read synchronously at boot (see
 * `hydrateFromLocalSnapshot`), which means before React renders we already know
 * WHICH TYPES of pane are open. Their chunks are asked for right there, in
 * parallel with the app booting, instead of after it. By the time the suspense
 * boundary is reached the promise is already settled and `React.lazy` resolves
 * in the same tick - no fallback is ever shown.
 *
 * This warms the module cache and nothing else: the imports are the exact ones
 * the lazy wrappers use, so the second `import()` is a cache hit rather than a
 * second download. A failure is swallowed on purpose - the lazy boundary is
 * still there and will report it properly if the chunk is genuinely broken.
 */
import type { PaneType } from './types';

/**
 * The chunk each pane type lives in. Only the types with a heavy lazy body:
 * a chat pane is in the main bundle, so there is nothing to warm.
 */
const LOADERS: Partial<Record<PaneType, () => Promise<unknown>>> = {
  board: () => import('../../components/Board/KanbanBoardPane'),
  kanban: () => import('../../components/Board/KanbanBoardPane'),
  terminal: () => import('../../components/Terminal/SingleTerminalPane'),
  browser: () => import('../../components/Browser/RemoteBrowserPanel'),
  files: () => import('../../components/Editor/FilePane'),
  file: () => import('../../components/Editor/FilePane'),
  editor: () => import('../../components/Editor/FilePane'),
  // A project window is a host: what it tiles inside is a file tree and the
  // editor next to it, so its chunk is theirs.
  project: () => import('../../components/Editor/FilePane'),
};

/**
 * Asks for the chunks of `types`, once each.
 *
 * Not awaited by the caller: the point is that the requests are IN FLIGHT while
 * the app boots. Whoever needs the module waits on the same promise.
 */
export function preloadPaneChunks(types: Iterable<PaneType>): void {
  const seen = new Set<PaneType>();
  for (const type of types) {
    if (seen.has(type)) continue;
    seen.add(type);
    const load = LOADERS[type];
    if (!load) continue;
    // The lazy boundary stays the place where a broken chunk is reported.
    void load().catch(() => {});
  }
}
