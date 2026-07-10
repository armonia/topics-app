import type { AppContext, RouteHandler } from "../types";
import type { BrowserService } from "../browser-service";
import {
  handleBrowserOpen,
  handleBrowserObserve,
  handleBrowserAct,
  handleBrowserExtract,
  handleBrowserGetText,
  handleBrowserEval,
  handleBrowserReadScreen,
  handleBrowserSaveState,
  handleBrowserLoadState,
  handleBrowserScreenshot,
  handleBrowserPoint,
  clearBrowserCaches,
} from "../browser-tools-handler";
import { resetMoondreamCounter } from "../integrations/moondream-client";
import type { BrowserActAction } from "../browser-tools";

export function createBrowserRouter(
  ctx: AppContext,
  browserService: BrowserService,
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
        const body = (await req.json().catch(() => ({}))) as {
          full?: unknown; max?: unknown; max_elements?: unknown; screenshot?: unknown;
        };
        const result = await handleBrowserObserve(browserService, agentObserveMatch.id, {
          full: typeof body.full === "boolean" ? body.full : undefined,
          max: typeof body.max === "number" ? body.max : undefined,
          max_elements: typeof body.max_elements === "number" ? body.max_elements : undefined,
          screenshot: typeof body.screenshot === "boolean" ? body.screenshot : undefined,
        });
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
        const body = (await req.json()) as Record<string, unknown>;
        // Args (ref/element_id, action enum, ref-vs-page requirements) are
        // validated by the handler — single source of truth, no drift.
        const result = await handleBrowserAct(browserService, agentActMatch.id, {
          ref: typeof body.ref === "number" ? body.ref : undefined,
          element_id: typeof body.element_id === "number" ? body.element_id : undefined,
          action: body.action as BrowserActAction,
          text: typeof body.text === "string" ? body.text : undefined,
          value: typeof body.value === "string" ? body.value : undefined,
          key: typeof body.key === "string" ? body.key : undefined,
          dy: typeof body.dy === "number" ? body.dy : undefined,
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
        const body = (await req.json().catch(() => ({}))) as { fields?: unknown; schema?: unknown };
        const result = await handleBrowserExtract(browserService, agentExtractMatch.id, {
          fields: (body.fields && typeof body.fields === "object") ? body.fields as Record<string, unknown> : undefined,
          schema: (body.schema && typeof body.schema === "object") ? body.schema as Record<string, unknown> : undefined,
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

    const agentGetTextMatch = matchRoute(pathname, "/api/browsers/:id/agent/get-text");
    if (agentGetTextMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { ref?: unknown; max?: unknown };
        const result = await handleBrowserGetText(browserService, agentGetTextMatch.id, {
          ref: typeof body.ref === "number" ? body.ref : undefined,
          max: typeof body.max === "number" ? body.max : undefined,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/get-text failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentReadScreenMatch = matchRoute(pathname, "/api/browsers/:id/agent/read-screen");
    if (agentReadScreenMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { question?: unknown; full_page?: unknown };
        const result = await handleBrowserReadScreen(browserService, agentReadScreenMatch.id, {
          question: typeof body.question === "string" ? body.question : undefined,
          full_page: typeof body.full_page === "boolean" ? body.full_page : undefined,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/read-screen failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentEvalMatch = matchRoute(pathname, "/api/browsers/:id/agent/eval");
    if (agentEvalMatch && method === "POST") {
      try {
        const body = (await req.json()) as { expression?: unknown };
        if (typeof body.expression !== "string" || !body.expression.trim()) {
          return json({ error: "browser_eval: expression (non-empty string) is required" }, 400);
        }
        const result = await handleBrowserEval(browserService, agentEvalMatch.id, {
          expression: body.expression,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/eval failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentSaveStateMatch = matchRoute(pathname, "/api/browsers/:id/agent/save-state");
    if (agentSaveStateMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { handle?: unknown };
        const result = await handleBrowserSaveState(browserService, agentSaveStateMatch.id, {
          handle: typeof body.handle === "string" ? body.handle : undefined,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/save-state failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    const agentLoadStateMatch = matchRoute(pathname, "/api/browsers/:id/agent/load-state");
    if (agentLoadStateMatch && method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { handle?: unknown; from_external?: unknown; from_jarvis?: unknown };
        const result = await handleBrowserLoadState(browserService, agentLoadStateMatch.id, {
          handle: typeof body.handle === "string" ? body.handle : undefined,
          from_external: typeof body.from_external === "boolean" ? body.from_external : undefined,
          // Deprecated alias, still accepted for back-compat.
          from_jarvis: typeof body.from_jarvis === "boolean" ? body.from_jarvis : undefined,
        });
        return json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Routes/browser] /agent/load-state failed:`, msg);
        return json({ error: msg }, 500);
      }
    }

    // --- Native browser pane teardown hook ---
    // DELETE /api/browsers/:id/cdp-target — fired by the client when a native
    // browser pane is really closed (useProjectLayout). The path keeps its
    // historical name; there is no Electron CDP target to unregister anymore, but
    // the native pane has no server-side BrowserService context (onDestroy never
    // runs for it), so this is the moment to flush its per-context agent caches +
    // Moondream vision budget so the maps don't outlive the closed view.
    const cdpRegisterMatch = matchRoute(pathname, "/api/browsers/:id/cdp-target");
    if (cdpRegisterMatch && method === "DELETE") {
      clearBrowserCaches(cdpRegisterMatch.id);
      resetMoondreamCounter(cdpRegisterMatch.id);
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
            // Fresh page = fresh vision budget: a multi-step flow that navigates
            // shouldn't stay throttled by the previous page's read_screen calls.
            resetMoondreamCounter(id);
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
            return new Response(buf as unknown as BodyInit, { headers: { "Content-Type": body.format === "png" ? "image/png" : "image/jpeg", "Cache-Control": "no-cache" } });
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
        return new Response(buf as unknown as BodyInit, { headers: { "Content-Type": format === "png" ? "image/png" : "image/jpeg", "Cache-Control": "no-cache" } });
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
        return new Response(buf as unknown as BodyInit, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" } });
      } catch (err: any) {
        await browserService.destroyContext(tempId).catch(() => {});
        return errorResponse(500, `Screenshot failed: ${err.message}`);
      }
    }

    return null;
  };
}
