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
 * A PROJECT WINDOW IS A HOST, AND ITS TILES ARE PANES TOO. The pane store only
 * says "project": the terminal, the browser and the file tree tiled inside it
 * live in the project's own tab record (`topics-project-panes-<hash>`, see
 * `Layout/hooks/projectPersistence`). Measured 2026-09-05 on the desktop's real
 * state: every tile of every project window drew a spinner for 220-240 ms
 * after the shell had painted, on every reload, because nobody had asked for
 * their chunks. `paneTypesToWarm` reads those records too.
 *
 * This warms the module cache and nothing else: the imports are the exact ones
 * the lazy wrappers use, so the second `import()` is a cache hit rather than a
 * second download. A failure is swallowed on purpose - the lazy boundary is
 * still there and will report it properly if the chunk is genuinely broken.
 */
import type { Pane, PaneState, PaneType } from './types';
import { projectPanesKey } from '../../../../shared/project-keys';
import { resolvePaneSpace } from './reducers/spaces';
import { warm } from '../../lib/lazyWarm';

type Loader = () => Promise<unknown>;

/**
 * THE loaders, one object each, shared with the `lazyWarm` wrappers in the
 * layout components: `warm` remembers a module by the identity of the function
 * that loaded it, so the wrapper and the preload have to hold the same one.
 */
export const loadBoard = () => import('../../components/Board/KanbanBoardPane');
export const loadTerminal = () => import('../../components/Terminal/SingleTerminalPane');
export const loadBrowser = () => import('../../components/Browser/RemoteBrowserPanel');
export const loadFilePane = () => import('../../components/Editor/FilePane');
export const loadFileExplorer = () => import('../../components/Project/FileExplorer');
export const loadGitChanges = () => import('../../components/Project/GitChanges');
// A WARM CHUNK CAN STILL HIDE A COLD ONE. `FilePane` and `FileExplorer` are
// only the shells: the body of a file pane is `CodeEditor`, and the file tree
// always mounts `EditorTabs` next to itself - both behind a `lazy()` of their
// own, so the pane arrived warm and then sat on a spinner while a SECOND
// request went out. Measured on the real state (2026-09-10): the second-hop
// chunks left at 181 ms and landed at 309-315 ms, which is the whole window in
// which the first frame is decided.
export const loadCodeEditor = () => import('../../components/Editor/CodeEditor');
export const loadEditorTabs = () => import('../../components/Editor/EditorTabs');
/**
 * The project window's own column. It used to be a STATIC import inside
 * `ProjectWindow`, which put it - and `FileExplorer`, which it imports the same
 * way - in the eager entry chunk: 52 kB parsed on every boot of every window,
 * project open or not, and `loadFileExplorer` above was a split that could
 * never split anything because the module was already in the entry. Measured
 * with `check:bundle`: entry_eager 1.418.177 -> 1.365.938 raw.
 *
 * DESTRUCTURED, like `loadCronJobs` below and for the same reason: a bare
 * `import('…')` handed straight back makes the module OPAQUE to knip, so every
 * export inside it counts as used and a dead one stops being reported. This
 * loader was written in the bare shape and `check:deadcode-blindspots` called
 * it a REGRESSION on the next CI run - the file had never been blind before.
 */
export const loadProjectSidebar = async () => {
  const { ProjectSidebar } = await import('../../components/Project/ProjectSidebar');
  return { ProjectSidebar };
};
export const loadDashboard = () => import('../../components/Dashboard/DashboardPane');
export const loadProcessLog = () => import('../../components/Project/ProcessLogPane');
// The destructured `await` and not `import().then(m => ...)`: with the `.then`
// shape knip cannot see through the module, every export inside it counts as
// used, and a dead export in there stops being reported (`check:deadcode-
// blindspots`). The shape was already chosen for ProfilePane at its old `lazy`
// site — moving the loader here must not lose it.
export const loadCronJobs = async () => {
  const { CronJobsPanel } = await import('../../components/Sidebar/CronJobsPanel');
  return { CronJobsPanel };
};
export const loadProfile = async () => {
  const { ProfilePane } = await import('../../components/Profile/ProfilePane');
  return { ProfilePane };
};

/**
 * The chunks each pane type lives in. Only the types with a heavy lazy body:
 * a chat pane is in the main bundle, so there is nothing to warm.
 */
const LOADERS: Partial<Record<PaneType, Loader[]>> = {
  board: [loadBoard],
  kanban: [loadBoard],
  terminal: [loadTerminal],
  browser: [loadBrowser],
  // "files" is the tree in a project window and the file pane elsewhere: both
  // are cheap to warm, and guessing wrong costs a spinner. `EditorTabs` rides
  // with the tree because `FileExplorer` mounts it UNCONDITIONALLY next to the
  // tree (8,7 kB) - it is not a maybe.
  files: [loadFileExplorer, loadFilePane, loadEditorTabs],
  // A file pane's body IS the editor, so `CodeEditor` belongs to these two and
  // not to `files`/`project`: there it is a maybe (only when a tab is open),
  // and it drags CodeMirror behind it - 314 kB that would go inside the
  // first-frame gate's cap for every project window whether or not anybody has
  // a file open. Measured on the real state: with git no longer mounting the
  // panel from a closed section, that chunk stopped being fetched at boot at
  // all, and putting it back for a maybe would undo exactly that.
  file: [loadFilePane, loadCodeEditor],
  editor: [loadFilePane, loadCodeEditor],
  git: [loadGitChanges],
  dashboard: [loadDashboard],
  'process-log': [loadProcessLog],
  // The other two utility panes. They are TINY (5,9 kB and 6,8 kB built), and
  // that is exactly why they were forgotten - but the spinner they draw has
  // nothing to do with their weight: a bare `React.lazy` commits its fallback
  // on the first mount even with the module already in cache (see
  // `lib/lazyWarm`), so a reload with the Cron tab in front drew the fallback
  // every time for the length of the boot's own render work. Warming them
  // costs a request that lands in the same burst as the others.
  cron: [loadCronJobs],
  profile: [loadProfile],
  // A project window is a host: what it tiles inside is a file tree and the
  // editor next to it, so its chunk is theirs. The tiles it persisted are
  // added by `paneTypesToWarm`. `GitChanges` is NOT here on purpose: since the
  // sidebar stopped mounting the panel from a closed section (`GitSectionRow`)
  // it is no longer part of a project window's first frame, and warming it
  // would put its 48 kB - plus `DiffViewer` and CodeMirror behind it - back
  // inside the cap for a section that is closed by default.
  // `loadProjectSidebar` first: it is the window's CHROME, the one piece whose
  // absence for a frame moves everything else sideways, so it is the one the
  // gate must not render without.
  project: [loadProjectSidebar, loadFilePane, loadFileExplorer, loadEditorTabs],
};

/** The shape of a project's local tab record, as far as warming is concerned. */
interface ProjectTabRecord {
  nonChatPanes?: Array<{ type?: unknown }>;
}

/** The slice of the store {@link panesOnFirstFrame} needs. */
type FirstFrameState = Pick<PaneState, 'panes' | 'groups' | 'spaces' | 'activeSpaceId'>;

/**
 * THE PANES THIS WINDOW WILL ACTUALLY DRAW, AND ONLY THOSE.
 *
 * The warm set used to be `Object.values(state.panes)` - every pane the
 * account has open ANYWHERE. That is not what the first frame draws, and the
 * difference is not academic: the render surface is `group:default` filtered
 * to the active Spazio (`selectors.filterVisiblePaneIds`, the derivation
 * `usePanelLifecycle.visiblePanels` renders from), so a board left open in a
 * Spazio nobody is looking at put its chunk inside the 300 ms cap of the
 * first-frame gate. Measured on the real desktop state (2026-09-10): the warm
 * set was 840 KB of board + terminal + browser + file pane, and every byte of
 * it is waited for before the first pixel.
 *
 * Three window roles, three answers, because each one draws something else:
 *
 *  - a DETACHED pop-out (`?topics=a,b` / `?topic=`) hosts exactly the topics
 *    in its URL and nothing else — `usePanelLifecycle` bypasses the store
 *    filter entirely there (`visiblePanels = openPanels`). Warming the main
 *    window's layout for it is pure waste: pass its hosted ids as
 *    `hostedPaneIds` and only those are considered.
 *  - a GROUP window (`?space=<id>`) is the whole app pinned to one Spazio.
 *    Nothing special is needed HERE because the pinning already happened:
 *    `hydrateFromLocalSnapshot` dispatches `SET_ACTIVE_SPACE` with the id from
 *    the QUERY (never the shared `pane-store-active-space` key, which belongs
 *    to the origin and would start the detached window on the main window's
 *    group) before this runs, so `state.activeSpaceId` is already the right
 *    answer. If the registry does not know that id yet — the Spazio was born
 *    in another window and arrives with the first hydrate — the reducer
 *    resolves it to the default space, and the first frame draws the default
 *    space too: warming what is drawn stays correct either way.
 *  - a normal window: `group:default`, filtered to the active Spazio.
 *
 * A pane id in the order with no record in `panes` (a transient id mid
 * registration) is skipped rather than counted as default-space, because
 * unlike the render filter this list only decides what to DOWNLOAD.
 */
export function panesOnFirstFrame(
  state: FirstFrameState,
  hostedPaneIds: readonly string[] | null,
): Pane[] {
  const ids = hostedPaneIds ?? state.groups['group:default']?.paneIds ?? [];
  const out: Pane[] = [];
  for (const id of ids) {
    const pane = state.panes[id];
    if (!pane) continue;
    // A detached window draws its hosted ids whatever Spazio they are stamped
    // with, so the space filter must not apply to it.
    if (hostedPaneIds === null && resolvePaneSpace(pane, state.spaces) !== state.activeSpaceId) continue;
    out.push(pane);
  }
  return out;
}

/**
 * Which pane types are on screen, tiles of project windows included.
 *
 * `readLocal` is the local record reader (localStorage in the app, a map in
 * tests): a project pane names its folder, the folder names the record, and
 * the record lists the tiles. An unreadable record warms nothing for that
 * window - the tiles still load lazily, as they always did.
 */
export function paneTypesToWarm(
  panes: Iterable<Pick<Pane, 'type' | 'projectPath'>>,
  readLocal: (key: string) => string | null,
): PaneType[] {
  const out = new Set<PaneType>();
  for (const pane of panes) {
    out.add(pane.type);
    if (pane.type !== 'project' || !pane.projectPath) continue;
    const raw = readLocal(projectPanesKey(pane.projectPath));
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as ProjectTabRecord;
      for (const tile of record.nonChatPanes ?? []) {
        if (typeof tile?.type === 'string') out.add(tile.type as PaneType);
      }
    } catch {
      // A record that does not parse is not a reason to fail the boot.
    }
  }
  return [...out];
}

/**
 * Asks for the chunks of `types`, once each, through `warm` so that the
 * `lazyWarm` wrappers can render them without a boundary once they settle.
 *
 * The requests are IN FLIGHT while the app boots; the returned promise settles
 * when every chunk has been evaluated (or failed), and never rejects. The first
 * render waits for it, up to a cap: see `main.tsx`. A cached chunk still lands
 * in a later task than React's first render, so without that wait the wrappers
 * found nothing warm and the tiles drew the fallback anyway (measured: 240 ms
 * of spinner with every chunk cached at 110 ms).
 */
export function preloadPaneChunks(types: Iterable<PaneType>): Promise<void> {
  const seen = new Set<Loader>();
  const pending: Promise<unknown>[] = [];
  for (const type of types) {
    for (const load of LOADERS[type] ?? []) {
      if (seen.has(load)) continue;
      seen.add(load);
      // The lazy boundary stays the place where a broken chunk is reported.
      pending.push(warm(load).catch(() => {}));
    }
  }
  return Promise.all(pending).then(() => {});
}
