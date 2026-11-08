import type { AppContext, RouteHandler } from "../types";
import { profileStatsCached } from "../services/profile-stats";
import { renderBanner } from "../services/profile-banner";
import { getDiscordPresence } from "../services/discord-presence";
import {
  getAppSettings,
  resolveDiscordDetailLevel,
  resolveDiscordPresenceEnabled,
} from "../services/app-settings";
import { DISCORD_DETAIL_LEVELS, type DiscordDetailLevel } from "../../shared/types";

/**
 * Il PROFILO: chi sei qui dentro, e cosa è passato di qui.
 *
 * ── TRE ROTTE, TRE DOMANDE DIVERSE ──────────────────────────────────────────
 *   • `/api/profile/stats`      — le statistiche d'uso (JSON, per il pannello);
 *   • `/api/profile/discord`    — lo stato del filo con Discord e l'ANTEPRIMA
 *                                 di ciò che vedono gli altri, per tutti e tre
 *                                 i livelli di privacy;
 *   • `/api/profile/banner.svg` — le stesse statistiche in un'immagine da
 *                                 incollare fuori.
 *
 * ── QUI NON SI SCRIVE NIENTE ────────────────────────────────────────────────
 * L'interruttore e il livello di dettaglio si scrivono da `PUT
 * /api/app-settings`, che è già la porta di ogni knob globale e li valida in un
 * posto solo. Aprire qui una seconda porta sulla stessa colonna è esattamente
 * il guasto che il commento in cima a `routes/app-settings.ts` racconta per
 * `aiProvider`: due rotte, due idee di cosa sia valido, e una scelta scritta e
 * ignorata insieme.
 *
 * ── L'ANTEPRIMA È LA COSA VERA, NON UN DISEGNO ──────────────────────────────
 * Le tre anteprime escono dalla STESSA funzione che pubblica (`buildActivity`,
 * via `preview()`): ciò che si vede in Impostazioni prima di accendere è ciò
 * che finirà sul profilo. Un'anteprima disegnata dal client sarebbe una
 * promessa scritta due volte, e la copia sbagliata sarebbe quella su cui
 * qualcuno decide se accendere.
 */
export function createProfileRouter(ctx: AppContext): RouteHandler {
  const { db, json, errorResponse } = ctx;

  /** Il nome da mettere in cima al banner: il proprietario dell'installazione,
   *  se c'è. Nessun nome inventato — il banner ha già il suo ripiego. */
  function nameOwner(): string | null {
    try {
      const r = db.query(
        `SELECT p.display_name AS name
           FROM installation_owners io JOIN people p ON p.id = io.person_id
          ORDER BY io.is_default DESC LIMIT 1`,
      ).get() as { name?: string } | null;
      return r?.name ?? null;
    } catch {
      // Schema più vecchio della 084: nessun proprietario da nominare.
      return null;
    }
  }

  return async function profileRouter(
    _req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    if (!pathname.startsWith("/api/profile")) return null;

    // ── Solo il NOME, senza il conto di tutta l'installazione ─────────────
    // `stats` scandisce sessioni, messaggi e token: 992 sessioni e 15.980
    // messaggi solo su questa macchina. Chi vuole sapere come si chiama chi usa
    // l'app (il thread di una scheda, per non firmare un commento «user») non
    // puo' pagare quel conto a ogni apertura, quindi il nome ha la sua porta.
    if (method === "GET" && pathname === "/api/profile/owner") {
      return json({ name: nameOwner() });
    }

    // ── Le statistiche ────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/profile/stats") {
      try {
        return json({ stats: profileStatsCached(db), name: nameOwner() });
      } catch (err) {
        console.error("[Profile] stats:", err);
        return errorResponse(500, (err as Error)?.message || "Failed to compute profile stats");
      }
    }

    // ── Discord: com'è messo il filo, e cosa vedrebbero gli altri ─────────
    if (method === "GET" && pathname === "/api/profile/discord") {
      const settings = getAppSettings();
      const servizio = getDiscordPresence();
      const level = resolveDiscordDetailLevel(settings);
      const enabled = resolveDiscordPresenceEnabled(settings);

      // Senza servizio innestato (contesto ridotto, boot a metà) si risponde
      // «spento» con le anteprime vuote invece di rompersi: il pannello deve
      // poter disegnare la card anche quando il pezzo vivo non c'è.
      const status = servizio?.status() ?? {
        enabled,
        level,
        connection: "off" as const,
        user: null,
        lastError: null,
        lastPublishedAt: null,
        activity: null,
      };

      const preview: Record<DiscordDetailLevel, unknown> = {
        minimal: null,
        activity: null,
        detailed: null,
      };
      for (const l of DISCORD_DETAIL_LEVELS) preview[l] = servizio?.preview(l) ?? null;

      return json({ status: { ...status, enabled, level }, preview });
    }

    // ── Il banner ─────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/profile/banner.svg") {
      try {
        const theme = url.searchParams.get("theme") === "light" ? "light" : "dark";
        const name = url.searchParams.get("name") ?? nameOwner();
        const svg = renderBanner(profileStatsCached(db), {
          name,
          theme,
          subtitle: url.searchParams.get("subtitle"),
        });
        return new Response(svg, {
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            // Cinque minuti, e non di più: è un'immagine che deve invecchiare
            // in fretta perché il suo unico contenuto è «adesso». Il proxy di
            // GitHub ha la sua cache e non guarda questo header — il file da
            // committare si RIGENERA, non si spera che si aggiorni da solo.
            "Cache-Control": "public, max-age=300",
          },
        });
      } catch (err) {
        console.error("[Profile] banner:", err);
        return errorResponse(500, (err as Error)?.message || "Failed to render banner");
      }
    }

    return null;
  };
}
