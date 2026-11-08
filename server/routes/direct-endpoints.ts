/**
 * The REST face of the configured endpoints.
 *
 * Its own module rather than more lines in `providers.ts`: that file is already
 * past the size the bloat ratchet freezes, and a CRUD that nobody can find is
 * worse than one extra file.
 *
 * Two rules the routes hold and the store does not. A token NEVER comes back
 * out: the client gets `hasToken`, never the secret it just sent, because a
 * settings page that re-renders its own bearer puts it in every screenshot of
 * that page. And an endpoint is PROBED before it is saved, so a typo in the
 * address is a sentence in the form instead of a provider that fails at the
 * first message.
 */
import {
  deleteDirectEndpoint,
  deleteEndpointSecret,
  getDirectEndpoint,
  listDirectEndpoints,
  readEndpointSecret,
  saveDirectEndpoint,
  writeEndpointSecret,
} from "../services/direct-endpoint-store";
import { validateDirectEndpoint, type DirectEndpointConfig } from "../../shared/direct-endpoints";
import { OpenAICompatibleProvider } from "../providers/openai-compatible";

/** What a client is allowed to see: everything except the secret. */
export function publicEndpointView(
  endpoint: DirectEndpointConfig,
  hasToken: boolean,
): Record<string, unknown> {
  return { ...endpoint, hasToken };
}

/** Probe an endpoint without registering it, so a bad one never lands. */
export async function probeEndpoint(
  endpoint: DirectEndpointConfig,
  token: string | undefined,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const provider = new OpenAICompatibleProvider({ type: "openai-compatible", endpoint, token });
  provider.start();
  try {
    const diagnostic = await provider.diagnose();
    return {
      ok: diagnostic.status === "ready",
      models: await provider.listModels(),
      error: diagnostic.status === "ready" ? undefined : diagnostic.lastError,
    };
  } finally {
    provider.stop();
  }
}

interface EndpointRouterDeps {
  json: (body: unknown, status?: number) => Response;
  /** Bring the provider registry back in line with the file on disk. */
  sync: () => void;
  stateDir?: string;
}

export function createDirectEndpointsRouter(deps: EndpointRouterDeps) {
  const { json, sync, stateDir } = deps;

  return async function directEndpointsRouter(
    req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    if (!pathname.startsWith("/api/providers/endpoints")) return null;

    // GET /api/providers/endpoints
    if (method === "GET" && pathname === "/api/providers/endpoints") {
      return json({
        endpoints: listDirectEndpoints(stateDir).map((endpoint) =>
          publicEndpointView(endpoint, Boolean(readEndpointSecret(endpoint.id, stateDir)))),
      });
    }

    // POST /api/providers/endpoints/test — probe without saving.
    if (method === "POST" && pathname === "/api/providers/endpoints/test") {
      const body = await req.json().catch(() => null);
      const parsed = validateDirectEndpoint(body);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
      const token = typeof (body as Record<string, unknown>)?.token === "string"
        ? (body as Record<string, string>).token
        : readEndpointSecret(parsed.value.id, stateDir);
      const probe = await probeEndpoint(parsed.value, token);
      return json(probe, probe.ok ? 200 : 502);
    }

    // POST /api/providers/endpoints — create or replace, after a probe.
    if (method === "POST" && pathname === "/api/providers/endpoints") {
      const body = await req.json().catch(() => null);
      const parsed = validateDirectEndpoint(body);
      if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
      const endpoint = parsed.value;
      // An empty token on an update means "leave the one you have", not
      // "delete it": the form never renders the secret, so it cannot resend it.
      const sent = (body as Record<string, unknown>)?.token;
      const token = typeof sent === "string" && sent.length > 0
        ? sent
        : readEndpointSecret(endpoint.id, stateDir);

      if (endpoint.auth === "bearer" && !token) {
        return json({ ok: false, error: "This endpoint needs a token." }, 400);
      }

      const probe = await probeEndpoint(endpoint, token);
      if (!probe.ok) return json({ ok: false, error: probe.error ?? "The endpoint did not answer." }, 502);

      if (endpoint.auth === "bearer" && token) writeEndpointSecret(endpoint.id, token, stateDir);
      if (endpoint.auth === "none") deleteEndpointSecret(endpoint.id, stateDir);
      saveDirectEndpoint(endpoint, stateDir);
      sync();
      return json({
        ok: true,
        endpoint: publicEndpointView(endpoint, endpoint.auth === "bearer"),
        models: probe.models,
      });
    }

    // DELETE /api/providers/endpoints/:id
    const remove = pathname.match(/^\/api\/providers\/endpoints\/([^/]+)$/);
    if (method === "DELETE" && remove) {
      const id = decodeURIComponent(remove[1]!);
      if (!getDirectEndpoint(id, stateDir)) return json({ ok: false, error: "No such endpoint." }, 404);
      deleteDirectEndpoint(id, stateDir);
      sync();
      return json({ ok: true });
    }

    return null;
  };
}
