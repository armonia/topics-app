import type { AppContext, RouteHandler } from "../types";
import { getAppSettings, updateAppSettings, type AppSettings } from "../services/app-settings";
import { recomputeDefault, getDefaultProviderName, listProviders } from "../providers";
import { reconcileDiscordPresence } from "../services/discord-presence";
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from "../../shared/effort";
import { OUTPUT_LANGUAGES, DISCORD_DETAIL_LEVELS, AGENT_RUNTIMES } from "../../shared/types";

/**
 * GET/PUT /api/app-settings — the promoted behaviour toggles (env-var audit,
 * Phase B). These are NON-secret defaults (provider, model/effort/max-tokens,
 * permission/approval modes, claude-code enable). Secrets never live here.
 *
 * PUT accepts a partial patch; each key is validated. A key set to `null`
 * clears the override (revert to env/default). Changing the default provider
 * re-picks it live so the picker reflects it without a restart; model/token
 * changes apply to providers created on the next init/session.
 *
 * Chi scrive `aiProvider` da qui, in pratica, è UN caso solo: la card del
 * provider quando toglie il default (`{aiProvider: null}` → «scegli
 * automaticamente»). La scelta POSITIVA passa da `PUT /api/providers/default`,
 * che valida contro il registro prima di scrivere la stessa colonna — e da oggi
 * anche questa rotta valida contro il registro, così le due non possono più
 * dare risposte diverse sullo stesso nome.
 */

const EFFORT_CLAUDE = new Set<string>(EFFORT_TIERS);
const EFFORT_CODEX = new Set<string>(CODEX_REASONING_EFFORTS);
const APPROVAL = new Set(["auto", "full-access"]);
/** L'insieme delle lingue vive in `shared/types.ts`, letto dai due lati del
 *  filo: qui per validare, nel selettore per disegnare le opzioni. */
const LANGUAGES = new Set<string>(OUTPUT_LANGUAGES);
/** Idem per i gradini di privacy della presence: l'insieme sta in
 *  `shared/types.ts`, qui si valida contro quello. */
const DISCORD_LEVELS = new Set<string>(DISCORD_DETAIL_LEVELS);
/** Le due meccaniche di esecuzione, dallo stesso array che disegna il
 *  selettore: `cli` | `jcode`. */
const RUNTIMES = new Set<string>(AGENT_RUNTIMES);

/**
 * I nomi ammessi per `aiProvider`: quelli REGISTRATI adesso, non una lista
 * scritta a mano.
 *
 * Erano cinque nomi cablati, e la lista sbagliava da entrambi i lati. Da un
 * lato accettava un provider non registrato: la riga finiva in DB, ma
 * `recomputeDefault()` non trovava il nome nel registro, usciva dal ramo
 * esplicito e ripiegava sull'ordine di preferenza — quindi la scelta era
 * scritta e ignorata insieme. Dall'altro rifiutava gli agenti ACP, che
 * `PUT /api/providers/default` invece accetta e scrive nella STESSA colonna:
 * un default `gemini` impostato di là tornava indietro come 400 di qua.
 * Ora le due rotte hanno la stessa idea di cosa sia un provider valido.
 */
function registeredProviderNames(): Set<string> {
  return new Set(listProviders().map((p) => p.name));
}

type ValidationError = { field: string; message: string };

/** Come si valida UN campo: stringa (con eventuale allow-set, fisso o risolto
 *  al momento della richiesta), intero, booleano. */
type FieldRule =
  | { kind: "string"; allow?: Set<string>; allowFrom?: () => Set<string> }
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
  aiProvider: { kind: "string", allowFrom: registeredProviderNames },
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
  // `null` e `'auto'` dicono la stessa cosa — «nessuna direttiva» — e passano
  // entrambi: il selettore manda la stringa, chi azzera manda null.
  outputLanguage: { kind: "string", allow: LANGUAGES },
  // Lo stato pubblicato su Discord (migration 102). Passa da QUI e non da una
  // rotta sua: due porte che scrivono la stessa colonna è il guasto che il
  // commento in cima a questo file racconta già per `aiProvider`.
  discordPresenceEnabled: { kind: "bool" },
  discordDetailLevel: { kind: "string", allow: DISCORD_LEVELS },
  // La meccanica di esecuzione. `null` rimette il default del codice (`cli`),
  // che è anche ciò che manda chi azzera la scelta.
  agentRuntime: { kind: "string", allow: RUNTIMES },
  // Spesa in dollari sulla pagina pubblica del profilo: opt-in esplicito,
  // default false — dato personale.
  profilePublishCost: { kind: "bool" },
  // Il token e' gestito da POST/DELETE /api/app-settings/profile-token,
  // non da PUT. Il campo va in FIELD_RULES per soddisfare Record<keyof AppSettings, …>
  // ma non e' mai in `body` nel PUT ordinario: skip silenzioso.
  profileShareToken: { kind: "string" },
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
      errors.push({
        field: key,
        message: allow.size === 0
          ? "no value is currently accepted for this field"
          : `expected one of: ${[...allow].join(", ")}`,
      });
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
      case "string": str(key, v, rule.allow ?? rule.allowFrom?.()); break;
      case "int": int(key, v); break;
      case "bool": bool(key, v); break;
    }
  }

  return { patch, errors };
}

/** Genera un token URL-safe a 128-bit (22 caratteri Base64url). */
function generateToken(): string {
  // 16 byte → 128 bit di entropia: non deducibile per tentativi.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createAppSettingsRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async function appSettingsRouter(
    req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    // ── POST /api/app-settings/profile-token — genera e salva il token ──────
    // Idempotente: se il token esiste gia' lo restituisce senza cambiarlo.
    // Cosi' «Pubblica» e' sicuro anche se premuto piu' volte.
    if (pathname === "/api/app-settings/profile-token" && method === "POST") {
      const current = getAppSettings();
      const token = current.profileShareToken ?? generateToken();
      if (!current.profileShareToken) {
        updateAppSettings({ profileShareToken: token });
      }
      return json({ ok: true, token });
    }

    // ── DELETE /api/app-settings/profile-token — revoca il token ─────────────
    // Azzera il token: da questo momento /public/profile/<vecchio-token> torna 404.
    if (pathname === "/api/app-settings/profile-token" && method === "DELETE") {
      updateAppSettings({ profileShareToken: null });
      return json({ ok: true });
    }

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
      // L'interruttore della presence deve valere SUBITO. Senza questo, un
      // «accendi» avrebbe effetto al prossimo giro del servizio — fino a
      // quindici secondi di pannello acceso e profilo Discord vuoto, che si
      // legge come una spunta rotta. Non si aspetta l'esito: la risposta a chi
      // salva non dipende da Discord.
      if ("discordPresenceEnabled" in patch || "discordDetailLevel" in patch) {
        void reconcileDiscordPresence().catch(() => { /* lo stato lo racconta /api/profile/discord */ });
      }
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
