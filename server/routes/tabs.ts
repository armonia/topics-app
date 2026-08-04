/**
 * `GET /api/tabs/resolve?ref=<link|path>` — l'unica porta HTTP del resolver dei
 * permalink alle tab.
 *
 * SOLA LETTURA, e nessuna credenziale nuova: `/api/` passa già dal gate unico
 * (`server/lib/auth-gate.ts` — loopback fidato, un peer remoto deve presentare
 * il token di pairing), e una GET non tocca nemmeno il ramo CSRF. Aggiungere qui
 * un'autenticazione propria vorrebbe dire avere due gate che possono divergere.
 *
 * Un solo `ref` per chiamata, di proposito: l'alternativa — «elencami tutte le
 * tab» — riverserebbe nel contesto del modello url, titoli e cwd di ogni
 * finestra aperta dell'utente. Vedi l'header di `server/lib/tab-resolver.ts`.
 */
import type { AppContext, RouteHandler } from "../types";
import type { BrowserService } from "../browser-service";
import { resolveTabRef } from "../lib/tab-resolver";
import { tabResolverDeps } from "../lib/tab-resolver-deps";

export function createTabsRouter(ctx: AppContext, browserService: BrowserService | null): RouteHandler {
  const { json, errorResponse } = ctx;
  // Le stesse deps che riceve il control-tool `resolve_tab` della chat SDK: la
  // costruzione è una sola (`lib/tab-resolver-deps.ts`), altrimenti i due canali
  // divergono sulle fonti e la stessa tab risponde diversamente.
  const deps = tabResolverDeps(ctx, browserService);

  return function tabsRouter(_req: Request, url: URL, pathname: string, method: string): Response | null {
    if (method !== "GET" || pathname !== "/api/tabs/resolve") return null;

    const ref = url.searchParams.get("ref");
    if (!ref || !ref.trim()) {
      return errorResponse(400, "ref required (a /tab/… permalink or path)");
    }

    const resolved = resolveTabRef(ref, deps);

    if (!resolved) {
      // Non è un permalink: la grammatica non lo riconosce. 400, non 404 — non
      // stiamo dicendo che la tab non esiste, stiamo dicendo che il ref non è
      // un link a una tab.
      return errorResponse(400, "ref is not a tab permalink");
    }

    return json(resolved);
  };
}
