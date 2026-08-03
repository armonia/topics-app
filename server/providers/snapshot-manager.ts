/**
 * ProviderSnapshotManager — single source of truth for the picker + settings.
 *
 * Holds one `ProviderSnapshotEntry` per registered provider. Combines the
 * existing `diagnose()` + `listModels()` calls into a unified row, caches it
 * with a TTL, dedupes in-flight probes, and emits a "change" event whenever
 * the snapshot mutates so the WS layer can broadcast to all clients.
 *
 * Pattern after Paseo's `provider-snapshot-manager.ts`, simplified for
 * single-workspace web app.
 */
import { EventEmitter } from "node:events";
import { listProviders, getProvider, getDefaultProviderName } from "./index";
import type { ProvidersSnapshot, ProviderSnapshotEntry, ProviderRequirement } from "./types";
import { resolveClaudeEffort, resolveCodexReasoningEffort } from "../lib/topics-agent-prompt";

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

const PROVIDER_LABELS: Record<string, string> = {
  openclaw: "OpenClaw",
  claude: "Claude (API)",
  "claude-code": "Claude Code",
  codex: "Codex",
  openai: "OpenAI",
};

/**
 * L'etichetta mostrata nel picker. I nomi non in tabella arrivano dagli agenti
 * ACP, che li prendono da `ACP_AGENTS`: quindi (a) il lookup passa da
 * `hasOwnProperty`, altrimenti un agente chiamato `toString` restituirebbe una
 * FUNZIONE al posto di una stringa, e (b) `gemini` si presenta come `Gemini`
 * invece che tutto minuscolo in mezzo a nomi propri.
 */
export function labelFor(name: string): string {
  if (Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, name)) {
    return PROVIDER_LABELS[name]!;
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Effort/reasoning tier Topics forces at spawn for this provider's sessions —
 * the same resolvers the spawn paths call, so the badge always matches what a
 * NEW session would actually get.
 */
function effortTierFor(name: string): string | undefined {
  if (name === "claude-code") return resolveClaudeEffort() ?? undefined;
  if (name === "codex") return resolveCodexReasoningEffort() ?? undefined;
  return undefined;
}

export class ProviderSnapshotManager extends EventEmitter {
  private entries = new Map<string, ProviderSnapshotEntry>();
  private inflight = new Map<string, Promise<void>>();

  /**
   * Returns the current snapshot. Triggers async warm-up for stale or missing
   * entries; `change` fires when warm-up completes.
   */
  getSnapshot(): ProvidersSnapshot {
    const all = listProviders();
    const defaultName = getDefaultProviderName() ?? null;
    const stale: string[] = [];
    const now = Date.now();

    // Insert placeholders for unknown providers and detect stale rows.
    for (const p of all) {
      const cached = this.entries.get(p.name);
      if (!cached) {
        this.entries.set(p.name, this.makeLoadingEntry(p.name, defaultName));
        stale.push(p.name);
      } else if (now - new Date(cached.fetchedAt).getTime() > SNAPSHOT_TTL_MS) {
        stale.push(p.name);
      }
    }
    // Drop entries for providers no longer registered.
    for (const name of [...this.entries.keys()]) {
      if (!all.find((p) => p.name === name)) this.entries.delete(name);
    }

    // Kick stale providers asynchronously — caller gets immediate (possibly stale) snapshot.
    if (stale.length > 0) {
      Promise.all(stale.map((n) => this.refresh(n)))
        .catch((err) => console.warn(`[Snapshot] Background refresh failed:`, err));
    }

    return this.toSnapshot(defaultName);
  }

  /**
   * Force-refresh one provider (or all when name is omitted). Single-flight
   * per provider name — concurrent callers share the in-flight promise.
   */
  async refresh(name?: string): Promise<void> {
    if (name === undefined) {
      const all = listProviders();
      await Promise.all(all.map((p) => this.refresh(p.name)));
      return;
    }
    const existing = this.inflight.get(name);
    if (existing) return existing;

    const task = this.refreshOne(name);
    this.inflight.set(name, task);
    try {
      await task;
    } finally {
      this.inflight.delete(name);
    }
  }

  private async refreshOne(name: string): Promise<void> {
    const defaultName = getDefaultProviderName() ?? null;

    // Verify the provider is still registered.
    let provider;
    try {
      provider = getProvider(name);
    } catch {
      this.entries.delete(name);
      this.emit("change");
      return;
    }

    // Mark loading (preserve prior models so the UI doesn't blink to empty).
    const prior = this.entries.get(name);
    this.entries.set(name, {
      ...(prior ?? this.makeLoadingEntry(name, defaultName)),
      status: "loading",
      isDefault: name === defaultName,
    });
    this.emit("change");

    let entry: ProviderSnapshotEntry;
    try {
      const [diag, models] = await Promise.all([
        provider.diagnose ? provider.diagnose() : Promise.resolve(null),
        provider.listModels ? provider.listModels().catch(() => [] as string[]) : Promise.resolve([] as string[]),
      ]);
      const requirements: ProviderRequirement[] = diag?.requirements ?? [];
      entry = {
        name,
        label: labelFor(name),
        status: diag ? diag.status : provider.connected ? "ready" : "unavailable",
        isDefault: name === defaultName,
        binaryPath: diag?.binaryPath,
        version: diag?.version,
        models,
        defaultModel: provider.defaultModel?.() ?? undefined,
        requirements,
        lastError: diag?.lastError,
        effortTier: effortTierFor(name),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      entry = {
        name,
        label: labelFor(name),
        status: "error",
        isDefault: name === defaultName,
        models: [],
        requirements: [],
        lastError: err instanceof Error ? err.message : String(err),
        fetchedAt: new Date().toISOString(),
      };
    }

    // Registry guard: between the await above and now, `removeProvider(name)`
    // may have run (e.g. settings reload, hot-swap). Without this check we'd
    // re-`set` a stale entry that `getSnapshot` would happily serve, and
    // `invalidate` would have to fire a second time to clear it. Re-resolve
    // and bail if the provider is no longer registered.
    try {
      getProvider(name);
    } catch {
      this.entries.delete(name);
      this.emit("change");
      return;
    }

    this.entries.set(name, entry);
    this.emit("change");
  }

  /** Drop an entry (e.g., when `removeProvider` is called). */
  invalidate(name: string): void {
    if (this.entries.delete(name)) this.emit("change");
  }

  /** Wipe everything and re-warm. Use when the registry changes wholesale. */
  invalidateAll(): void {
    this.entries.clear();
    this.emit("change");
    // Async warm-up: getSnapshot() on next call will trigger refresh.
  }

  private toSnapshot(defaultName: string | null): ProvidersSnapshot {
    return {
      providers: [...this.entries.values()].map((e) => ({
        ...e,
        isDefault: e.name === defaultName,
      })),
      defaultProvider: defaultName,
      generatedAt: new Date().toISOString(),
    };
  }

  private makeLoadingEntry(name: string, defaultName: string | null): ProviderSnapshotEntry {
    return {
      name,
      label: labelFor(name),
      status: "loading",
      isDefault: name === defaultName,
      models: [],
      requirements: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ProviderSnapshotManager | null = null;

export function getSnapshotManager(): ProviderSnapshotManager {
  if (!_instance) _instance = new ProviderSnapshotManager();
  return _instance;
}
