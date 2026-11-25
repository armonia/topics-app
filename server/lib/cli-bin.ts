import { existsSync } from "fs";
import { join } from "path";
import { agentBinPath, type CliAgentId } from "./agent-bin-paths";

// `$HOME` does not exist on Windows, it is `%USERPROFILE%` there. Reading only
// HOME made every candidate collapse to a relative path that `existsSync`
// resolves against the server's cwd, so on Windows the probe could only return
// null.
export const HOME = process.env.HOME || process.env.USERPROFILE || "";

/** The npm global bin directory on Windows. */
export const WINDOWS_NPM_DIR = join(process.env.APPDATA || join(HOME, "AppData/Roaming"), "npm");

const IS_WINDOWS = process.platform === "win32";

/**
 * The names a CLI can have on this platform. On Windows an executable carries its
 * extension, and which one depends on how it was installed: a real `.exe` for a
 * native installer, a `.cmd` shim for an npm/bun global. The bare name matches
 * neither.
 */
function names(base: string): string[] {
  return IS_WINDOWS ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base] : [base];
}

/** The install locations, expanded to every name this platform accepts. */
function candidates(base: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) for (const n of names(base)) out.push(join(dir, n));
  return out;
}

export interface CliBinSpec {
  /** Key of the path chosen in Settings, see `agent-bin-paths.ts`. */
  agentId: CliAgentId;
  /** Bare executable name, also the PATH lookup. */
  binary: string;
  /** Environment variable that overrides the probe, e.g. `CLAUDE_BIN`. */
  envVar: string;
  /** Windows directories, each expanded to every extension. */
  windowsDirs: string[];
  /** Absolute install locations on macOS and Linux. */
  posixPaths: string[];
}

/**
 * Builds the resolver of one CLI binary. Order: the path chosen in Settings (the
 * one answer that is not a probe), then the env override, then PATH
 * (`Bun.which`), then the known install locations. The result is memoized.
 * A launchd-spawned server or the Tauri sidecar inherits a bare PATH, so a plain
 * spawn would ENOENT and leave a blank terminal tab.
 */
export function createBinResolver(spec: CliBinSpec): { resolve: () => string | null; resetCache: () => void } {
  const probes = IS_WINDOWS ? candidates(spec.binary, spec.windowsDirs) : spec.posixPaths;
  let cached: string | null = null;

  function resolve(): string | null {
    if (cached) return cached;

    const chosen = agentBinPath(spec.agentId);
    if (chosen) return (cached = chosen);

    const envBin = process.env[spec.envVar];
    if (envBin && existsSync(envBin)) return (cached = envBin);

    const inPath = Bun.which(spec.binary);
    if (inPath) return (cached = inPath);

    for (const candidate of probes) {
      try {
        if (existsSync(candidate)) return (cached = candidate);
      } catch {
        /* keep probing */
      }
    }
    return null;
  }

  return { resolve, resetCache: () => { cached = null; } };
}
