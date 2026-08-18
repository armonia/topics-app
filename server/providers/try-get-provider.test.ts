import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProvider, tryGetProvider } from "./index";

const REPO = join(import.meta.dir, "..", "..");

/**
 * `getProvider` throws on an unknown name. Seven call sites in server.ts were
 * written as `getProvider("claude-code") as { ... } | undefined`, a cast for a
 * return value it has never had, and three of them run inside `setInterval`
 * callbacks where an uncaught throw ends the process.
 *
 * It cost a red CI run on 2026-08-15: on a runner the only registered provider
 * is `openclaw`, so the stale-stream sweeper threw
 * `Provider "claude-code" not found. Available: openclaw` from a timer, Bun
 * exited 1, the test server vanished mid-run and 15 tests after it failed at
 * 0 ms with ECONNREFUSED. A user without the claude-code CLI would have hit the
 * same crash the first time a stream went quiet for three minutes.
 */
describe("tryGetProvider", () => {
  test("returns undefined for a name nobody registered, where getProvider throws", () => {
    expect(tryGetProvider("definitely-not-registered")).toBeUndefined();
    expect(() => getProvider("definitely-not-registered")).toThrow(/not found/);
  });

  test("returns undefined instead of throwing when nothing is registered at all", () => {
    // No provider and no default: `getProvider` has its own message for this and
    // it is still a throw. The point of the pair is that one of them copes.
    expect(tryGetProvider(undefined)).toBeUndefined();
  });
});

describe("server.ts asks for a provider it can live without", () => {
  const src = readFileSync(join(REPO, "server.ts"), "utf8");

  test("every optional-shaped claude-code lookup goes through tryGetProvider", () => {
    // The shape of the mistake, not a count: a `getProvider(...)` whose result is
    // immediately cast to an object of optional methods is a site that expects to
    // cope with absence, and `getProvider` does not let it.
    const optionalShaped = [...src.matchAll(/getProvider\("claude-code"\)\s+as\s+(unknown\s+as\s+)?\{/g)];
    const unsafe = optionalShaped.filter((m) => !src.slice(Math.max(0, m.index - 4), m.index).includes("try"));
    expect(unsafe.map((m) => src.slice(m.index, m.index + 60))).toEqual([]);
  });

  test("the stale-stream timer is one of them", () => {
    // The specific site that took the server down, named so a future edit that
    // moves it back cannot pass quietly.
    const timer = src.slice(src.indexOf("const staleStreamTimer"), src.indexOf("const staleStreamTimer") + 900);
    expect(timer).toContain('tryGetProvider("claude-code")');
    expect(timer).not.toContain('getProvider("claude-code") as');
  });
});
