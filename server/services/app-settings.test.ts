/**
 * app-settings store + resolvers (env-var audit, Phase B).
 *
 * Proves the resolution chain `setting ?? env ?? default`:
 *   • a value SET from the UI (DB column) wins;
 *   • otherwise the env var is honoured;
 *   • otherwise the built-in default.
 * The DB is an in-memory copy of the real migrations so migration 054's schema
 * (and the singleton seed row) exist exactly as they will in production.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../db";
import {
  getAppSettings,
  updateAppSettings,
  resolveAiProvider,
  resolveClaudeModel,
  resolveClaudeMaxTokens,
  resolveCodexApprovalMode,
  resolveClaudeCodeEnabled,
  settingClaudeEffort,
} from "./app-settings";

let tmpRoot: string;
const ENV_KEYS = [
  "AI_PROVIDER", "CLAUDE_MODEL", "CLAUDE_MAX_TOKENS",
  "CODEX_APPROVAL_MODE", "CLAUDE_CODE_ENABLED",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "app-settings-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  process.env.DATA_DIR = join(tmpRoot, "data");
  initDatabase(tmpRoot);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // Reset every override so each test starts from a clean singleton row.
  updateAppSettings({
    aiProvider: null, claudeModel: null, claudeMaxTokens: null, claudeEffort: null,
    openaiModel: null, openaiMaxTokens: null, codexModel: null, codexReasoningEffort: null,
    claudeCodePermissionMode: null, codexApprovalMode: null, claudeCodeEnabled: null,
  });
});

describe("singleton row", () => {
  test("starts all-null (behaviour = env/default)", () => {
    const s = getAppSettings();
    expect(s.aiProvider).toBeNull();
    expect(s.claudeModel).toBeNull();
    expect(s.claudeCodeEnabled).toBeNull();
  });

  test("updateAppSettings persists and round-trips the boolean flag", () => {
    const s = updateAppSettings({ claudeCodeEnabled: true, claudeModel: "claude-opus-4-8" });
    expect(s.claudeCodeEnabled).toBe(true);
    expect(getAppSettings().claudeModel).toBe("claude-opus-4-8");
    updateAppSettings({ claudeCodeEnabled: false });
    expect(getAppSettings().claudeCodeEnabled).toBe(false);
  });
});

describe("resolution chain — setting ?? env ?? default", () => {
  test("default: neither set → undefined (caller default)", () => {
    expect(resolveClaudeModel()).toBeUndefined();
    expect(resolveAiProvider()).toBeUndefined();
  });

  test("env fallback: env set, no setting → env value", () => {
    process.env.CLAUDE_MODEL = "env-model";
    process.env.AI_PROVIDER = "openai";
    expect(resolveClaudeModel()).toBe("env-model");
    expect(resolveAiProvider()).toBe("openai");
  });

  test("setting wins over env (the UI is the live control surface)", () => {
    process.env.CLAUDE_MODEL = "env-model";
    process.env.AI_PROVIDER = "openai";
    updateAppSettings({ claudeModel: "ui-model", aiProvider: "claude-code" });
    expect(resolveClaudeModel()).toBe("ui-model");
    expect(resolveAiProvider()).toBe("claude-code");
  });

  test("clearing a setting reverts to env", () => {
    process.env.CLAUDE_MODEL = "env-model";
    updateAppSettings({ claudeModel: "ui-model" });
    expect(resolveClaudeModel()).toBe("ui-model");
    updateAppSettings({ claudeModel: null });
    expect(resolveClaudeModel()).toBe("env-model");
  });

  test("max-tokens: setting is a number, env parsed, default undefined", () => {
    expect(resolveClaudeMaxTokens()).toBeUndefined();
    process.env.CLAUDE_MAX_TOKENS = "4096";
    expect(resolveClaudeMaxTokens()).toBe(4096);
    updateAppSettings({ claudeMaxTokens: 8192 });
    expect(resolveClaudeMaxTokens()).toBe(8192);
  });

  test("claudeCodeEnabled: setting boolean wins over legacy env", () => {
    expect(resolveClaudeCodeEnabled()).toBe(false);
    process.env.CLAUDE_CODE_ENABLED = "true";
    expect(resolveClaudeCodeEnabled()).toBe(true);
    updateAppSettings({ claudeCodeEnabled: false });
    expect(resolveClaudeCodeEnabled()).toBe(false); // UI disable beats env=true
  });

  test("codex approval mode: invalid setting is ignored, valid wins", () => {
    process.env.CODEX_APPROVAL_MODE = "auto";
    expect(resolveCodexApprovalMode()).toBe("auto");
    updateAppSettings({ codexApprovalMode: "full-access" });
    expect(resolveCodexApprovalMode()).toBe("full-access");
  });

  test("effort setting surfaces as the override (null when unset)", () => {
    expect(settingClaudeEffort()).toBeNull();
    updateAppSettings({ claudeEffort: "medium" });
    expect(settingClaudeEffort()).toBe("medium");
  });
});

describe("la scelta del provider di default sopravvive a recomputeDefault", () => {
  // Il guasto: `PUT /api/providers/default` chiamava solo `setDefaultProvider`,
  // che assegna il `_defaultName` del PROCESSO. Senza riga in
  // `app_settings.ai_provider`, `resolveAiProvider()` torna undefined e
  // `recomputeDefault()` — che gira al boot E a ogni connect/disconnect —
  // considera il campo libero e ripesca "il migliore disponibile": la scelta si
  // perdeva al riavvio, e in sessione bastava un provider che andasse giu' e
  // tornasse per sovrascriverla.
  //
  // Questo test copre il pezzo che rende la persistenza EFFICACE: la riga
  // scritta deve alimentare `resolveAiProvider`, che e' l'unico ramo per cui
  // `recomputeDefault` tiene una scelta esplicita.
  test("scritta nelle settings, `resolveAiProvider` la riporta senza env", () => {
    expect(resolveAiProvider()).toBeUndefined();
    updateAppSettings({ aiProvider: "codex" });
    expect(resolveAiProvider()).toBe("codex");
  });

  test("la riga vince sull'env, cioe' la scelta dalla UI e' l'ultima parola", () => {
    process.env.AI_PROVIDER = "claude";
    updateAppSettings({ aiProvider: "claude-code" });
    expect(resolveAiProvider()).toBe("claude-code");
  });

  test("azzerata, si torna a cedere all'env", () => {
    process.env.AI_PROVIDER = "claude";
    updateAppSettings({ aiProvider: "claude-code" });
    updateAppSettings({ aiProvider: null });
    expect(resolveAiProvider()).toBe("claude");
  });
});
