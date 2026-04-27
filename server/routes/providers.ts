import type { AppContext, RouteHandler } from "../types";
import type { ClaudeProviderConfig, OpenAIProviderConfig, ProviderDiagnostic } from "../providers/types";
import {
  listProviders,
  getDefaultProviderName,
  setDefaultProvider,
  registerProvider,
  removeProvider,
  getProvider,
} from "../providers";

const DIAGNOSE_TTL_MS = 5 * 60 * 1000; // 5 min cache (Paseo pattern)
const diagnoseCache = new Map<string, { at: number; result: ProviderDiagnostic }>();
const diagnoseInflight = new Map<string, Promise<ProviderDiagnostic | null>>();
const modelsCache = new Map<string, { at: number; models: string[] }>();
const modelsInflight = new Map<string, Promise<string[]>>();
const MODELS_TTL_MS = 5 * 60 * 1000;

async function getDiagnostic(name: string, force: boolean): Promise<ProviderDiagnostic | null> {
  if (!force) {
    const cached = diagnoseCache.get(name);
    if (cached && Date.now() - cached.at < DIAGNOSE_TTL_MS) return cached.result;
    const pending = diagnoseInflight.get(name);
    if (pending) return pending;
  }
  const task = (async () => {
    let provider;
    try { provider = getProvider(name); } catch { return null; }
    if (!provider.diagnose) {
      return {
        name,
        status: provider.connected ? "ready" : "unavailable",
        requirements: [],
      } as ProviderDiagnostic;
    }
    const result = await provider.diagnose();
    diagnoseCache.set(name, { at: Date.now(), result });
    return result;
  })().finally(() => {
    diagnoseInflight.delete(name);
  });
  diagnoseInflight.set(name, task);
  return task;
}

async function getModels(name: string): Promise<string[]> {
  const cached = modelsCache.get(name);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  const pending = modelsInflight.get(name);
  if (pending) return pending;
  const task = (async () => {
    let provider;
    try { provider = getProvider(name); } catch { return []; }
    if (!provider.listModels) return [];
    try {
      const models = await provider.listModels();
      modelsCache.set(name, { at: Date.now(), models });
      return models;
    } catch {
      return [];
    }
  })().finally(() => {
    modelsInflight.delete(name);
  });
  modelsInflight.set(name, task);
  return task;
}

export function createProvidersRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async function providersRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    // GET /api/providers — list all providers with status
    if (method === "GET" && pathname === "/api/providers") {
      const providers = listProviders();
      return json({
        providers,
        default: getDefaultProviderName() ?? null,
      });
    }

    // GET /api/providers/diagnose — diagnose all providers in parallel
    if (method === "GET" && pathname === "/api/providers/diagnose") {
      const force = url.searchParams.get("force") === "1";
      const all = listProviders();
      const defaultName = getDefaultProviderName();
      const results = await Promise.all(
        all.map(async (p) => {
          const diag = await getDiagnostic(p.name, force);
          return diag ? { ...diag, isDefault: p.name === defaultName } : null;
        }),
      );
      return json({ providers: results.filter(Boolean) });
    }

    // GET /api/providers/models — list models for each provider that supports listModels()
    if (method === "GET" && pathname === "/api/providers/models") {
      const all = listProviders();
      const results = await Promise.all(
        all.map(async (p) => ({
          provider: p.name,
          models: await getModels(p.name),
        })),
      );
      return json({ providers: results });
    }

    // GET /api/providers/:name/diagnose — diagnose a single provider
    const diagnoseMatch = method === "GET" && pathname.match(/^\/api\/providers\/([^/]+)\/diagnose$/);
    if (diagnoseMatch) {
      const name = diagnoseMatch[1];
      const force = url.searchParams.get("force") === "1";
      const result = await getDiagnostic(name, force);
      if (!result) return json({ error: `Provider "${name}" not found` }, 404);
      const defaultName = getDefaultProviderName();
      return json({ ...result, isDefault: name === defaultName });
    }

    // POST /api/providers/openai/configure — configure OpenAI provider at runtime
    if (method === "POST" && pathname === "/api/providers/openai/configure") {
      try {
        const body = await req.json();
        const { apiKey, model, maxTokens } = body ?? {};
        if (!apiKey || typeof apiKey !== "string") {
          return json({ ok: false, error: "Missing 'apiKey' in request body" }, 400);
        }
        const config: OpenAIProviderConfig = {
          type: "openai",
          apiKey,
          model: model || undefined,
          maxTokens: maxTokens ? parseInt(String(maxTokens), 10) : undefined,
        };
        const provider = registerProvider(config);
        diagnoseCache.delete("openai");
        modelsCache.delete("openai");
        return json({
          ok: true,
          provider: {
            name: provider.name,
            connected: provider.connected,
            capabilities: [...provider.capabilities],
          },
        });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // PUT /api/providers/default — set default provider
    if (method === "PUT" && pathname === "/api/providers/default") {
      try {
        const body = await req.json();
        const name = body?.provider;
        if (!name || typeof name !== "string") {
          return json({ ok: false, error: "Missing 'provider' in request body" }, 400);
        }
        setDefaultProvider(name);
        return json({ ok: true, default: name });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    // POST /api/providers/claude/configure — configure Claude provider at runtime
    if (method === "POST" && pathname === "/api/providers/claude/configure") {
      try {
        const body = await req.json();
        const { apiKey, model, maxTokens } = body ?? {};
        if (!apiKey || typeof apiKey !== "string") {
          return json({ ok: false, error: "Missing 'apiKey' in request body" }, 400);
        }
        const config: ClaudeProviderConfig = {
          type: "claude",
          apiKey,
          model: model || undefined,
          maxTokens: maxTokens ? parseInt(String(maxTokens), 10) : undefined,
        };
        const provider = registerProvider(config);
        diagnoseCache.delete("claude");
        modelsCache.delete("claude");
        return json({
          ok: true,
          provider: {
            name: provider.name,
            connected: provider.connected,
            capabilities: [...provider.capabilities],
          },
        });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    // DELETE /api/providers/:name — remove a provider
    const deleteMatch = method === "DELETE" && pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (deleteMatch) {
      const name = deleteMatch[1];
      try {
        removeProvider(name);
        diagnoseCache.delete(name);
        modelsCache.delete(name);
        return json({ ok: true });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    return null;
  };
}
