import type { AppContext, RouteHandler } from "../types";
import type { ClaudeProviderConfig } from "../providers/types";
import {
  listProviders,
  getDefaultProviderName,
  setDefaultProvider,
  registerProvider,
  removeProvider,
} from "../providers";

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
        return json({ ok: true });
      } catch (err: any) {
        return json({ ok: false, error: err.message }, 400);
      }
    }

    return null;
  };
}
