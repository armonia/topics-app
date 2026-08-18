import { describe, expect, test } from "bun:test";
import { defaultCdpPort } from "./browser-service";

/**
 * The CDP port used to be the constant 19222 for every server on the machine.
 * With the production server holding it, a test server that launched a
 * server-side Chromium died with `bind() failed: Address already in use (48)`
 * and Playwright SIGKILLed the launch, turning an unrelated spec red. These
 * cases pin the rule that makes that collision impossible, and the two
 * exemptions that keep production behaviour identical.
 */
describe("defaultCdpPort", () => {
  test("production keeps 19222, so the OpenClaw profile probe still finds it", () => {
    expect(defaultCdpPort({ BUN_PORT: "3333" })).toBe(19222);
    expect(defaultCdpPort({ PORT: "3333" })).toBe(19222);
  });

  test("a server that declares no port keeps 19222", () => {
    expect(defaultCdpPort({})).toBe(19222);
    expect(defaultCdpPort({ BUN_PORT: "" })).toBe(19222);
    expect(defaultCdpPort({ BUN_PORT: "not-a-number" })).toBe(19222);
  });

  test("every test-server port gets its own CDP port", () => {
    expect(defaultCdpPort({ BUN_PORT: "13334" })).toBe(19334);
    expect(defaultCdpPort({ BUN_PORT: "13335" })).toBe(19335);
    expect(defaultCdpPort({ BUN_PORT: "13400" })).toBe(19400);
  });

  test("the four shard ports of a local run never collide, with each other or with production", () => {
    const shards = ["13334", "13335", "13336", "13337"].map((p) => defaultCdpPort({ BUN_PORT: p }));
    expect(new Set(shards).size).toBe(shards.length);
    expect(shards).not.toContain(19222);
  });

  test("an explicit TOPICS_CDP_PORT wins, for the case the rule cannot foresee", () => {
    expect(defaultCdpPort({ BUN_PORT: "13334", TOPICS_CDP_PORT: "19999" })).toBe(19999);
    // A nonsense override falls back to the rule rather than to port 0.
    expect(defaultCdpPort({ BUN_PORT: "13334", TOPICS_CDP_PORT: "0" })).toBe(19334);
  });
});
