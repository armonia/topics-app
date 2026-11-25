import type { AppContext, RouteHandler } from "../types";
import { getAppSettings, readAppSettings, updateAppSettings, type AppSettings } from "../services/app-settings";
import { recomputeDefault, getDefaultProviderName, listProviders } from "../providers";
import { getSnapshotManager } from "../providers/snapshot-manager";
import { reconcileDiscordPresence } from "../services/discord-presence";
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from "../../shared/effort";
import { CALENDAR_HORIZON_CHOICES, CALENDAR_REFRESH_CHOICES } from "../../shared/calendar";
import { normalizeFeedUrl, resetCalendarCache } from "../services/calendar-feed";
import { clampBrowserStoreReapDays } from "../../shared/browser-store-reap";
import { OUTPUT_LANGUAGES, DISCORD_DETAIL_LEVELS, AGENT_RUNTIMES } from "../../shared/types";
import { normalizeWorktreeRoot, worktreeRootRefusal, type WorktreeRootRefusal } from "../lib/worktree-root-setting";
import { hasRootSentinel } from "../services/worktree-root-ledger";
import { defaultWorktreeRootDir } from "../services/worktree-root";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CARGO_TARGET_MODES,
  CLAUDE_WORKTREE_HOOK_MODES,
  DEFAULT_WORKTREE_ABANDON_DAYS,
  DEFAULT_WORKTREE_QUARANTINE_DAYS,
  DEFAULT_WORKTREE_DISK_FLOOR_GB,
  DEFAULT_WORKTREE_MAX_PER_PROJECT,
  GC_FOREIGN_MODES,
  WORKTREE_ABANDON_DAYS_RANGE,
  WORKTREE_QUARANTINE_DAYS_RANGE,
  WORKTREE_DISK_FLOOR_RANGE,
  WORKTREE_MAX_PER_PROJECT_RANGE,
  clampInto,
} from "../../shared/worktree-settings";

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

type ValidationError = { field: string; message: string; code?: WorktreeRootRefusal };

/** The sentence of each refusal of a worktree root; the client shows its own words for the `code`. */
const ROOT_REFUSAL_TEXT: Record<WorktreeRootRefusal, string> = {
  relative: "the folder must be an absolute path",
  temp: "a temp folder: the system cleans it under live checkouts",
  "filesystem-root": "the root of a disk",
  home: "the home folder",
  "home-ancestor": "a folder that contains the home folder",
  system: "a system folder",
  "inside-project": "inside a project's repository",
  "contains-project": "it contains a project",
  "not-empty": "it already holds files that are not Topics' worktrees",
};

/** Come si valida UN campo: stringa (con eventuale allow-set, fisso o risolto
 *  al momento della richiesta), intero, booleano. */
type FieldRule =
  | { kind: "string"; allow?: Set<string>; allowFrom?: () => Set<string>; normalize?: (v: string) => string | null }
  | { kind: "int"; allow?: Set<number>; clamp?: (n: number) => number }
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
  museModel: { kind: "string" },
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
  // The automatic per-turn checkpoint (card b69a9c07). `null` = off, which is
  // also the default: it writes git objects into the user's repository on every
  // turn, so it is turned on by hand or not at all.
  turnCheckpointsEnabled: { kind: "bool" },
  // The calendar (card aa641133). The switch and the address are two settings
  // on purpose: turning the sync off must not throw away the URL, or every
  // pause costs a trip back to the calendar provider to copy the secret
  // address again.
  calendarEnabled: { kind: "bool" },
  // Normalised before it is written: `webcal://` becomes https, and anything
  // that is not http(s) is refused HERE rather than handed to `fetch` later.
  calendarFeedUrl: { kind: "string", normalize: normalizeFeedUrl },
  // The two dials are closed sets, not free numbers: a refresh of "1 minute"
  // written by hand would hammer the provider from a machine that cannot see
  // it is doing so.
  calendarRefreshMinutes: { kind: "int", allow: new Set<number>(CALENDAR_REFRESH_CHOICES) },
  calendarHorizonDays: { kind: "int", allow: new Set<number>(CALENDAR_HORIZON_CHOICES) },
  // The cleanup of closed browsers' data, two levels. Level 1 empties only the
  // cache (`null` = never touched = on); level 2 removes the whole store, which
  // cannot be undone (`null` = never touched = off).
  browserStoreCacheReapEnabled: { kind: "bool" },
  browserStoreReapEnabled: { kind: "bool" },
  // A dial and not a closed set, but a bounded one: a number outside 7..365 is
  // brought back to the nearest limit rather than refused, so a person who
  // types 3 gets the shortest wait there is instead of an error.
  browserStoreReapAfterDays: { kind: "int", clamp: clampBrowserStoreReapDays },
  // Where an agent CLI was pointed at by hand. The canonical writer is
  // `POST /api/providers/cli/configure`, which checks the file is there and is
  // executable before writing: a path that does not exist would register a
  // provider that cannot answer. The field is here because `FIELD_RULES` is
  // exhaustive over `AppSettings`, and a plain PUT can still CLEAR it (null).
  agentBinPaths: { kind: "string" },
  firstRunDoneAt: { kind: "string" },
  securityAlertsProjectId: { kind: "string" },
  topicsCheck: { kind: "string" },
  // Worktrees (change worktree-standard, T1). The root is normalised before it
  // is written (`~` expanded, absolute, not a temp, system or home folder); the
  // checks that need the disk and the projects run in the PUT below, which also
  // names the reason of a refusal.
  worktreeRoot: { kind: "string", normalize: normalizeWorktreeRoot },
  // The three dials are bounded, not closed sets: a number outside its range is
  // brought back to the nearest limit, like the browser-store days.
  worktreeMaxPerProject: { kind: "int", clamp: (n) => clampInto(n, WORKTREE_MAX_PER_PROJECT_RANGE, DEFAULT_WORKTREE_MAX_PER_PROJECT) },
  worktreeDiskFloorGb: { kind: "int", clamp: (n) => clampInto(n, WORKTREE_DISK_FLOOR_RANGE, DEFAULT_WORKTREE_DISK_FLOOR_GB) },
  cargoTargetMode: { kind: "string", allow: new Set<string>(CARGO_TARGET_MODES) },
  gcForeign: { kind: "string", allow: new Set<string>(GC_FOREIGN_MODES) },
  worktreeAbandonDays: { kind: "int", clamp: (n) => clampInto(n, WORKTREE_ABANDON_DAYS_RANGE, DEFAULT_WORKTREE_ABANDON_DAYS) },
  claudeWorktreeHooks: { kind: "string", allow: new Set<string>(CLAUDE_WORKTREE_HOOK_MODES) },
  worktreeQuarantineDays: { kind: "int", clamp: (n) => clampInto(n, WORKTREE_QUARANTINE_DAYS_RANGE, DEFAULT_WORKTREE_QUARANTINE_DAYS) },
};

/** Coerce+validate an incoming patch. Returns the clean patch or errors. */
function parsePatch(body: Record<string, unknown>): {
  patch: Partial<AppSettings>;
  errors: ValidationError[];
} {
  const patch: Partial<AppSettings> = {};
  const errors: ValidationError[] = [];

  // A "string | null" field with an optional allow-set.
  const str = (
    key: keyof AppSettings,
    v: unknown,
    allow?: Set<string>,
    normalize?: (raw: string) => string | null,
  ) => {
    if (v === null) { (patch as any)[key] = null; return; }
    if (typeof v !== "string" || v.trim() === "") {
      errors.push({ field: key, message: "expected a non-empty string or null" });
      return;
    }
    const val = normalize ? normalize(v) : v.trim();
    if (val === null) {
      errors.push({ field: key, message: "not a valid value for this field" });
      return;
    }
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

  const int = (key: keyof AppSettings, v: unknown, allow?: Set<number>, clamp?: (n: number) => number) => {
    if (v === null) { (patch as any)[key] = null; return; }
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (clamp) {
      // A bounded dial: any number is brought inside its range, only a value
      // that is not a number at all is refused.
      if (Number.isNaN(n)) {
        errors.push({ field: key, message: "expected a number or null" });
        return;
      }
      (patch as Record<string, unknown>)[key] = clamp(n);
      return;
    }
    if (!Number.isInteger(n) || n <= 0) {
      errors.push({ field: key, message: "expected a positive integer or null" });
      return;
    }
    if (allow && !allow.has(n)) {
      errors.push({ field: key, message: `expected one of: ${[...allow].join(", ")}` });
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
      case "string": str(key, v, rule.allow ?? rule.allowFrom?.(), rule.normalize); break;
      case "int": int(key, v, rule.allow, rule.clamp); break;
      case "bool": bool(key, v); break;
    }
  }

  return { patch, errors };
}

/**
 * What the root check reads of this machine: its home, its temp folder and the
 * disk. The server passes nothing and gets the real ones; a test names its own,
 * so the verdict does not depend on where its checkout or its HOME happen to be.
 */
interface RootCheckHost {
  home?: string;
  osTmp?: string;
  nonEmpty?: (abs: string) => boolean;
}

const folderHoldsSomething = (abs: string): boolean => {
  try { return readdirSync(abs).some((n) => n !== ".DS_Store"); } catch { return false; }
};

/**
 * The whole validation of a settings patch: every field by its rule, and the
 * worktree root judged against THIS machine. Shared with the worktree policy a
 * primary sends its node, so both doors refuse the same values and a node judges
 * the root against its own home, temp folder and disk, never the primary's.
 *
 * THE SERVER DECIDES WHERE THE CLEANUP MAY LOOK. Every subfolder of the root is
 * judged by the GC, so a root that holds anything but Topics' worktrees (the
 * home, a parent of it, a folder of projects, a folder of documents) is refused
 * with its reason: on 24/11/2026 a GC pass over the wrong folder removed 30 real
 * ones. A root inside a repository nests checkouts in it (watchers and indexers
 * walk each one): refused too.
 */
export function validateSettingsPatch(
  body: Record<string, unknown>,
  projects: ReadonlyArray<{ path?: string | null }>,
  host: RootCheckHost = {},
): { patch: Partial<AppSettings>; errors: ValidationError[] } {
  const { patch, errors } = parsePatch(body);
  const rawRoot = body.worktreeRoot;
  if (typeof rawRoot === "string" && rawRoot.trim() !== "") {
    const verdict = worktreeRootRefusal(rawRoot, {
      projectPaths: projects.map((p) => p.path).filter((p): p is string => !!p),
      nonEmpty: host.nonEmpty ?? folderHoldsSomething,
      isTopicsRoot: (abs) => hasRootSentinel(abs) || resolve(abs) === resolve(defaultWorktreeRootDir()),
    }, { home: host.home, osTmp: host.osTmp });
    for (let i = errors.length - 1; i >= 0; i--) if (errors[i]!.field === "worktreeRoot") errors.splice(i, 1);
    if ("refusal" in verdict) {
      errors.push({ field: "worktreeRoot", code: verdict.refusal, message: ROOT_REFUSAL_TEXT[verdict.refusal] });
    } else {
      // What is stored is exactly the path that was judged.
      patch.worktreeRoot = verdict.root;
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

export function createAppSettingsRouter(ctx: AppContext, host: RootCheckHost = {}): RouteHandler {
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
      // A read that failed is a 503, never a 200 with every field NULL: NULL
      // means "never touched", and level 1 of the cleanup of closed browsers' data
      // reads never touched as ON. The reaper takes any other status as no
      // permission.
      try {
        return json({ settings: readAppSettings() });
      } catch (err) {
        console.warn("[app-settings] the settings row could not be read:", err);
        return json({ ok: false, error: "settings unreadable" }, 503);
      }
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
      const { patch, errors } = validateSettingsPatch(parsed as Record<string, unknown>, ctx.projectStore?.list?.() ?? [], host);
      if (errors.length > 0) {
        return json({ ok: false, errors }, 400);
      }
      updateAppSettings(patch);
      // Direct API defaults apply on the next turn. Push the same model into
      // every composer's snapshot now, so its label agrees with that request.
      if ("openaiModel" in patch || "openaiMaxTokens" in patch) getSnapshotManager().invalidate("openai");
      if ("claudeModel" in patch || "claudeMaxTokens" in patch) getSnapshotManager().invalidate("claude");
      // L'interruttore della presence deve valere SUBITO. Senza questo, un
      // «accendi» avrebbe effetto al prossimo giro del servizio — fino a
      // quindici secondi di pannello acceso e profilo Discord vuoto, che si
      // legge come una spunta rotta. Non si aspetta l'esito: la risposta a chi
      // salva non dipende da Discord.
      if ("discordPresenceEnabled" in patch || "discordDetailLevel" in patch) {
        void reconcileDiscordPresence().catch(() => { /* lo stato lo racconta /api/profile/discord */ });
      }
      // A calendar that changed address, window or switch must not answer out
      // of the previous one: the cached agenda is dropped here, at the only
      // place those settings can change.
      if ("calendarFeedUrl" in patch || "calendarEnabled" in patch || "calendarHorizonDays" in patch) {
        resetCalendarCache();
      }
      // Re-pick the default provider so an aiProvider change is reflected live.
      const changed = recomputeDefault();
      if (changed) {
        ctx.broadcastToAll?.({ type: "gateway:status", connected: true });
      }
      // The answer is read back with the strict reader, the rule of the GET: the
      // settings panel draws this answer, and an all-NULL one would draw level 1
      // of the cleanup of closed browsers' data ON at 60 days over a stored OFF. The
      // write has landed by now and the hooks above ran; only the answer fails.
      let settings: AppSettings;
      try {
        settings = readAppSettings();
      } catch (err) {
        console.warn("[app-settings] saved, but the settings row could not be read back:", err);
        return json({ ok: false, error: "settings saved but unreadable" }, 503);
      }
      return json({ ok: true, settings, default: getDefaultProviderName() ?? null });
    }

    return null;
  };
}
