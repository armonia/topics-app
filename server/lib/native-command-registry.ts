/**
 * THE COMMANDS THE NATIVE RUNTIME IS RUNNING RIGHT NOW, so the swap freezer can
 * find them without importing the provider (and the provider can stay unaware of
 * the freezer).
 *
 * A native `bash` tool is a child of the SERVER, in the server's own process
 * group: the freezer needs its pid to know which pids of that tree belong to an
 * agent and which are Topics itself. It also needs a way to stop the tool's own
 * clock: `runCommand` owns the timeout, and a command frozen for 200 s of its
 * 120 s budget would be killed by us for a pause we caused. `onFreeze` clears
 * the timer, `onThaw` re-arms the remaining time and writes the one line that
 * tells the agent what happened - a red test after a thaw has to be readable as
 * an artefact of the freeze, which is what the T0 probe measured (a Playwright
 * `click({timeout: 5000})` in flight across a 10 s freeze fails on resume).
 */

export interface NativeCommandEntry {
  /** The session whose turn is running this command. */
  sessionKey: string;
  /** The child `runCommand` spawned: the root of the tree. */
  pid: number;
  command: string;
  startedAt: number;
  /** Stops the command's own deadline while it is frozen. */
  onFreeze: () => void;
  /** Re-arms the deadline with the time that was left, and tells the agent. */
  onThaw: (frozenMs: number) => void;
}

const entries = new Map<number, NativeCommandEntry>();

/** Returns the deregistration, which the caller MUST call when the command ends. */
export function registerNativeCommand(entry: NativeCommandEntry): () => void {
  entries.set(entry.pid, entry);
  return () => { entries.delete(entry.pid); };
}

export function listNativeCommands(): NativeCommandEntry[] {
  return [...entries.values()];
}

export function nativeCommandByPid(pid: number): NativeCommandEntry | undefined {
  return entries.get(pid);
}

/** Test seam: the registry is process-wide, a test file is not. */
export function _resetNativeCommands(): void {
  entries.clear();
}
