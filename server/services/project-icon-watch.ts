/**
 * Watches the folders that define a project's icon and pushes one
 * `project:icon` frame when the icon appears, changes or goes away.
 *
 * WHY. The client used to learn a project's icon once and keep the answer: a
 * "no icon" for twelve hours, a "has icon" forever, and the image under one URL
 * the page had already decoded. A favicon added to a project did not show up,
 * a changed one kept its old bytes, a removed one stayed. Nothing on the server
 * noticed the folder, so nothing could tell the windows.
 *
 * WHICH PROJECTS. The ones a client asked the icon of (`GET /api/projects/icon`
 * or `POST /api/projects/icon-versions`): exactly the icons some surface is
 * drawing, whatever pane is open. After a server restart the set is empty, and
 * the client's revalidation on reconnect fills it again (`projectIconStore`).
 *
 * HOW. One non-recursive watch per folder the resolver reads
 * (`projectIconWatchDirs`), never a walk of the tree: a recursive watch would
 * register every folder of `node_modules` on Linux. An event whose entry cannot
 * matter (`iconRelevantEntry`) is dropped before the debounce, then the icon is
 * resolved again and compared with the last version known: only a DIFFERENT
 * version leaves as a frame. The set of watched folders is recomputed at every
 * check, so a `public/` created after the first look is watched from then on.
 *
 * WHO ANNOUNCES. Whoever sees a change first: the watcher, or a request that
 * resolves the icon (`observe`) and finds a version different from the one
 * known. The version is then updated, so the other one finds nothing new and
 * the frame leaves once.
 */
import { existsSync, watch } from "node:fs";
import {
  iconRelevantEntry,
  projectIconVersion,
  projectIconWatchDirs,
  resolveProjectIcon,
  type ResolvedProjectIcon,
} from "../lib/project-icon";

// A type alias, not an interface: it has to be assignable to the outbound
// message shape, whose index signature an interface does not satisfy.
export type ProjectIconFrame = {
  type: "project:icon";
  path: string;
  version: string | null;
};

interface DirHandle { close(): void }

export interface ProjectIconWatchDeps {
  /** One frame per path a client asked with; `realDir` is the folder behind it. */
  push: (frame: ProjectIconFrame, realDir: string) => void;
  /** Quiet time after the last relevant event before the icon is resolved again. */
  debounceMs?: number;
  /** Projects watched at once; past it the one asked about longest ago is dropped. */
  maxTracked?: number;
  /** Test seam: how one folder is watched. Default `fs.watch`, non-recursive. */
  watchDir?: (dir: string, onEntry: (name: string | null) => void, onError: () => void) => DirHandle | null;
}

export interface ProjectIconWatch {
  /**
   * A request just resolved the icon of `realDir` (asked as `asked`). Starts
   * watching it if needed, pushes if the version differs from the known one,
   * and returns the version.
   */
  observe(realDir: string, asked: string, resolved: ResolvedProjectIcon | null): string | null;
  /** The real paths watched now, the one asked about longest ago first. */
  tracked(): string[];
  /** The folders watched for one project (for tests and diagnostics). */
  watchedDirs(realDir: string): string[];
  stopWatching(realDir: string): void;
  close(): void;
}

interface Entry {
  version: string | null;
  /** The paths clients asked with: the frame carries the one each client keys on. */
  aliases: Set<string>;
  dirs: Map<string, DirHandle>;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_TRACKED = 128;
/** A symlinked path and its real one are two aliases; more than this is noise. */
const MAX_ALIASES = 4;

function defaultWatchDir(dir: string, onEntry: (name: string | null) => void, onError: () => void): DirHandle | null {
  try {
    const w = watch(dir, { persistent: false }, (_event, name) => onEntry(name == null ? null : name.toString()));
    w.on("error", onError);
    return { close() { try { w.close(); } catch { /* already closed */ } } };
  } catch {
    // A folder that vanished between the check and the watch: the next check
    // of its parent sees the change anyway.
    return null;
  }
}

export function createProjectIconWatch(deps: ProjectIconWatchDeps): ProjectIconWatch {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxTracked = deps.maxTracked ?? DEFAULT_MAX_TRACKED;
  const watchDir = deps.watchDir ?? defaultWatchDir;
  const entries = new Map<string, Entry>();

  function announce(realDir: string, entry: Entry): void {
    for (const path of entry.aliases) deps.push({ type: "project:icon", path, version: entry.version }, realDir);
  }

  function arm(realDir: string, entry: Entry): void {
    const wanted = new Set(existsSync(realDir) ? projectIconWatchDirs(realDir) : []);
    for (const [dir, h] of entry.dirs) {
      if (!wanted.has(dir)) { h.close(); entry.dirs.delete(dir); }
    }
    for (const dir of wanted) {
      if (entry.dirs.has(dir)) continue;
      const h = watchDir(dir, (name) => { if (iconRelevantEntry(name)) schedule(realDir); }, () => schedule(realDir));
      if (h) entry.dirs.set(dir, h);
    }
  }

  function schedule(realDir: string): void {
    const entry = entries.get(realDir);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      recheck(realDir);
    }, debounceMs);
  }

  function recheck(realDir: string): void {
    const entry = entries.get(realDir);
    if (!entry) return;
    const gone = !existsSync(realDir);
    const resolved = gone ? null : resolveProjectIcon(realDir);
    const version = projectIconVersion(resolved);
    if (version !== entry.version) {
      entry.version = version;
      announce(realDir, entry);
    }
    // A project folder that no longer exists has nothing left to watch.
    if (gone) { stopWatching(realDir); return; }
    arm(realDir, entry);
  }

  function makeRoom(): void {
    if (entries.size < maxTracked) return;
    for (const dir of [...entries.keys()]) {
      if (!existsSync(dir)) stopWatching(dir);
    }
    while (entries.size >= maxTracked) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      stopWatching(oldest);
    }
  }

  function stopWatching(realDir: string): void {
    const entry = entries.get(realDir);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const h of entry.dirs.values()) h.close();
    entries.delete(realDir);
  }

  return {
    observe(realDir, asked, resolved) {
      const version = projectIconVersion(resolved);
      const known = entries.get(realDir);
      if (!known) {
        makeRoom();
        const entry: Entry = { version, aliases: new Set([asked]), dirs: new Map(), timer: null };
        entries.set(realDir, entry);
        arm(realDir, entry);
        return version;
      }
      // Touch: the project asked about most recently is the last to be dropped.
      entries.delete(realDir);
      entries.set(realDir, known);
      if (!known.aliases.has(asked) && known.aliases.size < MAX_ALIASES) known.aliases.add(asked);
      if (known.version !== version) {
        known.version = version;
        announce(realDir, known);
        arm(realDir, known);
      }
      return version;
    },
    tracked: () => [...entries.keys()],
    watchedDirs: (realDir) => [...(entries.get(realDir)?.dirs.keys() ?? [])],
    stopWatching,
    close() {
      for (const dir of [...entries.keys()]) stopWatching(dir);
    },
  };
}
