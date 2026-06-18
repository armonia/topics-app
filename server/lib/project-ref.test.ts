import { describe, expect, it } from "bun:test";
import { matchProjectRef, type ProjectRefCandidate } from "./project-ref";

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
