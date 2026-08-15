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
import { warnDeprecatedEnv } from "../lib/env-alias";
import {
  OUTPUT_LANGUAGES,
  type OutputLanguage,
  DISCORD_DETAIL_LEVELS,
  type DiscordDetailLevel,
  AGENT_RUNTIMES,
  type AgentRuntime,
} from "../../shared/types";

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
  /** La lingua in cui il modello deve rispondere (migration 087). NULL = «auto»,
   *  cioè nessuna direttiva: il modello sceglie come ha sempre fatto. */
  outputLanguage: string | null;
  /** Topics pubblica il tuo stato su Discord (migration 102). NULL = mai
   *  toccato = SPENTO: si veda il commento della migration sul perché il
   *  default non può essere acceso. */
  discordPresenceEnabled: boolean | null;
  /** Quanto di quello stato si vede (`DiscordDetailLevel`). NULL = il default
   *  del codice, `activity`. */
  discordDetailLevel: string | null;
  /** Con quale meccanica si esegue un agente: `cli` (una CLI per sessione) o
   *  `jcode` (sessioni ACP dentro un demone condiviso). NULL = mai toccato =
   *  `cli`, il sistema storico. Vedi la migration `agent-runtime` per i numeri
   *  che giustificano l'esistenza dell'interruttore. */
  agentRuntime: string | null;
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
  outputLanguage: null,
  discordPresenceEnabled: null,
  discordDetailLevel: null,
  agentRuntime: null,
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
  output_language: string | null;
  discord_presence_enabled: number | null;
  discord_detail_level: string | null;
  agent_runtime: string | null;
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
    outputLanguage: r.output_language ?? null,
    discordPresenceEnabled:
      r.discord_presence_enabled == null ? null : r.discord_presence_enabled === 1,
    discordDetailLevel: r.discord_detail_level ?? null,
    agentRuntime: r.agent_runtime ?? null,
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
                claude_code_permission_mode, codex_approval_mode, claude_code_enabled,
                output_language, discord_presence_enabled, discord_detail_level,
                agent_runtime
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
  outputLanguage: "output_language",
  discordPresenceEnabled: "discord_presence_enabled",
  discordDetailLevel: "discord_detail_level",
  agentRuntime: "agent_runtime",
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
    // I booleani vanno in colonne INTEGER: l'elenco è quello, e va tenuto
    // insieme al tipo — un `boolean` finito qui senza conversione entra in
    // SQLite come… niente, perché bun:sqlite non lega un bool.
    if (key === "claudeCodeEnabled" || key === "discordPresenceEnabled") {
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

/**
 * Il modello di claude-code. Stava dentro `providers/index.ts` come helper
 * privato, quindi era leggibile SOLO alla costruzione del provider: cambiare il
 * default in Impostazioni non aveva effetto fino al riavvio del server. Qui sta
 * accanto ai suoi fratelli ed è chiamabile anche allo spawn, come già fa
 * `resolveClaudeEffort`.
 *
 * `CLAUDE_CODE_MODEL` è un alias deprecato di `CLAUDE_MODEL`: si onora ancora,
 * con l'avviso una-tantum, ma perde contro la scelta esplicita in Impostazioni.
 */
export function resolveClaudeCodeModel(s = getAppSettings()): string | undefined {
  if (s.claudeModel) return s.claudeModel;
  const legacy = process.env.CLAUDE_CODE_MODEL;
  if (legacy) {
    warnDeprecatedEnv("CLAUDE_CODE_MODEL", "CLAUDE_MODEL");
    return legacy;
  }
  return process.env.CLAUDE_MODEL || undefined;
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

/**
 * La lingua in cui il modello deve rispondere (migration 087).
 *
 * A differenza dei fratelli qui sopra NON ha un env di ripiego, di proposito:
 * è una preferenza di persona, presa da un selettore, non un parametro di
 * bootstrap — e un `TOPICS_OUTPUT_LANGUAGE` nell'ambiente di launchd sarebbe
 * una seconda verità che nessuno vede in Impostazioni.
 *
 * Un valore fuori scala (riga scritta a mano, DB di un'altra versione) torna
 * `'auto'`: sbagliare lingua è peggio che non sceglierne una.
 */
export function resolveOutputLanguage(s = getAppSettings()): OutputLanguage {
  const raw = (s.outputLanguage ?? "").trim().toLowerCase();
  return (OUTPUT_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as OutputLanguage)
    : "auto";
}

/**
 * Topics pubblica il tuo stato su Discord? (migration 102)
 *
 * Come `resolveOutputLanguage`, e per lo stesso motivo, NON ha un env di
 * ripiego: è una scelta di persona presa da un interruttore, e un
 * `TOPICS_DISCORD_PRESENCE` nell'ambiente di launchd sarebbe una seconda verità
 * che non compare in Impostazioni. Non deciso = spento, che è l'unico default
 * accettabile per qualcosa che parla di te a degli sconosciuti.
 */
export function resolveDiscordPresenceEnabled(s = getAppSettings()): boolean {
  return s.discordPresenceEnabled === true;
}

/**
 * Quanto di quello stato si vede. Un valore fuori scala (riga scritta a mano,
 * DB di un'altra versione) NON cade su `detailed`: cade sul livello di mezzo,
 * che è il default. Sbagliare verso il più riservato è l'unico verso in cui un
 * controllo di privacy può sbagliare.
 */
export function resolveDiscordDetailLevel(s = getAppSettings()): DiscordDetailLevel {
  const raw = (s.discordDetailLevel ?? "").trim().toLowerCase();
  return (DISCORD_DETAIL_LEVELS as readonly string[]).includes(raw)
    ? (raw as DiscordDetailLevel)
    : "activity";
}

/**
 * Con quale meccanica si esegue un agente: `cli` o `jcode`.
 *
 * Ha un env di ripiego, al contrario dei due qui sopra, e la differenza è
 * voluta: lingua e presence sono preferenze di PERSONA, questa è una scelta di
 * MACCHINA. Un `TOPICS_AGENT_RUNTIME=jcode` nell'ambiente è esattamente ciò che
 * serve per misurare le due meccaniche una contro l'altra (il bench lancia il
 * server con il suo ambiente, non con il DB dell'utente) e per portare la
 * scelta su una macchina piccola senza aprire la UI.
 *
 * L'impostazione VINCE sull'env: chi ha scelto in Impostazioni ha scelto dopo.
 *
 * Un valore fuori scala (riga a mano, DB di un'altra versione, env con un
 * refuso) cade su `cli`. È il verso giusto in cui sbagliare: `cli` è il sistema
 * che c'è sempre stato, mentre cadere su `jcode` manderebbe un agente su un
 * runtime che chi ha scritto quel refuso non ha chiesto.
 */
export function resolveAgentRuntime(s = getAppSettings()): AgentRuntime {
  const raw = (s.agentRuntime ?? process.env.TOPICS_AGENT_RUNTIME ?? "")
    .trim()
    .toLowerCase();
  return (AGENT_RUNTIMES as readonly string[]).includes(raw)
    ? (raw as AgentRuntime)
    : "cli";
}
