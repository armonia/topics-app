/**
 * @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveProjectLimit } from "./project-limit";
import { effectiveLimit } from "../services/project-pause";

describe("project limit has a single source", () => {
  test("no row reads as no limit until 64b1f052, null stays 'no limit'", () => {
    expect(resolveProjectLimit("p", undefined)).toBeNull();
    expect(resolveProjectLimit("p", null)).toBeNull();
    expect(resolveProjectLimit("p", 25)).toBe(25);
  });
  test("the pause gate reads the same function", () => {
    expect(effectiveLimit(null)).toBeNull();
    const row = { projectId: "p", limit24hPct: null, pausedAt: null, continuedUntilPct: null, holdUntil: null };
    expect(effectiveLimit(row)).toBeNull();
  });
  test("no other module falls back to the default constant by itself", () => {
    for (const f of ["server/usage/project-quota.ts", "server/services/project-pause.ts"]) {
      const src = readFileSync(f, "utf-8");
      expect(src.includes("DEFAULT_QUOTA_LIMIT")).toBe(false);
    }
  });
});
