import type { ChildProcess } from "child_process";

/**
 * Resolves when `proc` has exited, or after `capMs`, whichever comes first.
 *
 * Shutdown used to sleep a flat 3500 ms "so the children can flush", whether or
 * not there was a child at all: every server reload paid it, and a reload is
 * what the user waits through when they refresh Topics. Waiting for the real
 * exit keeps the flush guarantee and costs nothing when there is nothing to
 * wait for. The cap timer is unref'd so it never holds the process open.
 */
export function childExited(proc: ChildProcess, capMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, capMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
