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

import type { AIProvider, ProviderConfig, OpenClawProviderConfig, ClaudeProviderConfig, ClaudeCodeProviderConfig, CodexProviderConfig, OpenAIProviderConfig, AcpProviderConfig } from "./types";
import { providerNameForConfig } from "./types";
import { KNOWN_ACP_AGENTS, mergeAcpAgents, parseAcpAgentsEnv } from "./acp/agents";
import { warnDeprecatedEnv } from "../lib/env-alias";
import {
  getAppSettings,
  resolveAiProvider,
  resolveClaudeModel,
  resolveClaudeMaxTokens,
  resolveOpenaiModel,
  resolveOpenaiMaxTokens,
  resolveCodexModel,
  resolveClaudeCodeModel,
  resolveClaudeCodePermissionMode,
  resolveCodexApprovalMode,
  resolveClaudeCodeEnabled,
  type AppSettings,
} from "../services/app-settings";


// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _providers = new Map<string, AIProvider>();
let _defaultName: string | undefined;

/**
 * L'ordine con cui si sceglie un default di RIPIEGO fra i provider che
 * conosciamo per nome. Chi non è qui dentro non è escluso: cade dopo (vedi
 * `recomputeDefault`).
 */
const PROVIDER_PREFERENCE_ORDER = [
  "claude-code",
  "codex",
  "claude",
  "openai",
  "openclaw",
];

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
    case "acp": {
      // UN provider per TUTTI gli agenti che parlano ACP: `config.name` decide
      // quale. È il punto della fase 3 — il prossimo agente costa una riga in
      // `acp/agents.ts`, non un file qui.
      const { AcpProvider } = require("./acp");
      return new AcpProvider(config);
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

/**
 * The provider if it is registered, `undefined` if it is not.
 *
 * `getProvider` THROWS on an unknown name, and seven call sites in `server.ts`
 * believed otherwise: they were written as
 * `getProvider("claude-code") as { ... } | undefined`, a cast that describes a
 * return value this function has never had. On this machine the lie was
 * invisible, because the claude-code CLI is installed and therefore registered.
 *
 * It stopped being invisible on 2026-08-15: on a CI runner the only registered
 * provider is `openclaw`, the stale-stream sweeper called it from inside a
 * `setInterval`, and an uncaught throw in a timer callback takes the whole
 * process down. The test server died with `Provider "claude-code" not found.
 * Available: openclaw` and every test after it failed at 0 ms with
 * ECONNREFUSED. The same thing would happen to any USER without that CLI, once
 * a stream went quiet for three minutes.
 *
 * So: one accessor for "ask, and cope with no", next to the one that means
 * "this must exist". The optional-method casts at those call sites are then
 * honest, because the object really can be absent.
 */
export function tryGetProvider(name?: string): AIProvider | undefined {
  const key = name ?? _defaultName;
  if (!key) return undefined;
  return _providers.get(key);
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
  // Explicit default: a Settings override wins, else the AI_PROVIDER env.
  const explicit = resolveAiProvider()?.toLowerCase();
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
  //
  // È l'ordine dei NOTI, non l'elenco degli ammessi. Era una lista di cinque
  // nomi a mano, e nessun agente ACP ci stava dentro: gemini non poteva MAI
  // diventare il default automatico nemmeno essendo l'unico connesso, perché
  // `find` non lo trovava e finiva nel ramo di ripiego qui sotto — che sceglie
  // il primo connesso in ordine di REGISTRAZIONE, cioè per caso. Ora chi non è
  // in tabella cade DOPO i noti e PRIMA dell'ultimo ripiego: resta fuori dalla
  // preferenza esplicita, ma dentro la graduatoria.
  const preferred = PROVIDER_PREFERENCE_ORDER.find(
    (name) => _providers.get(name)?.connected === true,
  );
  const unknownConnected = [..._providers.entries()].find(
    ([name, p]) => p.connected === true && !PROVIDER_PREFERENCE_ORDER.includes(name),
  )?.[0];
  const chosen = preferred ?? unknownConnected;
  if (chosen) {
    _defaultName = chosen;
  } else {
    // Nothing connected — keep current default if any, else fall back to the
    // first registered provider so getProvider() doesn't throw on boot.
    _defaultName = _defaultName ?? _providers.keys().next().value;
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
  // Si deduplica sul NOME, non sul type: gli agenti ACP condividono tutti
  // `type: "acp"`, e su `type` il secondo registrato spegnerebbe il primo.
  const name = providerNameForConfig(config);
  const existing = _providers.get(name);
  if (existing) {
    existing.stop();
    _providers.delete(name);
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

  // Snapshot the promoted behaviour toggles once (setting ?? env ?? default).
  // Reading the row up-front keeps a single DB hit for the whole init pass.
  const settings = getAppSettings();

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
        model: resolveClaudeModel(settings),
        maxTokens: resolveClaudeMaxTokens(settings),
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
    const explicitlyEnabled = resolveClaudeCodeEnabled(settings);
    const cliAvailable = await detectClaudeCodeCli();
    if (explicitlyEnabled || cliAvailable) {
      try {
        const config: ClaudeCodeProviderConfig = {
          type: "claude-code",
          // Model: a settings override wins; else `CLAUDE_CODE_MODEL` (deprecated
          // alias of the canonical `CLAUDE_MODEL`, still honoured with a one-time
          // warning); else `CLAUDE_MODEL`.
          model: resolveClaudeCodeModel(settings) || undefined,
          permissionMode: resolveClaudeCodePermissionMode(settings),
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
      // Approval mode is validated to the known union (auto|full-access) inside
      // the resolver — a typo like full_access must not SILENTLY downgrade Codex
      // to sandboxed (the consumer only grants full access on an exact match).
      const config: CodexProviderConfig = {
        type: "codex",
        model: resolveCodexModel(settings),
        approvalMode: resolveCodexApprovalMode(settings),
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
        model: resolveOpenaiModel(settings),
        maxTokens: resolveOpenaiMaxTokens(settings),
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init openai: ${err.message}`);
    }
  }

  // Agenti ACP — la tabella nota più quelli dichiarati in ACP_AGENTS. Si
  // registra solo chi ha l'eseguibile al suo posto: un provider che non può
  // partire riempirebbe il picker di voci morte.
  for (const spec of resolveAcpAgents()) {
    if (_providers.has(spec.name)) continue;
    if (!spec.command.includes("/") && !Bun.which(spec.command)) continue;
    try {
      const config: AcpProviderConfig = {
        type: "acp",
        ...spec,
        defaultWorkspace: process.env.ACP_WORKSPACE || undefined,
      };
      const p = createProvider(config);
      p.start();
      _providers.set(p.name, p);
      started.push(p);
    } catch (err: any) {
      console.warn(`[Providers] Failed to init acp:${spec.name}: ${err.message}`);
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

/**
 * La lista degli agenti ACP da provare: la tabella nota più `ACP_AGENTS`, con i
 * dichiarati che vincono a parità di nome. Una variabile malformata NON deve
 * impedire al server di partire — si logga quante voci si sono scartate e si va
 * avanti con quelle buone.
 */
function resolveAcpAgents(): ReturnType<typeof mergeAcpAgents> {
  const { agents, skipped } = parseAcpAgentsEnv(process.env.ACP_AGENTS);
  if (skipped > 0) {
    console.warn(`[Providers] ACP_AGENTS: ${skipped} voce/i illeggibile/i, ignorate`);
  }
  return mergeAcpAgents(KNOWN_ACP_AGENTS, agents);
}

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
    const name = providerNameForConfig(config);
    const existing = _providers.get(name);
    if (existing) {
      try { existing.stop(); } catch (err: any) {
        console.warn(`[Providers] Failed to stop previous ${name} instance: ${err?.message ?? err}`);
      }
      _providers.delete(name);
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
  initProviders().catch((err) => console.warn(`[Providers] Deferred init failed: ${err?.message ?? err}`));
  return getDefaultProvider();
}
