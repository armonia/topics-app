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
  resolveAgentRuntime,
  type AppSettings,
} from "../services/app-settings";


// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const _providers = new Map<string, AIProvider>();
let _defaultName: string | undefined;

/**
 * The order used to pick a FALLBACK default among the providers we know by
 * name. Anything not listed here is not excluded: it ranks after (see
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
      // ONE provider for EVERY agent that speaks ACP: `config.name` picks which.
      // That is the point of phase 3 — the next agent costs one line in
      // `acp/agents.ts`, not a file here.
      const { AcpProvider } = require("./acp");
      return new AcpProvider(config);
    }
    case "native": {
      // The in-house runtime: no process to spawn, the session lives inside
      // this server. It registers under the name `topics`.
      const { NativeProvider } = require("./native/provider");
      return new NativeProvider(config);
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
  // This is the order of the KNOWN, not the list of the allowed. It was five
  // hand-written names, and no ACP agent was in it: gemini could NEVER become
  // the automatic default, not even as the only connected one, because `find`
  // did not see it and it fell into the fallback branch below — which picks the
  // first connected one in REGISTRATION order, i.e. by accident. Now anything
  // off the table ranks AFTER the known ones and BEFORE the last fallback: out
  // of the explicit preference, but inside the ranking.
  const preferred = PROVIDER_PREFERENCE_ORDER.find(
    (name) => _providers.get(name)?.connected === true,
  );
  // Il runtime `jcode` (oggi il default: vedi DEFAULT_AGENT_RUNTIME) è già una
  // risposta alla domanda «con quale meccanica»: se quel provider è registrato
  // ed è connesso, viene PRIMA dell'ordine dei noti. Senza questa riga
  // l'interruttore si accende a metà — jcode nel picker, ma il default
  // automatico ancora `claude-code`, cioè i ~790 MB per sessione da cui si sta
  // scappando.
  //
  // È ANCHE LA RETE, ed è il motivo per cui la condizione guarda `connected` e
  // non solo il nome. Su una macchina senza `jcode` nel PATH il provider non si
  // registra nemmeno (il ciclo qui sopra salta gli agenti ACP senza eseguibile),
  // quindi questa riga non scatta e si cade nell'ordine dei noti: chi aggiorna e
  // non ha jcode installato NON resta senza default, si ritrova `claude-code`
  // esattamente come prima. Il default nuovo è un'offerta, non un requisito.
  //
  // Il nome del runtime e il nome del provider non coincidono per il nativo:
  // il runtime si chiama `topics` e il provider pure, ma la mappa esplicita
  // evita che il giorno che divergono qualcuno lo scopra da un default che non
  // scatta più senza dire niente.
  const RUNTIME_PROVIDER: Record<string, string> = { jcode: "jcode", topics: "topics" };
  const wanted = RUNTIME_PROVIDER[resolveAgentRuntime()];
  const runtimePreferred =
    wanted && _providers.get(wanted)?.connected === true ? wanted : undefined;
  const unknownConnected = [..._providers.entries()].find(
    ([name, p]) => p.connected === true && !PROVIDER_PREFERENCE_ORDER.includes(name),
  )?.[0];
  const chosen = runtimePreferred ?? preferred ?? unknownConnected;
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

  // Il runtime NATIVO. Si registra quando su questa macchina c'è una
  // credenziale Claude, cioè quando può davvero servire un turno: un provider
  // che non può rispondere riempirebbe il picker di una voce morta, come per
  // gli agenti ACP senza eseguibile.
  //
  // Non spawna niente e non apre connessioni: registrarlo costa un oggetto in
  // memoria, quindi non c'è un cancello d'ambiente da attraversare. Diventa il
  // DEFAULT solo se il runtime lo chiede (vedi `recomputeDefault`).
  if (!_providers.has("topics")) {
    try {
      const { hasCredentials } = require("./native/auth");
      if (hasCredentials()) {
        const p = createProvider({
          type: "native",
          defaultWorkspace: process.env.TOPICS_WORKSPACE || undefined,
          // IL MODELLO SCELTO IN IMPOSTAZIONI VALEVA PER TUTTI TRANNE CHE QUI.
          // Senza questa riga `config.model` resta undefined e ogni turno cade
          // su DEFAULT_MODEL (sonnet), qualunque cosa dica `claudeModel`: il
          // 02/09 un topic rispondeva con Sonnet mentre il terminale, stessa
          // macchina e stesso prompt, rispondeva con Opus 5.
          model: resolveClaudeModel(),
        });
        p.start();
        _providers.set(p.name, p);
        started.push(p);
      }
    } catch (err: any) {
      console.warn(`[Providers] Failed to init native runtime: ${err?.message ?? err}`);
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
 *
 * Esportata per una ragione sola: qui dentro vive il CANCELLO del runtime, e
 * l'alternativa per provarlo sarebbe far partire `initProviders` intero — cioè
 * spawnare CLI vere per misurare una decisione che è una riga di filtro.
 */
export function resolveAcpAgents(): ReturnType<typeof mergeAcpAgents> {
  const { agents, skipped } = parseAcpAgentsEnv(process.env.ACP_AGENTS);
  if (skipped > 0) {
    console.warn(`[Providers] ACP_AGENTS: ${skipped} voce/i illeggibile/i, ignorate`);
  }
  const merged = mergeAcpAgents(KNOWN_ACP_AGENTS, agents);
  // Il cancello del runtime, e vale SOLO sulla riga che mettiamo noi in
  // tabella. Dal 2026-08-16 il verso è invertito: `jcode` è il runtime di chi
  // non ha scelto, quindi il cancello è aperto quasi sempre e si CHIUDE solo
  // per chi ha chiesto `cli` esplicitamente. Chi l'ha chiesto sta dicendo
  // «voglio una CLI per sessione», e trovarsi comunque il provider ACP nel
  // picker — eleggibile come default appena una CLI risulta disconnessa —
  // sarebbe esattamente la cosa che ha appena escluso.
  //
  // Chi lo dichiara a mano in `ACP_AGENTS` passa lo stesso: quella variabile è
  // il modo esplicito di dire «voglio questo agente», e un interruttore di
  // meccanica non deve sovrascrivere una richiesta nominale.
  if (resolveAgentRuntime() === "jcode") return merged;
  const declaredByHand = new Set(agents.map((a) => a.name));
  return merged.filter((spec) => spec.name !== "jcode" || declaredByHand.has("jcode"));
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

/**
 * «Il turno di questa sessione è ancora vivo?» — chiesto al provider GIUSTO.
 *
 * Tre risposte e non due: `true` vivo, `false` morto, `null` non lo so. La
 * distinzione è tutto il senso della funzione, perché il dispatcher seppellisce
 * un turno solo sul `false` — l'ignoranza non deve leggersi come morte, e un
 * turno sepolto per sbaglio è lavoro vero buttato (fix 1790f859).
 *
 * Perché esiste. La sonda in `server.ts` chiedeva sempre a `claude-code`, che
 * per le sessioni ALTRUI guarda una mappa dove non le ha mai messe e risponde
 * `false`: «l'ho guardato ed è morto», che è una bugia — la verità è «non è roba
 * mia». Finché ogni agente dispacciato era claude-code il ramo non si vedeva;
 * col runtime `jcode` di default ogni sessione dispacciata è di un altro
 * provider, quindi il caso passa da impossibile a normale.
 *
 * Come si sceglie a chi chiedere: si guarda CHI possiede quella sessione. Un
 * provider che non riconosce la sessione o che non ha la sonda risponde `null`,
 * ed è la risposta onesta: nessuno viene sepolto sull'ignoranza di nessuno.
 */
/**
 * Which provider owns this session, when anyone can say.
 *
 * Same routing rule as `resolveTurnAlive`, exposed because the liveness probe
 * was not the only thing being asked of the wrong provider: the sweeper's
 * `resyncStream` was hardwired to `claude-code` too, so the rescue attempt for
 * somebody else's turn was a silent no-op — a recovery that recovered nothing.
 */
export function resolveSessionOwner(sessionKey: string): unknown | null {
  for (const [, p] of _providers) {
    const probe = p as unknown as { ownsSession?: (sk: string) => boolean };
    if (typeof probe.ownsSession !== "function") continue;
    try {
      if (probe.ownsSession(sessionKey)) return p;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The probe the stale-stream sweeper must use — given a NAME, because the defect
 * lived entirely in the WIRING and an unnamed expression cannot be tested.
 *
 * Measured on 2026-08-28 against a real turn (topic:0299ac2d): the sweeper asked
 * `claude-code` whether the child of a NATIVE session was alive. That provider
 * reads its own `processes` map, does not find a session that was never its own,
 * and answers `false` — "I looked and it is dead" — instead of staying quiet.
 * `staleStreamVerdict` discards anything that is not `true`, so for every native
 * turn the "rescue" and "extend" branches were unreachable by construction: three
 * minutes of silence was enough to close a turn, alive or not. The signature was
 * already in the logs and nobody had read it: 64 finalizations, ZERO extensions,
 * all 18 killed sessions on provider `topics`, all 12 protected ones claude-code.
 *
 * `null` (nobody can answer) becomes `undefined`, which the pure rule treats as
 * dead. That is deliberate and unchanged: a sweeper that never finalizes would
 * leave partial messages hanging forever. What changes is only WHO answers — the
 * provider that actually holds the session.
 */
export function childAliveForSweep(sessionKey: string): boolean | undefined {
  return resolveTurnAlive(sessionKey) ?? undefined;
}

export function resolveTurnAlive(sessionKey: string): boolean | null {
  for (const [, p] of _providers) {
    const probe = p as unknown as {
      ownsSession?: (sk: string) => boolean;
      isTurnProcessAlive?: (sk: string) => boolean;
    };
    if (typeof probe.isTurnProcessAlive !== "function") continue;
    // Chi non sa dire se la sessione è sua non può parlare per lei: la vecchia
    // sonda faceva esattamente questo e rispondeva «morto» per tutti.
    if (typeof probe.ownsSession !== "function") continue;
    try {
      if (!probe.ownsSession(sessionKey)) continue;
      return probe.isTurnProcessAlive(sessionKey);
    } catch {
      return null;
    }
  }
  return null;
}
