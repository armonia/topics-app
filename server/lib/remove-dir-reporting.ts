import { rmSync } from "node:fs";

/**
 * Removes a directory tree and says whether it is gone. A failure is reported
 * with the path, so the caller never prints a removal that did not happen.
 */
export function removeDirReporting(dir: string, remove: typeof rmSync = rmSync): boolean {
  try {
    remove(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn(`! Could not remove ${dir}:`, e);
    return false;
  }
}
