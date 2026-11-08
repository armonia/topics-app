/**
 * ACCEPT (or refuse) a path somebody typed for an agent CLI.
 *
 * The probe in `detect-agents.ts` looks in the places the vendors document. When
 * it comes up empty and the CLI is nonetheless installed, the person has to be
 * able to say where it is; this is the part that decides whether what they said
 * is usable, BEFORE it is stored. A path that does not resolve would be worse
 * than no path at all: it registers a provider that cannot answer, and the
 * failure surfaces much later, as an empty terminal pane.
 *
 * It is also the place that does the work for them. What a person has at hand is
 * rarely the binary itself: it is the folder from a file picker, the app bundle,
 * the `bin` directory printed by `npm prefix`. Each of those contains exactly one
 * thing we are looking for, and looking is cheaper than an error message that
 * sends them back to the terminal.
 */
import { accessSync, constants, existsSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import {
  CLI_AGENT_BIN_NAMES,
  expandHome,
  writeAgentBinPath,
  type CliAgentId,
} from "./agent-bin-paths";

export interface ConfigureAgentBinResult {
  ok: boolean;
  /** The absolute path that was stored, when it was accepted. */
  path?: string;
  /**
   * Why it was refused, in one sentence and already addressed to a person: the
   * route hands this straight to the UI, which has no more context than we do.
   */
  error?: string;
}

/** Where a binary can hide inside a directory somebody pointed at. */
function insideDirectory(dir: string, binName: string): string[] {
  return [
    join(dir, binName),
    // macOS app bundle: `/Applications/Codex.app` holds the CLI down here, and
    // dragging the bundle into a text field is the obvious thing to try.
    join(dir, "Contents/Resources", binName),
    join(dir, "bin", binName),
    // Windows keeps the extension: an npm global is a `.cmd` shim, an installer
    // drops a real `.exe`.
    join(dir, `${binName}.exe`),
    join(dir, `${binName}.cmd`),
  ];
}

/** Is this something we can actually run (a file, with the execute bit)? */
function isRunnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no execute bit: `X_OK` there degrades to "does it exist", which
  // is all the answer that platform can give.
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve what the person typed into a runnable absolute path, without storing
 * anything. Exported for the tests and for any caller that wants to check first.
 */
export function resolveTypedBinPath(
  agent: CliAgentId,
  typed: string,
): ConfigureAgentBinResult {
  const expanded = expandHome(typed);
  if (expanded === "") return { ok: false, error: "The path is empty." };
  if (!isAbsolute(expanded)) {
    // A relative path would be resolved against the server's working directory,
    // which is not the directory the person was thinking of.
    return { ok: false, error: "Use the full path, starting from the root of the disk." };
  }
  if (!existsSync(expanded)) {
    return { ok: false, error: "There is nothing at that path." };
  }

  let isDir = false;
  try {
    isDir = statSync(expanded).isDirectory();
  } catch {
    return { ok: false, error: "That path cannot be read." };
  }

  if (isDir) {
    const binName = CLI_AGENT_BIN_NAMES[agent];
    const found = insideDirectory(expanded, binName).find(isRunnable);
    if (found) return { ok: true, path: found };
    return {
      ok: false,
      error: `That folder does not contain "${binName}". Point at the file itself.`,
    };
  }

  if (!isRunnable(expanded)) {
    return { ok: false, error: "That file is not executable." };
  }
  return { ok: true, path: expanded };
}

/**
 * Validate and STORE the override for one agent. Passing `null` clears it, which
 * is how somebody undoes a path that pointed at a CLI they have since removed.
 *
 * Does not reset the resolver caches: that is the caller's move, because it also
 * has to re-register the provider and it should happen once, after this returns.
 */
export function configureAgentBin(
  agent: CliAgentId,
  typed: string | null,
): ConfigureAgentBinResult {
  if (typed === null || typed.trim() === "") {
    writeAgentBinPath(agent, null);
    return { ok: true };
  }
  const resolved = resolveTypedBinPath(agent, typed);
  if (!resolved.ok || !resolved.path) return resolved;
  writeAgentBinPath(agent, resolved.path);
  return resolved;
}
