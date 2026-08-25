/**
 * @covers PROJECT-08
 */
import { describe, expect, it } from "bun:test";
import { matchProjectRef, matchProjectRefAll, type ProjectRefCandidate } from "./project-ref";

// Mirror the store's slugify closely enough for the matcher's purposes.
const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const candidates: ProjectRefCandidate[] = [
  { path: "/Users/z/Projects/topics-app", name: "Topics App", slug: "topics-app" },
  { path: "/Users/z/Projects/pix", name: "Pix", slug: "pix" },
  { path: "/Users/z/.openclaw/workspace/scratch" }, // workspace dir, no name/slug
];

describe("matchProjectRef", () => {
  it("matches by the user's project name, case-insensitively (the 'open project Pix' case)", () => {
    expect(matchProjectRef("Pix", candidates, slugify)).toBe("/Users/z/Projects/pix");
    expect(matchProjectRef("pix", candidates, slugify)).toBe("/Users/z/Projects/pix");
    expect(matchProjectRef("PIX", candidates, slugify)).toBe("/Users/z/Projects/pix");
  });

  it("matches by slug when the spoken name has spaces", () => {
    expect(matchProjectRef("Topics App", candidates, slugify)).toBe(
      "/Users/z/Projects/topics-app",
    );
    expect(matchProjectRef("topics-app", candidates, slugify)).toBe(
      "/Users/z/Projects/topics-app",
    );
  });

  it("falls back to folder basename for candidates without a name/slug", () => {
    expect(matchProjectRef("scratch", candidates, slugify)).toBe(
      "/Users/z/.openclaw/workspace/scratch",
    );
  });

  it("prefers a slug match over a coincidental basename later in the list", () => {
    const c: ProjectRefCandidate[] = [
      { path: "/a/pix", name: "Pix", slug: "pix" },
      { path: "/b/other/pix" }, // basename also 'pix' but no slug
    ];
    expect(matchProjectRef("pix", c, slugify)).toBe("/a/pix");
  });

  it("returns null for unknown or empty refs", () => {
    expect(matchProjectRef("nonexistent", candidates, slugify)).toBeNull();
    expect(matchProjectRef("", candidates, slugify)).toBeNull();
    expect(matchProjectRef("   ", candidates, slugify)).toBeNull();
  });
});

describe("matchProjectRefAll", () => {
  it("returns EVERY basename collision, in candidate order (the two-topics-app case)", () => {
    const c: ProjectRefCandidate[] = [
      { path: "/Users/z/Projects/topics-app" },          // real repo (live topic binding)
      { path: "/Users/z/.openclaw/workspace/topics-app" }, // stale husk (dead June binding)
    ];
    expect(matchProjectRefAll("topics-app", c, slugify)).toEqual([
      "/Users/z/Projects/topics-app",
      "/Users/z/.openclaw/workspace/topics-app",
    ]);
  });

  it("dedupes repeated paths (many topics bound to the same repo)", () => {
    const c: ProjectRefCandidate[] = [
      { path: "/a/pix" },
      { path: "/a/pix" },
      { path: "/a/pix" },
    ];
    expect(matchProjectRefAll("pix", c, slugify)).toEqual(["/a/pix"]);
  });

  it("keeps tier strength: slug matches come before name, before basename", () => {
    const c: ProjectRefCandidate[] = [
      { path: "/base/pix" },                       // basename tier
      { path: "/named", name: "Pix" },             // name tier
      { path: "/slugged", slug: "pix" },           // slug tier
    ];
    expect(matchProjectRefAll("pix", c, slugify)).toEqual(["/slugged", "/named", "/base/pix"]);
  });

  it("matchProjectRef stays the first-of wrapper", () => {
    expect(matchProjectRef("pix", [{ path: "/a/pix" }, { path: "/b/pix" }], slugify)).toBe("/a/pix");
  });
});
