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

import type { AIProvider, ProviderConfig, OpenClawProviderConfig, ClaudeProviderConfig, ClaudeCodeProviderConfig } from "./types";

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

export function initProviders(): AIProvider[] {
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

  // Claude Code — init if CLAUDE_CODE_ENABLED is set
  if (process.env.CLAUDE_CODE_ENABLED === "true") {
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

  // Set default: explicit env, or first available
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit && _providers.has(explicit)) {
    _defaultName = explicit;
  } else if (_providers.size > 0) {
    // Prefer openclaw for backwards compat, else first
    _defaultName = _providers.has("openclaw") ? "openclaw" : _providers.keys().next().value;
  }

  if (started.length === 0) {
    console.warn("[Providers] No providers configured. Set GATEWAY_URL+GATEWAY_TOKEN and/or ANTHROPIC_API_KEY");
  }

  return started;
}

// ---------------------------------------------------------------------------
// Legacy compat — initProvider / getProvider work as before
// ---------------------------------------------------------------------------

/** @deprecated Use initProviders() instead */
export function initProvider(config?: ProviderConfig): AIProvider {
  if (config) {
    const p = createProvider(config);
    p.start();
    _providers.set(p.name, p);
    if (!_defaultName) _defaultName = p.name;
    return p;
  }
  const started = initProviders();
  return started[0] ?? (() => { throw new Error("No providers configured"); })();
}
