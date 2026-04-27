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
          model: process.env.CLAUDE_CODE_MODEL || undefined,
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
      const config: CodexProviderConfig = {
        type: "codex",
        model: process.env.CODEX_MODEL || undefined,
        approvalMode: (process.env.CODEX_APPROVAL_MODE as any) || undefined,
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

  // Set default: explicit env, or first available
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit && _providers.has(explicit)) {
    _defaultName = explicit;
  } else if (!_defaultName && _providers.size > 0) {
    // Prefer openclaw for backwards compat, else first
    _defaultName = _providers.has("openclaw") ? "openclaw" : _providers.keys().next().value;
  }

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
