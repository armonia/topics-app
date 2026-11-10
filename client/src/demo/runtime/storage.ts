/* Seeds the browser storage the client hydrates from at boot, so the app opens
 * straight into the scenario's layout instead of an empty first run. The keys
 * come from the modules that read them wherever those are dependency-free
 * (shared/project-keys.ts); the others are the literal keys their readers use,
 * named next to each write. */
import { projectLayoutKey, projectPanesKey } from "../../../../shared/project-keys";
import type { LandingSeed } from "../scenario";

const GRID_KEY = "topics-panel-grid-layout"; // usePanelGridPersistence: bare = default space

function setLocal(k: string, v: string): void { try { localStorage.setItem(k, v); } catch (_e) { /* private mode: boot unseeded */ } }

/** localStorage: everything the client reads before its first render. */
export function seedLocalStorage(seed: LandingSeed): void {
  // The reducer's LWW gate drops a hydrate unless server_seq beats the live
  // lastSeq (which starts at 0): the scenario sets it high so the seed applies.
  setLocal("pane-store-v2", JSON.stringify(seed.paneStore));
  setLocal("pane-store-focused-id", seed.focusedPaneId); // persistLocal LOCAL_FOCUS_KEY, a bare string
  for (const [spaceId, grid] of Object.entries(seed.gridLayouts)) {
    setLocal(spaceId ? `${GRID_KEY}:${spaceId}` : GRID_KEY, JSON.stringify(grid));
  }
  for (const p of seed.projects) {
    setLocal(projectPanesKey(p.path), JSON.stringify(p.panes));
    setLocal(projectLayoutKey(p.path), JSON.stringify(p.layout));
  }
  setLocal("theme", JSON.stringify(seed.theme)); // useServerState('theme', { localStorageKey: 'theme' })
  setLocal("app-settings", JSON.stringify(seed.settings)); // lib/settings STORAGE_KEY
  setLocal("topics-sidebar-state", JSON.stringify(seed.sidebar)); // useSidebarState STORAGE_KEY
}

/** sessionStorage: the git status the project sidebar paints before it asks, and its open sections. */
export function seedSessionStorage(seed: LandingSeed): void {
  try {
    for (const [path, entry] of Object.entries(seed.gitStatusCache)) {
      sessionStorage.setItem(`git-status-cache:${path}`, JSON.stringify(entry)); // useGitStatus CACHE_KEY
    }
    // ProjectSidebar reads the per-project key first and this plain one as fallback.
    sessionStorage.setItem("sidebar-sections", JSON.stringify(seed.sidebarSections));
  } catch (_e) { /* private mode: boot unseeded */ }
}
