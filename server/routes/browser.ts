import type { AppContext, RouteHandler } from "../types";
import type { BrowserService } from "../browser-service";

export function createBrowserRouter(ctx: AppContext, browserService: BrowserService): RouteHandler {
  const { readJSON, json, errorResponse, matchRoute, broadcast } = ctx;

  return async function browserRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // --- Browser status ---
    if (method === "GET" && pathname === "/api/browser/status") {
      const contexts = browserService.listContexts();
      return json({
        running: browserService.isLaunched(),
        contexts: contexts.length,
        details: contexts,
      });
    }

    // --- List browser contexts ---
    if (method === "GET" && pathname === "/api/browsers") {
      return json(browserService.listContexts());
    }

    // --- Get context info ---
    const getMatch = matchRoute(pathname, "/api/browsers/:id");
    if (method === "GET" && getMatch && !pathname.includes("/snapshot") && !pathname.includes("/console") && !pathname.includes("/interact")) {
      const info = browserService.getUrl(getMatch.id);
      if (!info) return json({ error: "Browser context not found" }, 404);
      return json(info);
    }

    // --- Navigate ---
    const navMatch = matchRoute(pathname, "/api/browsers/:id/navigate");
    if (method === "POST" && navMatch) {
      const body = await readJSON(req);
      if (!body?.url) return json({ error: "url required" }, 400);
      try {
        const result = await browserService.navigate(navMatch.id, body.url);
        return json(result);
      } catch (err: any) {
        return errorResponse(500, `Navigate failed: ${err.message}`);
      }
    }

    // --- Interact (unified REST endpoint for agents) ---
    const interactMatch = matchRoute(pathname, "/api/browsers/:id/interact");
    if (method === "POST" && interactMatch) {
      const body = await readJSON(req);
      if (!body?.action) return json({ error: "action required" }, 400);
      const id = interactMatch.id;
      try {
        switch (body.action) {
          case "navigate":
            if (!body.url) return json({ error: "url required" }, 400);
            return json(await browserService.navigate(id, body.url));

          case "click":
            if (body.x == null || body.y == null) return json({ error: "x and y required" }, 400);
            await browserService.click(id, body.x, body.y, { button: body.button, modifiers: body.modifiers });
            return json({ ok: true });

          case "type":
            if (!body.text) return json({ error: "text required" }, 400);
            await browserService.type(id, body.text);
            return json({ ok: true });

          case "keypress":
            if (!body.key) return json({ error: "key required" }, 400);
            await browserService.keypress(id, body.key);
            return json({ ok: true });

          case "scroll":
            await browserService.scroll(id, body.x || 0, body.y || 0, body.deltaX || 0, body.deltaY || 0);
            return json({ ok: true });

          case "hover":
            if (body.x == null || body.y == null) return json({ error: "x and y required" }, 400);
            await browserService.hover(id, body.x, body.y);
            return json({ ok: true });

          case "evaluate":
            if (!body.script) return json({ error: "script required" }, 400);
            const evalResult = await browserService.evaluate(id, body.script);
            return json({ result: evalResult });

          case "screenshot": {
            const buf = await browserService.screenshot(id, { format: body.format, quality: body.quality, fullPage: body.fullPage });
            return new Response(buf, { headers: { "Content-Type": body.format === "png" ? "image/png" : "image/jpeg", "Cache-Control": "no-cache" } });
          }

          case "snapshot": {
            const snap = await browserService.accessibilitySnapshot(id);
            return json(snap);
          }

          case "click_selector":
            if (!body.selector) return json({ error: "selector required" }, 400);
            await browserService.clickSelector(id, body.selector, { button: body.button });
            return json({ ok: true });

          case "fill":
            if (!body.selector || body.value == null) return json({ error: "selector and value required" }, 400);
            await browserService.fillSelector(id, body.selector, body.value);
            return json({ ok: true });

          case "save_cookies":
            await browserService.saveCookies(id);
            return json({ ok: true });

          case "load_cookies":
            await browserService.loadCookies(id);
            return json({ ok: true });

          case "back":
            return json(await browserService.goBack(id));

          case "forward":
            return json(await browserService.goForward(id));

          case "reload":
            await browserService.reload(id);
            return json({ ok: true });

          case "resize":
            if (!body.width || !body.height) return json({ error: "width and height required" }, 400);
            await browserService.resize(id, body.width, body.height);
            return json({ ok: true });

          default:
            return json({ error: `Unknown action: ${body.action}` }, 400);
        }
      } catch (err: any) {
        return errorResponse(500, `Interact failed: ${err.message}`);
      }
    }

    // --- Snapshot (screenshot) ---
    const snapMatch = matchRoute(pathname, "/api/browsers/:id/snapshot");
    if (method === "GET" && snapMatch) {
      try {
        const format = url.searchParams.get("format") === "png" ? "png" : "jpeg";
        const buf = await browserService.screenshot(snapMatch.id, { format });
        return new Response(buf, { headers: { "Content-Type": format === "png" ? "image/png" : "image/jpeg", "Cache-Control": "no-cache" } });
      } catch (err: any) {
        return errorResponse(500, `Snapshot failed: ${err.message}`);
      }
    }

    // --- Accessibility snapshot (text-based, for agents) ---
    const a11yMatch = matchRoute(pathname, "/api/browsers/:id/a11y");
    if (method === "GET" && a11yMatch) {
      try {
        const snap = await browserService.accessibilitySnapshot(a11yMatch.id);
        const text = `URL: ${snap.url}\nTitle: ${snap.title}\n\n${snap.ariaSnapshot}`;
        return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (err: any) {
        return errorResponse(500, `A11y snapshot failed: ${err.message}`);
      }
    }

    // --- Console messages ---
    const consoleMatch = matchRoute(pathname, "/api/browsers/:id/console");
    if (method === "GET" && consoleMatch) {
      return json(browserService.getConsoleMessages(consoleMatch.id));
    }

    // --- Delete context ---
    const deleteMatch = matchRoute(pathname, "/api/browsers/:id");
    if (method === "DELETE" && deleteMatch) {
      await browserService.destroyContext(deleteMatch.id);
      broadcast({ type: "browser-deleted", id: deleteMatch.id });
      return json({ ok: true });
    }

    // --- Legacy screenshot by URL (creates temp context) ---
    if (method === "GET" && pathname === "/api/browser/screenshot") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return json({ error: "url parameter required" }, 400);
      const tempId = `_temp_${Date.now()}`;
      try {
        await browserService.navigate(tempId, targetUrl);
        const buf = await browserService.screenshot(tempId);
        await browserService.destroyContext(tempId);
        return new Response(buf, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" } });
      } catch (err: any) {
        await browserService.destroyContext(tempId).catch(() => {});
        return errorResponse(500, `Screenshot failed: ${err.message}`);
      }
    }

    return null;
  };
}
