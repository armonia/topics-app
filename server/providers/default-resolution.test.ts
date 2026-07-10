/**
 * Default-provider resolution — the chat-subscription-default fix.
 *
 * Two behaviors guard "chat works out of the box without a Settings toggle":
 *   1. A `claude` (SDK) provider with no usable API key must report
 *      `connected === false`, so `recomputeDefault()` never keeps it as the
 *      default (a keyless SDK client 401s → "No response received").
 *   2. `recomputeDefault()` prefers the subscription-backed CLI providers
 *      (`claude-code`, then `codex`) over the metered API paths, while still
 *      honoring an explicit `AI_PROVIDER` override.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ClaudeProvider } from "./claude";
import {
  registerProvider,
  removeProvider,
  recomputeDefault,
  getDefaultProviderName,
  listProviders,
} from "./index";

function clearRegistry() {
  for (const { name } of listProviders()) removeProvider(name);
}

describe("ClaudeProvider.connected", () => {
  test("is false when constructed without a usable API key", () => {
    const p = new ClaudeProvider({ type: "claude", apiKey: "" });
    p.start();
    expect(p.connected).toBe(false);
  });

  test("is true once a non-empty API key is present", () => {
    const p = new ClaudeProvider({ type: "claude", apiKey: "sk-ant-test" });
    p.start();
    expect(p.connected).toBe(true);
  });
});

describe("recomputeDefault — subscription-first", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    clearRegistry();
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
    clearRegistry();
  });

  test("a keyless claude is not chosen as default when claude-code is ready", () => {
    registerProvider({ type: "claude", apiKey: "" });
    registerProvider({ type: "claude-code" });
    recomputeDefault();
    // Keyless claude is disconnected → subscription-backed claude-code wins.
    expect(getDefaultProviderName()).toBe("claude-code");
    const claude = listProviders().find((p) => p.name === "claude");
    expect(claude?.connected).toBe(false);
  });

  test("prefers claude-code over a keyed (metered) claude", () => {
    registerProvider({ type: "claude", apiKey: "sk-ant-test" });
    registerProvider({ type: "claude-code" });
    registerProvider({ type: "codex" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude-code");
  });

  test("falls back to codex when claude-code is absent", () => {
    registerProvider({ type: "claude", apiKey: "" });
    registerProvider({ type: "codex" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("codex");
  });

  test("explicit AI_PROVIDER override always wins", () => {
    process.env.AI_PROVIDER = "claude";
    registerProvider({ type: "claude", apiKey: "sk-ant-test" });
    registerProvider({ type: "claude-code" });
    recomputeDefault();
    expect(getDefaultProviderName()).toBe("claude");
  });
});
