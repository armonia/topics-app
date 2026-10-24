import { readFileSync } from "node:fs";
// A `type: "file"` import is what makes the compiled sidecar embed the recorder;
// from source (dev, launchd) it resolves to the path on disk.
import recorderPath from "../assets/rrweb.min.js" with { type: "file" };

let cachedRecorderSource: string | undefined;

/** The recorder shared by the server browser and native-host route. */
export function getRrwebRecorderSource(): string {
  if (cachedRecorderSource !== undefined) return cachedRecorderSource;
  try {
    cachedRecorderSource = readFileSync(recorderPath, "utf8")
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
