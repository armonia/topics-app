/**
 * `GET /api/calendar/agenda` -- what is on, for whoever is drawing it.
 * `POST /api/calendar/probe` -- does THIS address answer, before it is saved.
 *
 * TWO ROUTES AND NOT ONE, because they answer to two different moments. The
 * agenda reads the CONFIGURED feed and is the sidebar's question; the probe
 * reads an address it is handed and is the settings panel's, asked while the
 * field is still being typed and nothing has been written yet. Making the
 * panel save first in order to find out whether it works would leave a broken
 * URL stored on the first typo.
 *
 * THE SECRET GOES ONE WAY. The feed URL enters through `PUT /api/app-settings`
 * and leaves through nothing here: neither route echoes it, so an agenda
 * travelling to a phone on the same Wi-Fi cannot carry a link that reads the
 * whole calendar.
 */
import type { AppContext, RouteHandler } from "../types";
import { getAgenda, probeFeed } from "../services/calendar-feed";

export function createCalendarRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;

  return async function calendarRouter(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> {
    if (pathname === "/api/calendar/agenda" && method === "GET") {
      // `?force=1` is the refresh gesture: it skips the freshness check, not
      // the rest of the path. Everything else about a read stays identical.
      const agenda = await getAgenda({ force: url.searchParams.get("force") === "1" });
      return json(agenda);
    }

    if (pathname === "/api/calendar/probe" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400);
      }
      const feedUrl = (body as { url?: unknown } | null)?.url;
      if (typeof feedUrl !== "string" || feedUrl.trim() === "") {
        return json({ ok: false, error: "expected a calendar feed URL" }, 400);
      }
      // A feed that refuses is not a server error: the answer is 200 with
      // `ok: false` and the reason, because the reason is the whole point of
      // pressing the button.
      return json(await probeFeed(feedUrl));
    }

    return null;
  };
}
