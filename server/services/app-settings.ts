/**
 * Global app-settings store (env-var audit, Phase B).
 *
 * A single row (migration 054) holding the behaviour TOGGLES promoted out of
 * env vars: default provider, per-provider model/effort/max-tokens, permission/
 * approval modes, and the claude-code enable flag. Secrets/bootstrap/build/test/
 * debug env vars are NOT here (see docs/ENV.md).
 *
 * Resolution everywhere is `setting ?? env ?? default`:
 *   • a value SET from the UI (non-null column) wins — the live control surface;
 *   • otherwise the env var is honoured as a fallback (unchanged bootstrap);
 *   • otherwise the built-in default.
 * Columns start NULL, so before the user touches Settings the behaviour is
 * byte-for-byte what it was when everything read env directly.
 *
 * The store degrades safely: if the DB isn't initialised (some unit tests, very
 * early boot) reads return an all-null row, so resolution falls straight through
 * to env → default and nothing throws.
 */

import { getDatabase } from "../db";

/** Config dei provider AI. Omonimo ma NON parente dell'`AppSettings` del
 *  client (`client/src/types/index.ts`), che sono le preferenze della UI. */
export interface AppSettings {
  aiProvider: string | null;
  claudeModel: string | null;
  claudeMaxTokens: number | null;
  claudeEffort: string | null;
  openaiModel: string | null;
  openaiMaxTokens: number | null;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  claudeCodePermissionMode: string | null;
  codexApprovalMode: string | null;
  claudeCodeEnabled: boolean | null;
}

const EMPTY: AppSettings = {
  aiProvider: null,
  claudeModel: null,
  claudeMaxTokens: null,
  claudeEffort: null,
  openaiModel: null,
  openaiMaxTokens: null,
  codexModel: null,
  codexReasoningEffort: null,
  claudeCodePermissionMode: null,
  codexApprovalMode: null,
  claudeCodeEnabled: null,
};

interface Row {
  ai_provider: string | null;
  claude_model: string | null;
  claude_max_tokens: number | null;
  claude_effort: string | null;
  openai_model: string | null;
  openai_max_tokens: number | null;
  codex_model: string | null;
  codex_reasoning_effort: string | null;
  claude_code_permission_mode: string | null;
  codex_approval_mode: string | null;
  claude_code_enabled: number | null;
}

function rowToSettings(r: Row): AppSettings {
  return {
    aiProvider: r.ai_provider ?? null,
    claudeModel: r.claude_model ?? null,
    claudeMaxTokens: r.claude_max_tokens ?? null,
    claudeEffort: r.claude_effort ?? null,
    openaiModel: r.openai_model ?? null,
    openaiMaxTokens: r.openai_max_tokens ?? null,
    codexModel: r.codex_model ?? null,
    codexReasoningEffort: r.codex_reasoning_effort ?? null,
    claudeCodePermissionMode: r.claude_code_permission_mode ?? null,
    codexApprovalMode: r.codex_approval_mode ?? null,
    claudeCodeEnabled:
      r.claude_code_enabled == null ? null : r.claude_code_enabled === 1,
  };
}

/** Read the singleton settings row. Returns all-null if the DB isn't ready. */
export function getAppSettings(): AppSettings {
  let db;
  try {
    db = getDatabase();
  } catch {
    return { ...EMPTY };
  }
  try {
    const row = db
      .query(
        `SELECT ai_provider, claude_model, claude_max_tokens, claude_effort,
                openai_model, openai_max_tokens, codex_model, codex_reasoning_effort,
                claude_code_permission_mode, codex_approval_mode, claude_code_enabled
           FROM app_settings WHERE id = 1`,
      )
      .get() as Row | null;
    return row ? rowToSettings(row) : { ...EMPTY };
  } catch {
    // Table missing (migration not applied in a bare test DB) → fall through.
    return { ...EMPTY };
  }
}

// Column map: JS key → SQL column. Also the allowlist of writable settings.
const COLUMNS: Record<keyof AppSettings, string> = {
  aiProvider: "ai_provider",
  claudeModel: "claude_model",
  claudeMaxTokens: "claude_max_tokens",
  claudeEffort: "claude_effort",
  openaiModel: "openai_model",
  openaiMaxTokens: "openai_max_tokens",
  codexModel: "codex_model",
  codexReasoningEffort: "codex_reasoning_effort",
  claudeCodePermissionMode: "claude_code_permission_mode",
  codexApprovalMode: "codex_approval_mode",
  claudeCodeEnabled: "claude_code_enabled",
};

/**
 * Patch the singleton row. Only keys present in `patch` are touched; pass an
 * explicit `null` to CLEAR a setting (revert to env/default). Unknown keys are
 * ignored. Returns the updated settings.
 */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDatabase();
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, col] of Object.entries(COLUMNS) as Array<[keyof AppSettings, string]>) {
    if (!(key in patch)) continue;
    const v = patch[key];
    sets.push(`${col} = ?`);
    if (key === "claudeCodeEnabled") {
      values.push(v == null ? null : v ? 1 : 0);
    } else {
      values.push((v as string | number | null) ?? null);
    }
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    db.query(`UPDATE app_settings SET ${sets.join(", ")} WHERE id = 1`).run(...values);
  }
  return getAppSettings();
}

// ---------------------------------------------------------------------------
// Resolvers: setting ?? env ?? default. One per promoted knob so call sites
// stay a single expression and the precedence lives in exactly one place.
// ---------------------------------------------------------------------------

function firstNonEmpty(...vals: Array<string | null | undefined>): string | undefined {
  for (const v of vals) {
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/** Default provider name: setting → AI_PROVIDER → undefined (caller decides). */
export function resolveAiProvider(s = getAppSettings()): string | undefined {
  return firstNonEmpty(s.aiProvider, process.env.AI_PROVIDER);
}

export function resolveClaudeModel(s = getAppSettings()): string | undefined {
  return firstNonEmpty(s.claudeModel, process.env.CLAUDE_MODEL);
}

export function resolveClaudeMaxTokens(s = getAppSettings()): number | undefined {
  if (s.claudeMaxTokens != null) return s.claudeMaxTokens;
  const env = process.env.CLAUDE_MAX_TOKENS;
  return env ? parseInt(env, 10) : undefined;
}

export function resolveOpenaiModel(s = getAppSettings()): string | undefined {
  return firstNonEmpty(s.openaiModel, process.env.OPENAI_MODEL);
}

export function resolveOpenaiMaxTokens(s = getAppSettings()): number | undefined {
  if (s.openaiMaxTokens != null) return s.openaiMaxTokens;
  const env = process.env.OPENAI_MAX_TOKENS;
  return env ? parseInt(env, 10) : undefined;
}

export function resolveCodexModel(s = getAppSettings()): string | undefined {
  return firstNonEmpty(s.codexModel, process.env.CODEX_MODEL);
}

export function resolveClaudeCodePermissionMode(s = getAppSettings()): string | undefined {
  return firstNonEmpty(s.claudeCodePermissionMode, process.env.CLAUDE_CODE_PERMISSION_MODE);
}

/** Codex approval mode, validated to the known union (auto|full-access). */
export function resolveCodexApprovalMode(
  s = getAppSettings(),
): "auto" | "full-access" | undefined {
  const raw = firstNonEmpty(s.codexApprovalMode, process.env.CODEX_APPROVAL_MODE);
  if (raw === "auto" || raw === "full-access") return raw;
  if (raw) {
    console.warn(
      `[app-settings] Ignoring invalid Codex approval mode '${raw}' (expected 'auto' | 'full-access')`,
    );
  }
  return undefined;
}

/**
 * Whether claude-code should be force-enabled. Setting wins; else the legacy
 * `CLAUDE_CODE_ENABLED === "true"` env. Returns false when neither forces it
 * (the caller still auto-detects the CLI).
 */
export function resolveClaudeCodeEnabled(s = getAppSettings()): boolean {
  if (s.claudeCodeEnabled != null) return s.claudeCodeEnabled;
  return process.env.CLAUDE_CODE_ENABLED === "true";
}

/** Claude effort override from settings (null when unset — env/config decide). */
export function settingClaudeEffort(s = getAppSettings()): string | null {
  return s.claudeEffort ?? null;
}

/** Codex reasoning-effort override from settings (null when unset). */
export function settingCodexReasoningEffort(s = getAppSettings()): string | null {
  return s.codexReasoningEffort ?? null;
}
