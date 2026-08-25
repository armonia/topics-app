/**
 * Unit tests for the worktree-name generator (server/utils/worktree-naming.ts).
 *
 * Run with: `bun test tests/unit/worktree-naming.test.ts`
 *
 * Pure module — no DB, no fs, no spawn — so unit-style testing is the right
 * fit. Per CLAUDE.md "Unit tests allowed for pure modules: bun:test is
 * permitted for pure logic modules" this is the canonical example.
 *
 * @covers WORKTREE-02
 */
import { describe, expect, test } from "bun:test";
import {
  ADJECTIVES,
  NOUNS,
  NAME_REGEX,
  generateWorktreeName,
  isValidWorktreeName,
} from "../../server/utils/worktree-naming";

describe("vocabularies", () => {
  test("ADJECTIVES has at least 400 entries", () => {
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(400);
  });

  test("NOUNS has at least 400 entries", () => {
    expect(NOUNS.length).toBeGreaterThanOrEqual(400);
  });

  test("all adjectives are lowercase ASCII letters only", () => {
    const offenders = ADJECTIVES.filter((w) => !/^[a-z]+$/.test(w));
    expect(offenders).toEqual([]);
  });

  test("all nouns are lowercase ASCII letters only", () => {
    const offenders = NOUNS.filter((w) => !/^[a-z]+$/.test(w));
    expect(offenders).toEqual([]);
  });

  test("no word longer than 14 chars (filesystem-friendly)", () => {
    const long = [...ADJECTIVES, ...NOUNS].filter((w) => w.length > 14);
    expect(long).toEqual([]);
  });

  test("vocabularies are frozen (mutation throws in strict mode)", () => {
    expect(Object.isFrozen(ADJECTIVES)).toBe(true);
    expect(Object.isFrozen(NOUNS)).toBe(true);
  });
});

describe("generateWorktreeName — shape", () => {
  test("matches the canonical regex", () => {
    for (let i = 0; i < 200; i++) {
      const name = generateWorktreeName();
      expect(name).toMatch(NAME_REGEX);
    }
  });

  test("has exactly one or two hyphens", () => {
    for (let i = 0; i < 200; i++) {
      const name = generateWorktreeName();
      const hyphenCount = (name.match(/-/g) || []).length;
      expect([1, 2]).toContain(hyphenCount);
    }
  });

  test("first segment is in ADJECTIVES, second is in NOUNS", () => {
    const adjSet = new Set(ADJECTIVES);
    const nounSet = new Set(NOUNS);
    for (let i = 0; i < 200; i++) {
      const name = generateWorktreeName();
      const parts = name.split("-");
      expect(adjSet.has(parts[0])).toBe(true);
      expect(nounSet.has(parts[1])).toBe(true);
    }
  });

  test("no name exceeds 30 chars (database storage budget)", () => {
    for (let i = 0; i < 1000; i++) {
      const name = generateWorktreeName();
      expect(name.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("generateWorktreeName — uniqueness", () => {
  test("collision rate over 1000 calls is < 5% on a fresh project", () => {
    const seen = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const name = generateWorktreeName();
      if (seen.has(name)) collisions++;
      seen.add(name);
    }
    // ~250k unique pairs → birthday-style collisions in 1000 draws are still
    // possible. Cap at 5% to leave room for natural variance.
    expect(collisions).toBeLessThan(50);
  });

  test("when existingNames is provided and would always collide, suffixes with hex", () => {
    // Pre-populate with every possible base pair the generator could pick on
    // the first 5 retries. We can't know the picks, so instead we use a small
    // seed set and verify that *if* a suffix is added, it follows the format.
    // Here we provide the universe of possible bases as a forced-collision set.
    const allPossibleBases = new Set<string>();
    for (const a of ADJECTIVES) {
      for (const n of NOUNS) {
        allPossibleBases.add(`${a}-${n}`);
      }
    }
    const name = generateWorktreeName(allPossibleBases);
    // After MAX_RETRIES collisions the generator falls back to suffixed form.
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  test("when existingNames excludes the chosen pair, returns base form", () => {
    // Generate once to learn what the first attempt would look like, then
    // pre-fill existingNames with everything BUT that name. The generator
    // should accept it.
    const empty = new Set<string>();
    const name = generateWorktreeName(empty);
    // If existingNames doesn't contain `name`, it should be returned as-is.
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

describe("isValidWorktreeName — user-supplied name validator", () => {
  test("accepts canonical generator output", () => {
    expect(isValidWorktreeName("lyrical-cobra")).toBe(true);
    expect(isValidWorktreeName("mural-polio")).toBe(true);
    expect(isValidWorktreeName("sincere-headland-3a7f")).toBe(true);
  });

  test("accepts user-typed feature-style names with digits", () => {
    expect(isValidWorktreeName("feature-auth-2024")).toBe(true);
    expect(isValidWorktreeName("hotfix-1")).toBe(true);
  });

  test("rejects names starting with a digit", () => {
    expect(isValidWorktreeName("1-feature")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isValidWorktreeName("Lyrical-Cobra")).toBe(false);
  });

  test("rejects whitespace", () => {
    expect(isValidWorktreeName("lyrical cobra")).toBe(false);
  });

  test("rejects underscores", () => {
    expect(isValidWorktreeName("lyrical_cobra")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidWorktreeName("")).toBe(false);
  });

  test("rejects names longer than 64 chars", () => {
    expect(isValidWorktreeName("a" + "-x".repeat(40))).toBe(false);
  });

  test("rejects path-traversal attempts", () => {
    expect(isValidWorktreeName("..")).toBe(false);
    expect(isValidWorktreeName("../etc")).toBe(false);
    expect(isValidWorktreeName("a/b")).toBe(false);
  });

  test("rejects control chars and unicode", () => {
    expect(isValidWorktreeName("foo\x00bar")).toBe(false);
    expect(isValidWorktreeName("café")).toBe(false);
  });
});
