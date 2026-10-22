import { readFileSync } from "node:fs";
import { join } from "node:path";

let cachedRecorderSource: string | undefined;

/** The recorder shared by the server browser and native-host route. */
export function getRrwebRecorderSource(): string {
  if (cachedRecorderSource !== undefined) return cachedRecorderSource;
  try {
    cachedRecorderSource = readFileSync(join(import.meta.dir, "..", "assets", "rrweb.min.js"), "utf8")
      .replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  } catch (error) {
    cachedRecorderSource = "";
    console.warn("[BrowserService] rrweb record bundle missing — DOM co-browse disabled:", (error as Error)?.message);
  }
  return cachedRecorderSource;
}

export function assertRrwebVersionsMatch(clientVersion: string, lockedVersion: string): void {
  if (clientVersion !== lockedVersion) {
    throw new Error(`rrweb version mismatch: client package requests ${clientVersion}, lockfile pins ${lockedVersion}`);
  }
}

export function readLockedRrwebVersion(lockText: string): string {
  const match = lockText.match(/^\s+"rrweb":\s+\["rrweb@([^"]+)"/m);
  if (!match) throw new Error("rrweb package is missing from client/bun.lock");
  return match[1];
}
