/**
 * THE SNAPSHOT CARRIES THE CLAUDE PLAN, AND NO CREDENTIAL.
 *
 * `GET /api/providers/snapshot` is what the user menu reads for the tail of
 * «AI providers». The Claude Code row gains `subscription` (two labels), and
 * so does the `topics` row (the default runtime, signed in with the same
 * credentials); the
 * credentials file it is read from holds the tokens too. The whole snapshot,
 * serialized as the route sends it, must not contain either token.
 *
 * @covers USERMENU-10
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code";
import { NativeProvider } from "./native/provider";
import { registerProvider, removeProvider } from "./index";
import { ProviderSnapshotManager } from "./snapshot-manager";

const ACCESS = "sk-ant-oat01-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"; // allow-secret: a made-up token, the fixture the test looks for
const REFRESH = "sk-ant-ort01-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"; // allow-secret: a made-up token, the fixture the test looks for
const saved = { home: process.env.HOME, keychain: process.env.TOPICS_CREDENTIALS_KEYCHAIN };
const undo: Array<() => void> = [];

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "topics-snapshot-plan-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: Date.now() + 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  }));
  process.env.HOME = home;
  process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
});

afterEach(() => {
  removeProvider("claude-code");
  removeProvider("topics");
  for (const fn of undo.splice(0).reverse()) fn();
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.keychain === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
  else process.env.TOPICS_CREDENTIALS_KEYCHAIN = saved.keychain;
});

test("the Claude Code row says the plan, and the serialized snapshot holds no token", async () => {
  // The real provider object, with start and probes inert.
  const start = spyOn(ClaudeCodeProvider.prototype, "start").mockImplementation(() => {});
  const provider = registerProvider({ type: "claude-code" });
  start.mockRestore();
  const diagnose = spyOn(provider, "diagnose").mockResolvedValue({ name: "claude-code", status: "ready", requirements: [] });
  const models = spyOn(provider, "listModels").mockResolvedValue(["claude-test"]);
  undo.push(() => diagnose.mockRestore(), () => models.mockRestore());

  const manager = new ProviderSnapshotManager();
  await manager.refresh("claude-code");
  const snapshot = manager.getSnapshot();
  const row = snapshot.providers.find((p) => p.name === "claude-code");

  expect(row?.subscription).toEqual({ type: "max", tier: "default_claude_max_20x" });
  const wire = JSON.stringify(snapshot);
  expect(wire).not.toContain(ACCESS);
  expect(wire).not.toContain(REFRESH);
  expect(wire).not.toMatch(/sk-ant|accessToken|refreshToken|credentials\.json/);
});

test("the topics row, the default runtime on the same credentials, says the same plan", async () => {
  // Without this the tail named the plan only when Claude Code was the
  // default, and the default runtime is `topics` (DEFAULT_AGENT_RUNTIME).
  const start = spyOn(NativeProvider.prototype, "start").mockImplementation(() => {});
  const provider = registerProvider({ type: "native" });
  start.mockRestore();
  const diagnose = spyOn(provider, "diagnose").mockResolvedValue({ name: "topics", status: "ready", requirements: [] });
  undo.push(() => diagnose.mockRestore());

  const manager = new ProviderSnapshotManager();
  await manager.refresh("topics");
  const snapshot = manager.getSnapshot();
  const row = snapshot.providers.find((p) => p.name === "topics");

  expect(row?.subscription).toEqual({ type: "max", tier: "default_claude_max_20x" });
  const wire = JSON.stringify(snapshot);
  expect(wire).not.toContain(ACCESS);
  expect(wire).not.toContain(REFRESH);
});
