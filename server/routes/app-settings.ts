import type { AppContext, RouteHandler } from "../types";
import { getAppSettings, updateAppSettings, type AppSettings } from "../services/app-settings";
import { recomputeDefault, getDefaultProviderName } from "../providers";

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

const EFFORT_CLAUDE = new Set(["low", "medium", "high", "xhigh", "max"]);
const EFFORT_CODEX = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
const PROVIDERS = new Set(["claude", "claude-code", "openai", "codex", "openclaw"]);
const APPROVAL = new Set(["auto", "full-access"]);

type ValidationError = { field: string; message: string };

/** Coerce+validate an incoming patch. Returns the clean patch or errors. */
function parsePatch(body: Record<string, unknown>): {
  patch: Partial<AppSettings>;
  errors: ValidationError[];
} {
  const patch: Partial<AppSettings> = {};
  const errors: ValidationError[] = [];

  // A helper for "string | null" fields with an optional allow-set.
  const str = (key: keyof AppSettings, allow?: Set<string>) => {
    if (!(key in body)) return;
    const v = body[key];
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

  const int = (key: keyof AppSettings) => {
    if (!(key in body)) return;
    const v = body[key];
    if (v === null) { (patch as any)[key] = null; return; }
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isInteger(n) || n <= 0) {
      errors.push({ field: key, message: "expected a positive integer or null" });
      return;
    }
    (patch as any)[key] = n;
  };

  str("aiProvider", PROVIDERS);
  str("claudeModel");
  int("claudeMaxTokens");
  str("claudeEffort", EFFORT_CLAUDE);
  str("openaiModel");
  int("openaiMaxTokens");
  str("codexModel");
  str("codexReasoningEffort", EFFORT_CODEX);
  str("claudeCodePermissionMode");
  str("codexApprovalMode", APPROVAL);

  if ("claudeCodeEnabled" in body) {
    const v = body.claudeCodeEnabled;
    if (v === null || typeof v === "boolean") {
      patch.claudeCodeEnabled = v;
    } else {
      errors.push({ field: "claudeCodeEnabled", message: "expected a boolean or null" });
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
