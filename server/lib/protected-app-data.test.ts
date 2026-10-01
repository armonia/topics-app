/**
 * The one rule every walker shares: a walk never crosses INTO a protected area
 * it did not start in (`protected-app-data.ts`). Pure path logic: nothing here
 * touches the disk, the real home included.
 *
 * @covers FILE-01
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isProtectedFromWalk, isProtectedRoot, protectedDirExcludes, reachesProtectedAppData } from "./protected-app-data";

const home = "/Users/someone";
const lib = join(home, "Library");

describe("isProtectedFromWalk", () => {
  test("from HOME the walk stops at Library, and at a photo library anywhere", () => {
    expect(isProtectedFromWalk(lib, home, home)).toBe(true);
    expect(isProtectedFromWalk(join(home, "Pictures", "Photos Library.photoslibrary"), home, home)).toBe(true);
    expect(isProtectedFromWalk(join(home, "Projects"), home, home)).toBe(false);
    expect(isProtectedFromWalk(join(home, "Pictures"), home, home)).toBe(false);
  });

  test("from above HOME too", () => {
    expect(isProtectedFromWalk(lib, "/Users", home)).toBe(true);
    expect(isProtectedFromWalk(lib, "/", home)).toBe(true);
  });

  test("from ~/Library the per-app folders are closed, the rest is open", () => {
    for (const d of ["Containers", "Group Containers", "Mail", "Messages", "Safari", "Calendars"]) {
      expect(isProtectedFromWalk(join(lib, d), lib, home)).toBe(true);
    }
    expect(isProtectedFromWalk(join(lib, "Logs"), lib, home)).toBe(false);
    expect(isProtectedFromWalk(join(lib, "Application Support"), lib, home)).toBe(false);
  });

  test("a root opened inside an area browses that area, and only that one", () => {
    const container = join(lib, "Containers", "com.other.app");
    expect(isProtectedFromWalk(join(container, "Data"), container, home)).toBe(false);
    expect(isProtectedFromWalk(join(lib, "Logs", "x"), join(lib, "Logs"), home)).toBe(false);
    const photos = join(home, "Pictures", "P.photoslibrary");
    expect(isProtectedFromWalk(join(photos, "database"), photos, home)).toBe(false);
  });

  test("case does not open a way around it on a case-insensitive disk", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    expect(isProtectedFromWalk(join(home, "library"), home, home)).toBe(true);
    expect(isProtectedFromWalk(join(home, "library", "containers"), join(home, "library"), home)).toBe(true);
  });

  test("an unrelated project is never touched", () => {
    expect(isProtectedFromWalk("/srv/app/src", "/srv/app", home)).toBe(false);
    expect(isProtectedFromWalk("/srv/app/Library", "/srv/app", home)).toBe(false);
  });
});

describe("isProtectedRoot", () => {
  test("from a HOME workspace a search may start in Library or Logs, never in an app's folder", () => {
    expect(isProtectedRoot(lib, home, home)).toBe(false);
    expect(isProtectedRoot(join(lib, "Logs"), home, home)).toBe(false);
    expect(isProtectedRoot(join(lib, "Containers"), home, home)).toBe(true);
    expect(isProtectedRoot(join(home, "Pictures", "Photos Library.photoslibrary"), home, home)).toBe(true);
  });

  test("a workspace already inside an app's folder searches it freely", () => {
    const ws = join(lib, "Containers", "com.mine.app");
    expect(isProtectedRoot(join(ws, "Data"), ws, home)).toBe(false);
  });
});

describe("reachesProtectedAppData", () => {
  test("HOME, above it and ~/Library reach it; a project or one app's folder does not", () => {
    expect(reachesProtectedAppData(home, home)).toBe(true);
    expect(reachesProtectedAppData("/Users", home)).toBe(true);
    expect(reachesProtectedAppData(lib, home)).toBe(true);
    expect(reachesProtectedAppData(join(home, "Projects", "app"), home)).toBe(false);
    expect(reachesProtectedAppData(join(lib, "Logs"), home)).toBe(false);
  });
});

describe("protectedDirExcludes", () => {
  test("from HOME: Library plus the media libraries", () => {
    const ex = protectedDirExcludes(home, home);
    expect(ex).toContain("Library");
    expect(ex).toContain("*.photoslibrary");
    expect(ex).not.toContain("Containers");
  });

  test("from ~/Library: the per-app folders, never Library itself (grep would drop the root)", () => {
    const ex = protectedDirExcludes(lib, home);
    expect(ex).toEqual(expect.arrayContaining(["Containers", "Group Containers", "Mail", "Messages", "Safari", "Calendars"]));
    expect(ex).not.toContain("Library");
  });

  test("from a project: only the media libraries", () => {
    const ex = protectedDirExcludes(join(home, "Projects", "app"), home);
    expect(ex).not.toContain("Library");
    expect(ex).toContain("*.photoslibrary");
  });

  test("a root that IS a media library keeps its own contents searchable", () => {
    const ex = protectedDirExcludes(join(home, "Pictures", "P.photoslibrary"), home);
    expect(ex.some((n) => n.startsWith("*"))).toBe(false);
  });
});
