/**
 * Validation of the «worktree root» setting, shared by the PUT route (which
 * refuses a bad value, with a reason) and the resolver (which ignores one written
 * by hand).
 *
 * A root is a folder whose subfolders the cleanup may judge, so it must be a
 * place that holds nothing but Topics' worktrees. Refused, by path alone:
 *   - relative values;
 *   - the system temp areas (`/tmp`, the OS temp folder): the OS cleans them
 *     under live checkouts, and one agent tool filled 202 GB there unseen;
 *   - a filesystem root (`/`, `C:\`), the home folder and any folder above it;
 *   - system folders (`/System`, `/usr`, `C:\Windows`, ...).
 * Refused with the disk and the projects in hand (`worktreeRootRefusal`):
 *   - a folder inside a project's repository, or one that CONTAINS a project;
 *   - a non-empty folder that does not carry Topics' sentinel (somebody's data).
 */
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

/** Why a root is refused. Each code is a fact about the path or the disk, shown to the person as such. */
export type WorktreeRootRefusal =
  | "relative"
  | "temp"
  | "filesystem-root"
  | "home"
  | "home-ancestor"
  | "system"
  | "inside-project"
  | "contains-project"
  | "not-empty";

/** Fixed temp areas on Unix; the OS temp folder of this machine is added at the call. */
const UNIX_TEMP_AREAS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
/** System folders: the root may be neither these nor inside them. */
const UNIX_SYSTEM = ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/dev", "/proc", "/sys", "/boot", "/private", "/var", "/Applications", "/cores"];
/** Folders that hold other people's or other disks' data: refused as the root itself. */
const UNIX_SHARED_PARENTS = ["/Users", "/home", "/Volumes", "/mnt", "/media", "/opt", "/srv", "/root"];

const isWin = (platform: NodeJS.Platform): boolean => platform === "win32";
/** The path flavour of the platform being judged (the tests judge Windows paths on any host). */
const pathOf = (platform: NodeJS.Platform) => (isWin(platform) ? win32 : posix);

/** `a` equals `b` or sits under it, with case folded on Windows. */
function within(a: string, b: string, platform: NodeJS.Platform): boolean {
  const x = isWin(platform) ? a.toLowerCase() : a;
  const y = isWin(platform) ? b.toLowerCase() : b;
  const sep = pathOf(platform).sep;
  const base = y.endsWith(sep) ? y : y + sep;
  return x === y || x.startsWith(base);
}

const same = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  isWin(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;

function realOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** The temp areas of this machine: the fixed Unix ones, and the OS temp folder as written and as resolved. */
export function tempAreas(platform: NodeJS.Platform = process.platform, osTmp: string = tmpdir()): string[] {
  const abs = pathOf(platform).resolve(osTmp);
  const own = [abs, realOrSelf(abs)];
  return isWin(platform) ? own : [...UNIX_TEMP_AREAS, ...own];
}

function systemFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (!isWin(platform)) return UNIX_SYSTEM;
  return [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]
    .filter((v): v is string => !!v)
    .map((v) => win32.resolve(v));
}

export interface PathCheckOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  osTmp?: string;
}

/** The checks that need only the path. `abs` must already be absolute. */
export function pathRefusal(abs: string, opts: PathCheckOptions = {}): WorktreeRootRefusal | null {
  const platform = opts.platform ?? process.platform;
  const P = pathOf(platform);
  const home = P.resolve(opts.home ?? homedir());
  if (P.dirname(abs) === abs) return "filesystem-root";
  if (same(abs, home, platform)) return "home";
  if (within(home, abs, platform)) return "home-ancestor";
  if (tempAreas(platform, opts.osTmp).some((t) => within(abs, t, platform))) return "temp";
  if (systemFolders(platform, opts.env ?? process.env).some((s) => within(abs, s, platform))) return "system";
  if (!isWin(platform) && UNIX_SHARED_PARENTS.some((s) => same(abs, s, platform))) return "system";
  return null;
}

/** `~` expanded and made absolute, no trailing slash; null when the value is empty or relative. */
function expand(raw: string, home: string, platform: NodeJS.Platform): string | null {
  const P = pathOf(platform);
  let value = raw.trim();
  if (value === "") return null;
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = P.join(home, value.slice(2));
  if (!P.isAbsolute(value)) return null;
  return P.resolve(value);
}

/**
 * The canonical form of a typed root: `~` expanded, made absolute, no trailing
 * slash. Null when it is empty, relative, or refused by `pathRefusal`.
 */
export function normalizeWorktreeRoot(raw: string, home: string = homedir(), opts: Omit<PathCheckOptions, "home"> = {}): string | null {
  const abs = expand(raw, home, opts.platform ?? process.platform);
  if (!abs) return null;
  return pathRefusal(abs, { ...opts, home }) ? null : abs;
}

export interface RootDiskFacts {
  /** The paths of the known projects. */
  projectPaths: readonly string[];
  /** The folder exists and holds something. */
  nonEmpty: (abs: string) => boolean;
  /** The folder carries Topics' sentinel, or is the default root Topics always used. */
  isTopicsRoot: (abs: string) => boolean;
}

/**
 * Everything that refuses a typed root, the path checks and the disk checks. The
 * root it would store, or the reason it is refused.
 */
export function worktreeRootRefusal(
  raw: string,
  facts: RootDiskFacts,
  opts: PathCheckOptions = {},
): { root: string } | { refusal: WorktreeRootRefusal } {
  const platform = opts.platform ?? process.platform;
  const P = pathOf(platform);
  const home = P.resolve(opts.home ?? homedir());
  const abs = expand(raw, home, platform);
  if (!abs) return { refusal: "relative" };
  const byPath = pathRefusal(abs, { ...opts, home });
  if (byPath) return { refusal: byPath };
  const real = realOrSelf(abs);
  for (const p of facts.projectPaths) {
    if (!p) continue;
    const projectPath = P.resolve(p);
    const projectReal = realOrSelf(projectPath);
    if (within(abs, projectPath, platform) || within(real, projectReal, platform)) return { refusal: "inside-project" };
    if (within(projectPath, abs, platform) || within(projectReal, real, platform)) return { refusal: "contains-project" };
  }
  if (facts.nonEmpty(abs) && !facts.isTopicsRoot(abs)) return { refusal: "not-empty" };
  return { root: abs };
}
