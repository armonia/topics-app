import type { AppContext, RouteHandler } from "../types";
import type { ClaudeProviderConfig, ClaudeCodeProviderConfig, OpenAIProviderConfig } from "../providers/types";
import {
  listProviders,
  getDefaultProviderName,
  setDefaultProvider,
  registerProvider,
  removeProvider,
} from "../providers";
import { getSnapshotManager } from "../providers/snapshot-manager";

// Slice 9 removed the per-route `diagnoseCache` / `modelsCache` Maps that the
// old `/api/providers/diagnose` + `/api/providers/models` endpoints used. The
// snapshot manager is the single cache now: register/remove/configure call
// `getSnapshotManager().invalidate(name)` (via providers/index.ts), which
// re-probes the provider and broadcasts via WS.

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

    // GET /api/providers/snapshot — server-authoritative snapshot.
    // Returns cached entries immediately; stale rows refresh in background and
    // push the result via WS (`providers:snapshot`).
    if (method === "GET" && pathname === "/api/providers/snapshot") {
      return json(getSnapshotManager().getSnapshot());
    }

    // POST /api/providers/snapshot/refresh — force refresh.
    // Body: `{provider?: string}` — when present, refresh just that provider.
    if (method === "POST" && pathname === "/api/providers/snapshot/refresh") {
      let parsed: unknown = {};
      try { parsed = await req.json(); } catch { /* empty body OK */ }
      const body = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
      const name = typeof body.provider === "string" ? body.provider : undefined;
      await getSnapshotManager().refresh(name);
      return json({ ok: true });
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
        return json({
          ok: true,
          provider: {
            name: provider.name,
            connected: provider.connected,
            capabilities: [...provider.capabilities],
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: msg }, 500);
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: msg }, 400);
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
        return json({
          ok: true,
          provider: {
            name: provider.name,
            connected: provider.connected,
            capabilities: [...provider.capabilities],
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: msg }, 500);
      }
    }

    // POST /api/providers/claude-code/configure — pick the model used by the
    // claude-code CLI provider. Re-registers the provider so the next spawned
    // child uses the new --model flag. Persistent processes from the previous
    // model are killed by `registerProvider` (existing.stop()).
    if (method === "POST" && pathname === "/api/providers/claude-code/configure") {
      try {
        const body = await req.json();
        const { model, permissionMode, defaultWorkspace } = body ?? {};
        if (!model || typeof model !== "string") {
          return json({ ok: false, error: "Missing 'model' in request body" }, 400);
        }
        const config: ClaudeCodeProviderConfig = {
          type: "claude-code",
          model,
          permissionMode: permissionMode || process.env.CLAUDE_CODE_PERMISSION_MODE || undefined,
          defaultWorkspace: defaultWorkspace || process.env.CLAUDE_CODE_WORKSPACE || undefined,
        };
        const provider = registerProvider(config);
        return json({
          ok: true,
          provider: {
            name: provider.name,
            connected: provider.connected,
            capabilities: [...provider.capabilities],
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: msg }, 500);
      }
    }

    // DELETE /api/providers/:name — remove a provider
    const deleteMatch = method === "DELETE" && pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (deleteMatch) {
      const name = deleteMatch[1];
      try {
        removeProvider(name);
        return json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: msg }, 400);
      }
    }

    return null;
  };
}
