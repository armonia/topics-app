/**
 * Provider registry and barrel export.
 *
 * Multi-provider: all configured providers are initialized at startup.
 * Topics can use any registered provider; a default is configurable.
 *
 * Usage:
 *   import { initProviders, getProvider, getDefaultProvider, listProviders } from "./providers";
 *   initProviders();                     // auto-detect from env, init all
 *   getProvider("openclaw");             // get specific provider
 *   getDefaultProvider();                // get the default
 *   listProviders();                     // [{ name, connected, capabilities }]
 */

export * from "./types";

import type { AIProvider, ProviderConfig, OpenClawProviderConfig, ClaudeProviderConfig, ClaudeCodeProviderConfig, CodexProviderConfig, OpenAIProviderConfig } from "./types";
import { warnDeprecatedEnv } from "../lib/env-alias";

/**
 * Resolve the Claude-Code model id. `CLAUDE_CODE_MODEL` is a deprecated alias
 * of the canonical `CLAUDE_MODEL`: the old name still wins when set (so no
 * behaviour changes for existing setups) and warns once; `CLAUDE_MODEL` is the
 * shared fallback both providers now honour.
 */
function resolveClaudeCodeModel(): string | undefined {
  const legacy = process.env.CLAUDE_CODE_MODEL;
  if (legacy) {
    warnDeprecatedEnv("CLAUDE_CODE_MODEL", "CLAUDE_MODEL");
    return legacy;
  }
  return process.env.CLAUDE_MODEL || undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _providers = new Map<string, AIProvider>();
let _defaultName: string | undefined;

// ---------------------------------------------------------------------------
// Factory (single provider)
// ---------------------------------------------------------------------------

export function createProvider(config: ProviderConfig): AIProvider {
  switch (config.type) {
    case "openclaw": {
      const { OpenClawProvider } = require("./openclaw");
      return new OpenClawProvider(config);
    }
    case "claude": {
      const { ClaudeProvider } = require("./claude");
      return new ClaudeProvider(config);
    }
    case "claude-code": {
      const { ClaudeCodeProvider } = require("./claude-code");
      return new ClaudeCodeProvider(config);
    }
    case "codex": {
      const { CodexProvider } = require("./codex");
      return new CodexProvider(config);
    }
    case "openai": {
      const { OpenAIProvider } = require("./openai");
      return new OpenAIProvider(config);
    }
    default:
      throw new Error(`Unknown provider type: ${(config as any).type}`);
  }
}

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/** Get a specific provider by name */
export function getProvider(name?: string): AIProvider {
  const key = name ?? _defaultName;
  if (!key) {
    throw new Error("No provider specified and no default set. Call initProviders() first.");
  }
  const p = _providers.get(key);
  if (!p) {
    throw new Error(`Provider "${key}" not found. Available: ${[..._providers.keys()].join(', ')}`);
  }
  return p;
}

/** Get the default provider */
export function getDefaultProvider(): AIProvider {
  return getProvider(_defaultName);
}

/** Get default provider name */
export function getDefaultProviderName(): string | undefined {
  return _defaultName;
}

/** Set default provider */
export function setDefaultProvider(name: string): void {
  if (!_providers.has(name)) {
    throw new Error(`Provider "${name}" not registered`);
  }
  _defaultName = name;
}

/**
 * Re-evaluate the default provider based on current connectivity.
 *
 * Called at end of initProviders() and on connect/disconnect events so a chat
 * routed to "default" never silently dispatches to an offline provider. The
 * AI_PROVIDER env override is always honored if set; otherwise we keep the
 * current default if it's still connected, else pick the best available.
 *
 * Returns true if the default changed.
 */
export function recomputeDefault(): boolean {
  const previous = _defaultName;
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit && _providers.has(explicit)) {
    _defaultName = explicit;
    return _defaultName !== previous;
  }
  if (_providers.size === 0) return false;

  // Keep current default if it's still connected — avoids flapping.
  const currentOk = _defaultName && _providers.get(_defaultName)?.connected === true;
  if (currentOk) return false;

  // Preference order — subscription-first: prefer the providers whose usage is
  // included in the user's Claude/ChatGPT subscription (the local `claude-code`
  // and `codex` CLIs) over the metered API-key paths (`claude` SDK, `openai`),
  // and keep `openclaw` last so a flaky gateway never silently becomes the
  // default chat target. This only picks the *fallback* default when the
  // previous one is offline; an explicit `AI_PROVIDER` env and per-topic
  // `provider` always win over this order.
  const PROVIDER_PREFERENCE_ORDER = [
    "claude-code",
    "codex",
    "claude",
    "openai",
    "openclaw",
  ];
  const preferred = PROVIDER_PREFERENCE_ORDER.find(
    (name) => _providers.get(name)?.connected === true,
  );
  if (preferred) {
    _defaultName = preferred;
  } else {
    // Nothing connected — keep current default if any, else fall back to the
    // first registered provider so getProvider() doesn't throw on boot.
    const firstConnected = [..._providers.entries()].find(([, p]) => p.connected)?.[0];
    _defaultName = firstConnected ?? _defaultName ?? _providers.keys().next().value;
  }
  return _defaultName !== previous;
}

/** List all registered providers with status */
export function listProviders(): Array<{
  name: string;
  connected: boolean;
  capabilities: string[];
  isDefault: boolean;
}> {
  return [..._providers.entries()].map(([name, p]) => ({
    name,
    connected: p.connected,
    capabilities: [...p.capabilities],
    isDefault: name === _defaultName,
  }));
}

/** Register and start a provider at runtime (e.g., from settings UI) */
export function registerProvider(config: ProviderConfig): AIProvider {
  const existing = _providers.get(config.type);
  if (existing) {
    existing.stop();
    _providers.delete(config.type);
  }
  const provider = createProvider(config);
  provider.start();
  _providers.set(provider.name, provider);
  // Refresh the snapshot row for this provider — fires `change`, drives WS push.
  void invalidateSnapshot(provider.name);
  return provider;
}

/** Remove a provider */
export function removeProvider(name: string): void {
  const p = _providers.get(name);
  if (p) {
    p.stop();
    _providers.delete(name);
    if (_defaultName === name) {
      _defaultName = _providers.keys().next().value;
    }
    void invalidateSnapshot(name);
  }
}

/**
 * Stop ALL providers — called from gracefulShutdown so spawned children
 * (claude CLI, codex CLI, etc.) receive SIGTERM and get a chance to flush
 * their on-disk session state. Without this, `bun --watch` hot-reloads
 * left zombie children behind AND lost claude-code conversation context
 * because the CLI hadn't checkpointed before being orphaned.
 *
 * Returns a promise that resolves once all providers have signalled their
 * children. Each provider's `stop()` schedules SIGKILL after a grace period
 * internally; we wait for that grace period before resolving so the caller
 * can safely process.exit() without truncating the flush.
 */
export async function stopAllProviders(graceMs = 3500): Promise<void> {
  for (const [, p] of _providers) {
    try { p.stop(); } catch (err: any) { console.warn(`[Providers] stop() failed:`, err?.message ?? err); }
  }
  await new Promise((r) => setTimeout(r, graceMs));
}

/**
 * Lazy import of the snapshot manager — avoids a circular import at module
 * load time (snapshot-manager → index → snapshot-manager).
 */
function invalidateSnapshot(name: string): void {
  try {
    const { getSnapshotManager } = require("./snapshot-manager") as typeof import("./snapshot-manager");
    getSnapshotManager().invalidate(name);
  } catch {
    // Manager not loaded yet — nothing to invalidate.
  }
}

// ---------------------------------------------------------------------------
// Init all providers from env
// ---------------------------------------------------------------------------

export async function initProviders(): Promise<AIProvider[]> {
  const started: AIProvider[] = [];

  // OpenClaw — init if GATEWAY_URL is set
  if (process.env.GATEWAY_URL && process.env.GATEWAY_TOKEN) {
    try {
      const config: OpenClawProviderConfig = {
        type: "openclaw",
        gatewayUrl: process.env.GATEWAY_URL,
        token: process.env.GATEWAY_TOKEN,
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init openclaw: ${err.message}`);
    }
  }

  // Claude — init if ANTHROPIC_API_KEY is set
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const config: ClaudeProviderConfig = {
        type: "claude",
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL || undefined,
        maxTokens: process.env.CLAUDE_MAX_TOKENS
          ? parseInt(process.env.CLAUDE_MAX_TOKENS, 10)
          : undefined,
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init claude: ${err.message}`);
    }
  }

  // Claude Code — auto-detect (CLI installed). Legacy CLAUDE_CODE_ENABLED still works.
  if (!_providers.has("claude-code")) {
    const explicitlyEnabled = process.env.CLAUDE_CODE_ENABLED === "true";
    const cliAvailable = await detectClaudeCodeCli();
    if (explicitlyEnabled || cliAvailable) {
      try {
        const config: ClaudeCodeProviderConfig = {
          type: "claude-code",
          // `CLAUDE_CODE_MODEL` is a deprecated alias of the canonical
          // `CLAUDE_MODEL`; both name the Claude model id. The old name still
          // wins when set (no behaviour change for existing setups) and warns
          // once; `CLAUDE_MODEL` is the new shared fallback.
          model: resolveClaudeCodeModel() || undefined,
          permissionMode: process.env.CLAUDE_CODE_PERMISSION_MODE || undefined,
          defaultWorkspace: process.env.CLAUDE_CODE_WORKSPACE || undefined,
        };
        const p = createProvider(config);
        p.start();
        _providers.set(p.name, p);
        started.push(p);
      } catch (err: any) {
        console.warn(`[Providers] Failed to init claude-code: ${err.message}`);
      }
    }
  }

  // Codex — auto-detect (CLI installed or Codex.app present)
  if (!_providers.has("codex") && await detectCodexCli()) {
    try {
      // Validate against the known union instead of `as any` — a typo like
      // CODEX_APPROVAL_MODE=full_access would otherwise pass through as a
      // fake-valid value and SILENTLY downgrade Codex to sandboxed (the
      // consumer only grants full access on an exact "full-access" match).
      const rawApprovalMode = process.env.CODEX_APPROVAL_MODE;
      const approvalMode = rawApprovalMode === "auto" || rawApprovalMode === "full-access" ? rawApprovalMode : undefined;
      if (rawApprovalMode && !approvalMode) {
        console.warn(`[Providers] Ignoring invalid CODEX_APPROVAL_MODE=${rawApprovalMode} (expected 'auto' | 'full-access')`);
      }
      const config: CodexProviderConfig = {
        type: "codex",
        model: process.env.CODEX_MODEL || undefined,
        approvalMode,
        defaultWorkspace: process.env.CODEX_WORKSPACE || undefined,
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init codex: ${err.message}`);
    }
  }

  // OpenAI — init if OPENAI_API_KEY is set
  if (!_providers.has("openai") && process.env.OPENAI_API_KEY) {
    try {
      const config: OpenAIProviderConfig = {
        type: "openai",
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || undefined,
        maxTokens: process.env.OPENAI_MAX_TOKENS
          ? parseInt(process.env.OPENAI_MAX_TOKENS, 10)
          : undefined,
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init openai: ${err.message}`);
    }
  }

  // Pick a sensible default: explicit env wins; otherwise prefer a CONNECTED
  // provider so chat routes don't silently dispatch to an offline gateway.
  // Without re-evaluation, "openclaw" wins backwards-compat priority even
  // when its gateway is unreachable, and every /api/chat call returns
  // "Gateway unreachable" or an empty SSE stream — surfaced in the UI as
  // "No response received" / generic error. recomputeDefault() ignores the
  // legacy `!_defaultName` gate so the explicit-config path in initProvider()
  // (which pre-sets `_defaultName` to e.g. "openclaw" before the WS even
  // attempts to connect) gets re-evaluated against actual connectivity.
  recomputeDefault();

  if (started.length === 0) {
    console.warn("[Providers] No providers configured. Set GATEWAY_URL+GATEWAY_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, or install codex/claude-code CLIs.");
  }

  return started;
}

// --- Auto-detect helpers ---

async function detectClaudeCodeCli(): Promise<boolean> {
  // Avoid hard import cost if Bun.which already says no
  if (Bun.which("claude")) return true;
  // Check the version-managed install path used by claude-code provider
  try {
    const { existsSync } = require("fs");
    const home = process.env.HOME || "";
    if (existsSync(`${home}/.local/bin/claude`)) return true;
    if (existsSync(`${home}/.local/share/claude/versions`)) return true;
  } catch {}
  return false;
}

async function detectCodexCli(): Promise<boolean> {
  if (process.env.CODEX_BIN) return true;
  if (Bun.which("codex")) return true;
  try {
    const { existsSync } = require("fs");
    const home = process.env.HOME || "";
    if (existsSync("/Applications/Codex.app/Contents/Resources/codex")) return true;
    if (existsSync(`${home}/Applications/Codex.app/Contents/Resources/codex`)) return true;
  } catch {}
  return false;
}

// ---------------------------------------------------------------------------
// Legacy compat — initProvider / getProvider work as before
// ---------------------------------------------------------------------------

/**
 * Legacy single-provider init. Starts the explicit `config` as the default,
 * then asynchronously auto-detects and registers all other available providers
 * (codex, openai, claude-code, etc.) so the picker UI sees them.
 */
export function initProvider(config?: ProviderConfig): AIProvider {
  if (config) {
    // Stop the previous instance if one already exists for this provider
    // type. Without this, a second `initProvider()` call (e.g. on hot
    // reload, or a settings-driven re-init) would leak the old instance —
    // its inactivity timers kept firing and `claude-code` would keep two
    // pools alive, each spawning their own `--resume` child for the same
    // sessionKey. That double-spawn corrupted the on-disk session file.
    const existing = _providers.get(config.type);
    if (existing) {
      try { existing.stop(); } catch (err: any) {
        console.warn(`[Providers] Failed to stop previous ${config.type} instance: ${err?.message ?? err}`);
      }
      _providers.delete(config.type);
    }
    const p = createProvider(config);
    p.start();
    _providers.set(p.name, p);
    if (!_defaultName) _defaultName = p.name;
    // Fire-and-forget: register any other auto-detected providers in the
    // background. Errors are logged but don't block startup.
    initProviders().catch((err) => {
      console.warn(`[Providers] Background auto-detect failed: ${err?.message ?? err}`);
    });
    return p;
  }
  // Sync caller without config: initialize providers eagerly via a deferred init.
  // We can't await here, so bootstrap and return whatever we can synchronously.
  void initProviders();
  return getDefaultProvider();
}
