import type { AppContext, RouteHandler } from "../types";
import { getAppSettings, updateAppSettings, type AppSettings } from "../services/app-settings";
import { recomputeDefault, getDefaultProviderName } from "../providers";
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from "../../shared/effort";

/**
 * GET/PUT /api/app-settings — the promoted behaviour toggles (env-var audit,
 * Phase B). These are NON-secret defaults (provider, model/effort/max-tokens,
 * permission/approval modes, claude-code enable). Secrets never live here.
 *
 * PUT accepts a partial patch; each key is validated. A key set to `null`
 * clears the override (revert to env/default). Changing the default provider
 * re-picks it live so the picker reflects it without a restart; model/token
 * changes apply to providers created on the next init/session.
 */

const EFFORT_CLAUDE = new Set<string>(EFFORT_TIERS);
const EFFORT_CODEX = new Set<string>(CODEX_REASONING_EFFORTS);
const PROVIDERS = new Set(["claude", "claude-code", "openai", "codex", "openclaw"]);
const APPROVAL = new Set(["auto", "full-access"]);

type ValidationError = { field: string; message: string };

/** Come si valida UN campo: stringa (con eventuale allow-set), intero, booleano. */
type FieldRule =
  | { kind: "string"; allow?: Set<string> }
  | { kind: "int" }
  | { kind: "bool" };

/**
 * La regola di validazione per OGNI campo di `AppSettings`, derivata dal tipo:
 * `Record<keyof AppSettings, …>` è esaustivo per costruzione, quindi un campo
 * aggiunto al tipo e dimenticato qui NON compila (TS2741). È il punto di tutto:
 * prima le regole erano una lista di chiamate scritte a mano (`str(...)`,
 * `int(...)`) e un campo nuovo nel tipo, non aggiunto qui, spariva in silenzio —
 * accettato dalla UI, mai validato, mai scritto. (Il lato persistenza era già
 * coperto: `COLUMNS` in `services/app-settings.ts` è anch'esso
 * `Record<keyof AppSettings, string>`.)
 */
const FIELD_RULES: Record<keyof AppSettings, FieldRule> = {
  aiProvider: { kind: "string", allow: PROVIDERS },
  claudeModel: { kind: "string" },
  claudeMaxTokens: { kind: "int" },
  claudeEffort: { kind: "string", allow: EFFORT_CLAUDE },
  openaiModel: { kind: "string" },
  openaiMaxTokens: { kind: "int" },
  codexModel: { kind: "string" },
  codexReasoningEffort: { kind: "string", allow: EFFORT_CODEX },
  claudeCodePermissionMode: { kind: "string" },
  codexApprovalMode: { kind: "string", allow: APPROVAL },
  claudeCodeEnabled: { kind: "bool" },
};

/** Coerce+validate an incoming patch. Returns the clean patch or errors. */
function parsePatch(body: Record<string, unknown>): {
  patch: Partial<AppSettings>;
  errors: ValidationError[];
} {
  const patch: Partial<AppSettings> = {};
  const errors: ValidationError[] = [];

  // A "string | null" field with an optional allow-set.
  const str = (key: keyof AppSettings, v: unknown, allow?: Set<string>) => {
    if (v === null) { (patch as any)[key] = null; return; }
    if (typeof v !== "string" || v.trim() === "") {
      errors.push({ field: key, message: "expected a non-empty string or null" });
      return;
    }
    const val = v.trim();
    if (allow && !allow.has(val)) {
      errors.push({ field: key, message: `expected one of: ${[...allow].join(", ")}` });
      return;
    }
    (patch as any)[key] = val;
  };

  const int = (key: keyof AppSettings, v: unknown) => {
    if (v === null) { (patch as any)[key] = null; return; }
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      errors.push({ field: key, message: "expected a positive integer or null" });
      return;
    }
    (patch as any)[key] = n;
  };

  const bool = (key: keyof AppSettings, v: unknown) => {
    if (v === null || typeof v === "boolean") { (patch as any)[key] = v; return; }
    errors.push({ field: key, message: "expected a boolean or null" });
  };

  for (const [key, rule] of Object.entries(FIELD_RULES) as Array<[keyof AppSettings, FieldRule]>) {
    if (!(key in body)) continue;
    const v = body[key];
    switch (rule.kind) {
      case "string": str(key, v, rule.allow); break;
      case "int": int(key, v); break;
      case "bool": bool(key, v); break;
    }
  }

  return { patch, errors };
}

export function createAppSettingsRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async function appSettingsRouter(
    req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    if (pathname !== "/api/app-settings") return null;

    if (method === "GET") {
      return json({ settings: getAppSettings() });
    }

    if (method === "PUT") {
      let parsed: unknown;
      try {
        parsed = await req.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }
      if (!parsed || typeof parsed !== "object") {
        return json({ ok: false, error: "Body must be an object" }, 400);
      }
      const { patch, errors } = parsePatch(parsed as Record<string, unknown>);
      if (errors.length > 0) {
        return json({ ok: false, errors }, 400);
      }
      const settings = updateAppSettings(patch);
      // Re-pick the default provider so an aiProvider change is reflected live.
      const changed = recomputeDefault();
      if (changed) {
        ctx.broadcastToAll?.({ type: "gateway:status", connected: true });
      }
      return json({ ok: true, settings, default: getDefaultProviderName() ?? null });
    }

    return null;
  };
}
