import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve symlinks even when a new file or directory does not exist yet.
 * Only missing descendants may be appended to the nearest real ancestor.
 * A dangling symlink is an existing entry, not a missing descendant: falling
 * back to its parent would let a later write follow it outside the boundary.
 */
export function realPathForNewEntry(input: string): string | null {
  let ancestor = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try {
        lstatSync(ancestor);
        return null; // Exists but cannot resolve, including a dangling link.
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}
