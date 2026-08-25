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
 *
 * @covers CHAT-DEF-01, CHAT-DEF-02
 *
 * Chat works with no Settings toggle (CHAT-DEF-01) and the default provider is
 * honest and subscription-first (CHAT-DEF-02).
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
import { _resetCodexBinCache } from "../lib/codex-bin";

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
  // codex.connected keys off a resolvable codex binary, which is present on a
  // dev Mac but NOT on the Linux CI runner — that asymmetry made the "falls
  // back to codex" case pass locally and fail in CI. Pin CODEX_BIN to a file
  // that always exists so codex is deterministically connected here.
  let prevCodexBin: string | undefined;
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    prevCodexBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = process.execPath;
    _resetCodexBinCache();
    clearRegistry();
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
    if (prevCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevCodexBin;
    _resetCodexBinCache();
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
