/**
 * A temporary folder laid out like a macOS home, for the tests of every walker
 * that must stop at other apps' data (`protected-app-data.ts`).
 *
 * NEVER the real home: walking `~/Library/Containers` from a test pops the very
 * permission prompt these tests exist to prevent, on the screen of whoever runs
 * them. Every protected file holds the word `needle`, so a search or a walk
 * that wrongly enters shows up as a result.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Protected files, relative to the fake home. */
export const PROTECTED_FILES = [
  "Library/Containers/com.other.app/Data/secret.txt",
  "Library/Group Containers/group.other.app/secret.txt",
  "Library/Mail/V10/secret.txt",
  "Library/Messages/chat.txt",
  "Library/Safari/History.txt",
  "Library/Calendars/cal.txt",
  "Pictures/Photos Library.photoslibrary/database/secret.txt",
  "Projects/app/assets/Old.photoslibrary/secret.txt",
] as const;

/** Readable files, relative to the fake home. */
export const OPEN_FILES = [
  "Library/Logs/app.log",
  "Projects/app/src/a.ts",
  "notes.txt",
] as const;

export interface FakeHome {
  home: string;
  /** Restores HOME and deletes the tree. */
  dispose(): void;
}

/** Builds the tree and points `HOME` at it until `dispose()`. */
export function makeFakeHome(): FakeHome {
  const home = mkdtempSync(join(tmpdir(), "fake-home-"));
  for (const rel of [...PROTECTED_FILES, ...OPEN_FILES]) {
    const full = join(home, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "needle\n");
  }
  const before = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    dispose() {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
