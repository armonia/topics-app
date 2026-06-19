import type { AppContext, RouteHandler } from "../types";
import type { BrowserService } from "../browser-service";
import type { ElectronCdpDispatcher } from "../browser-cdp-dispatcher";
import {
  handleBrowserOpen,
  handleBrowserObserve,
  handleBrowserAct,
  handleBrowserExtract,
  handleBrowserScreenshot,
  handleBrowserPoint,
} from "../browser-tools-handler";

export function createBrowserRouter(
  ctx: AppContext,
  browserService: BrowserService,
  cdpDispatcher: ElectronCdpDispatcher | null = null,
): RouteHandler {
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
      if (!info) return errorResponse(404, "Browser context not found");
      return json(info);
    }

    // --- Navigate ---
    const navMatch = matchRoute(pathname, "/api/browsers/:id/navigate");
    if (method === "POST" && navMatch) {
      const body = await readJSON(req);
      if (!body?.url) return errorResponse(400, "url required");
      try {
        const result = await browserService.navigate(navMatch.id, body.url);
        return json(result);
      } catch (err: any) {
        return errorResponse(500, `Navigate failed: ${err.message}`);
      }
    }

    // --- Phase 30 BROWSER-CHAT-03 — Agent tool endpoints ---
    // 6 endpoints under /api/browsers/:id/agent/{open|observe|act|extract|screenshot|point}.
    // Each one parses+validates body, calls the tool handler, returns JSON or
    // 4xx with { error }. Handlers may THROW (becomes 500) or RETURN { error }
    // (passed through as 200 with structured error -- failsoft to agent).
    // These MUST come before /interact and /:id-DELETE so a future /agent/foo
    // does not collide with the catch-all interactMatch shape below.
    const agentOpenMatch = matchRoute(pathname, "/api/browsers/:id/agent/open");
    if (agentOpenMatch && method === "POST") {
      try {
        const body = (await req.json()) as { url?: string };
        if (typeof body.url !== "string" || !body.url) {
          return json({ error: "browser_open: url (string) is required" }, 400);
        }
        const result = await handleBrowserOpen(browserService, agentOpenMatch.id, { url: body.url });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/open failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentObserveMatch = matchRoute(pathname, "/api/browsers/:id/agent/observe");
    if (agentObserveMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { max_elements?: unknown };
        let max_elements: number | undefined;
        if (body.max_elements !== undefined) {
          if (typeof body.max_elements !== "number" || !Number.isFinite(body.max_elements)) {
            return json({ error: "browser_observe: max_elements must be a number" }, 400);
          }
          if (body.max_elements < 1 || body.max_elements > 100) {
            return json({ error: "browser_observe: max_elements must be in range 1-100" }, 400);
          }
          max_elements = body.max_elements;
        }
        const result = await handleBrowserObserve(browserService, agentObserveMatch.id, { max_elements });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/observe failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentActMatch = matchRoute(pathname, "/api/browsers/:id/agent/act");
    if (agentActMatch && method === "POST") {
      try {
        const body = (await req.json()) as { element_id?: unknown; action?: unknown; text?: unknown };
        if (typeof body.element_id !== "number" || !Number.isFinite(body.element_id)) {
          return json({ error: "browser_act: element_id (number) is required" }, 400);
        }
        if (body.action !== "click" && body.action !== "type" && body.action !== "select") {
          return json({ error: "browser_act: action must be one of click|type|select" }, 400);
        }
        const text = typeof body.text === "string" ? body.text : undefined;
        const result = await handleBrowserAct(browserService, agentActMatch.id, {
          element_id: body.element_id,
          action: body.action,
          text,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/act failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentExtractMatch = matchRoute(pathname, "/api/browsers/:id/agent/extract");
    if (agentExtractMatch && method === "POST") {
      try {
        const body = (await req.json()) as { schema?: unknown; instruction?: unknown };
        if (!body.schema || typeof body.schema !== "object") {
          return json({ error: "browser_extract: schema (object) is required" }, 400);
        }
        const instruction = typeof body.instruction === "string" ? body.instruction : undefined;
        const result = await handleBrowserExtract(browserService, agentExtractMatch.id, {
          schema: body.schema as Record<string, unknown>,
          instruction,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/extract failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentScreenshotMatch = matchRoute(pathname, "/api/browsers/:id/agent/screenshot");
    if (agentScreenshotMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { full_page?: unknown };
        const full_page = typeof body.full_page === "boolean" ? body.full_page : undefined;
        const result = await handleBrowserScreenshot(browserService, agentScreenshotMatch.id, { full_page });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/screenshot failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentPointMatch = matchRoute(pathname, "/api/browsers/:id/agent/point");
    if (agentPointMatch && method === "POST") {
      try {
        const body = (await req.json()) as { description?: unknown };
        if (typeof body.description !== "string" || !body.description.trim()) {
          return json({ error: "browser_point: description (non-empty string) is required" }, 400);
        }
        const result = await handleBrowserPoint(browserService, agentPointMatch.id, {
          description: body.description,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/point failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    // --- Phase 30.1 BROWSER-CHAT-06 — register CDP targetId for Electron native browser ---
    // Called by client useNativeBrowser hook after WebContentsView creation.
    // POST /api/browsers/:id/cdp-target { cdpTargetId } -> registers in dispatcher
    // DELETE /api/browsers/:id/cdp-target               -> unregisters on view destroy
    const cdpRegisterMatch = matchRoute(pathname, "/api/browsers/:id/cdp-target");
    if (cdpRegisterMatch && method === "POST") {
      if (!cdpDispatcher) return errorResponse(400, "Electron CDP dispatcher not configured (web mode)");
      try {
        const body = (await req.json()) as { cdpTargetId?: string };
        if (typeof body.cdpTargetId !== "string" || !body.cdpTargetId) {
          return errorResponse(400, "cdpTargetId (string) is required");
        }
        cdpDispatcher.registerTarget(cdpRegisterMatch.id, body.cdpTargetId);
        return json({ ok: true, contextId: cdpRegisterMatch.id, cdpTargetId: body.cdpTargetId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(500, msg);
      }
    }
    if (cdpRegisterMatch && method === "DELETE") {
      if (!cdpDispatcher) return json({ ok: true });
      cdpDispatcher.unregisterTarget(cdpRegisterMatch.id);
      return json({ ok: true });
    }

    // --- Phase 30 BROWSER-CHAT-04 — DOM info at a viewport point ---
    // Backs the Cursor Cmd+Shift+E select-element overlay. Pure read endpoint:
    // returns DOM path + CSS selector + bbox + truncated text for the element
    // at (x, y), or 404 if nothing resolves there. Also serves agent flows
    // that want to query DOM context without invoking the full observe path.
    const inspectMatch = matchRoute(pathname, "/api/browsers/:id/inspect");
    if (method === "POST" && inspectMatch) {
      const body = await readJSON(req);
      const x = Number(body?.x);
      const y = Number(body?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return errorResponse(400, "x and y required");
      }
      try {
        const info = await browserService.resolveElementAtPoint(inspectMatch.id, { x, y });
        if (!info) return errorResponse(404, "Element not found at point");
        return json(info);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /inspect failed:`, msg);
        return errorResponse(500, `Inspect failed: ${msg}`);
      }
    }

    // --- Interact (unified REST endpoint for agents) ---
    const interactMatch = matchRoute(pathname, "/api/browsers/:id/interact");
    if (method === "POST" && interactMatch) {
      const body = await readJSON(req);
      if (!body?.action) return errorResponse(400, "action required");
      const id = interactMatch.id;
      try {
        switch (body.action) {
          case "navigate":
            if (!body.url) return errorResponse(400, "url required");
            return json(await browserService.navigate(id, body.url));

          case "click":
            if (body.x == null || body.y == null) return errorResponse(400, "x and y required");
            await browserService.click(id, body.x, body.y, { button: body.button, modifiers: body.modifiers });
            return json({ ok: true });

          case "type":
            if (!body.text) return errorResponse(400, "text required");
            await browserService.type(id, body.text);
            return json({ ok: true });

          case "keypress":
            if (!body.key) return errorResponse(400, "key required");
            await browserService.keypress(id, body.key);
            return json({ ok: true });

          case "scroll":
            await browserService.scroll(id, body.x || 0, body.y || 0, body.deltaX || 0, body.deltaY || 0);
            return json({ ok: true });

          case "hover":
            if (body.x == null || body.y == null) return errorResponse(400, "x and y required");
            await browserService.hover(id, body.x, body.y);
            return json({ ok: true });

          case "evaluate":
            if (!body.script) return errorResponse(400, "script required");
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
            if (!body.selector) return errorResponse(400, "selector required");
            await browserService.clickSelector(id, body.selector, { button: body.button });
            return json({ ok: true });

          case "fill":
            if (!body.selector || body.value == null) return errorResponse(400, "selector and value required");
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
            if (!body.width || !body.height) return errorResponse(400, "width and height required");
            await browserService.resize(id, body.width, body.height);
            return json({ ok: true });

          default:
            return errorResponse(400, `Unknown action: ${body.action}`);
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
      if (!targetUrl) return errorResponse(400, "url parameter required");
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
