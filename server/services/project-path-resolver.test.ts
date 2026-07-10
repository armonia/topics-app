import { describe, it, expect } from "bun:test";
import { resolveProjectPath, type ProjectCandidate } from "./project-path-resolver";
import { projectIdForPath } from "./tasks";

describe("resolveProjectPath", () => {
  const paths = ["/Users/x/Projects/alpha", "/Users/x/Projects/beta", "/Users/x/workspace/gamma"];
  const candidates: ProjectCandidate[] = [
    { path: paths[0], projectStoreId: "uuid-alpha" },
    { path: paths[1], projectStoreId: null },
    { path: paths[2], projectStoreId: "uuid-gamma" },
  ];

  it("inverts the board hash back to the matching candidate", () => {
    for (const c of candidates) {
      const got = resolveProjectPath(projectIdForPath(c.path), candidates);
      expect(got?.path).toBe(c.path);
      expect(got?.projectStoreId).toBe(c.projectStoreId);
    }
  });

  it("returns null when no candidate re-hashes to the id", () => {
    expect(resolveProjectPath("nope-000000", candidates)).toBeNull();
  });

  it("returns null on an empty candidate set", () => {
    expect(resolveProjectPath(projectIdForPath(paths[0]), [])).toBeNull();
  });
});
