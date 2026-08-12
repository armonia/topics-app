/**
 * `GET /api/open` — una query sola per «cosa è aperto».
 *
 * PERCHÉ È UNA ROTTA E NON SOLO UNA FUNZIONE. La domanda che questo endpoint
 * risponde non se la faceva un programma: se la faceva un umano, a mano, con
 * tre query diverse su tre registri, e otteneva tre risposte. Il 03/08:
 * 11 sessioni vive per tab chiuse a luglio, 2 topic «aperti» chiusi da
 * settimane. Finché la risposta costa tre query nessuno la fa, quindi la
 * divergenza non si vede finché non è vecchia di un mese.
 *
 * `divergences` è la parte che conta. Vuoto significa che i tre registri
 * concordano col fatto — cioè che la risposta qui sopra è la stessa cosa che
 * si vede sullo schermo. Non vuoto dice esattamente dove non concordano, e il
 * riconcilio al boot (`services/retirement.ts#reconcile`) sa già ripararlo.
 *
 * Sola lettura, sempre. Riparare da una GET vorrebbe dire che aprire una
 * pagina di diagnostica archivia chat — e la diagnosi va potuta fare senza
 * cambiare ciò che si sta diagnosticando.
 */
import type { AppContext, RouteHandler } from "../types";
import { listOpen } from "../services/retirement";

export function createOpenRouter(ctx: AppContext): RouteHandler {
  const { db, json } = ctx;

  return async function openRouter(_req: Request, _url: URL, pathname: string, method: string): Promise<Response | null> {
    if (method !== "GET" || pathname !== "/api/open") return null;
    try {
      const inv = listOpen(db);
      return json({
        ...inv,
        counts: {
          topics: inv.topics.length,
          terminals: inv.terminals.length,
          divergences: inv.divergences.length,
        },
      });
    } catch (err: any) {
      return json({ error: err?.message ?? "internal error" }, 500);
    }
  };
}
