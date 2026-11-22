/**
 * Unit tests for `isTopicsSpawned`.
 * @covers PROCESS-11
 */
import { describe, it, expect } from "bun:test";
import { isTopicsSpawned } from "../../server/lib/ghost-script";

describe("isTopicsSpawned", () => {
  it("a manifest script, a run_command, and a row older than the field are Topics' own", () => {
    expect(isTopicsSpawned("script")).toBe(true);
    expect(isTopicsSpawned("command")).toBe(true);
    expect(isTopicsSpawned(undefined)).toBe(true);
  });

  it("a detected process and a shell of the CLI are somebody else's", () => {
    expect(isTopicsSpawned("detected")).toBe(false);
    expect(isTopicsSpawned("shell")).toBe(false);
  });
});
