/**
 * `browser_verify` on a Playwright pane: reload (or navigate), wait for the
 * page with its stylesheets, then hand the agent the evidence of its change —
 * a screenshot on disk, the console errors and failed requests of that load,
 * and each check with the value it read. The native pane has its own executor
 * (client/src/lib/shell/tauriBrowserOps.ts).
 */
import type { BrowserService } from "./browser-service";
import { clearBrowserCaches, withLock, writeAgentScreenshot } from "./browser-tools-handler";

export interface BrowserVerifyCheck {
  selector: string;
  text?: string;
  visible?: boolean;
  style?: Record<string, string>;
}

/** Reload the open page and return observable evidence for the requested change. */
export async function handleBrowserVerify(
  service: BrowserService,
  contextId: string,
  args: { url?: string; checks?: BrowserVerifyCheck[] },
): Promise<unknown> {
  if (args.url !== undefined && (typeof args.url !== "string" || !args.url.trim())) {
    throw new Error("browser_verify: 'url' must be a non-empty absolute URL");
  }
  if (args.checks !== undefined && (!Array.isArray(args.checks) || args.checks.length > 30)) {
    throw new Error("browser_verify: 'checks' must contain at most 30 entries");
  }
  const checks = args.checks ?? [];
  for (const check of checks) {
    if (!check || typeof check.selector !== "string" || !check.selector.trim()) {
      throw new Error("browser_verify: every check requires a non-empty selector");
    }
    if (check.text === undefined && check.visible === undefined && check.style === undefined) {
      throw new Error(`browser_verify: check '${check.selector}' needs text, visible, or style`);
    }
    if (check.text !== undefined && typeof check.text !== "string") {
      throw new Error(`browser_verify: text for '${check.selector}' must be a string`);
    }
    if (check.visible !== undefined && typeof check.visible !== "boolean") {
      throw new Error(`browser_verify: visible for '${check.selector}' must be a boolean`);
    }
    if (check.style && (typeof check.style !== "object" || Array.isArray(check.style) ||
      Object.keys(check.style).length === 0 || Object.values(check.style).some((value) => typeof value !== "string"))) {
      throw new Error(`browser_verify: style values for '${check.selector}' must be strings`);
    }
  }

  const startedAt = Date.now();
  try {
    return await withLock(service, contextId, async () => {
      const entry = await service.getOrCreate(contextId);
      const page = entry.page;
      clearBrowserCaches(contextId);
      try {
        const deadline = Date.now() + 15_000;
        if (args.url) {
          const navigation = await service.navigate(contextId, args.url, { timeoutMs: 15_000 });
          if (navigation.error) throw new Error(navigation.error);
          // navigate() resolves at domcontentloaded, before external stylesheets:
          // a style check right after it reads the old value.
          await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) });
        } else {
          await page.reload({ waitUntil: "load", timeout: 15_000 });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `browser_verify: page did not finish loading within 15 s: ${msg}` };
      }
      try {
        const results = await page.evaluate((items: BrowserVerifyCheck[]) => items.map((check) => {
      let element: Element | null = null;
      try {
        element = document.querySelector(check.selector);
      } catch (error) {
        return { selector: check.selector, status: "fail", value: null, error: error instanceof Error ? error.message : String(error) };
      }
      if (!element) return { selector: check.selector, status: "fail", value: null, error: "element not found" };

      const value: Record<string, unknown> = {};
      const failures: string[] = [];
      if (check.text !== undefined) {
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        value.text = text;
        if (!text.includes(check.text)) failures.push(`text does not contain ${JSON.stringify(check.text)}`);
      }
      if (check.visible !== undefined) {
        const style = getComputedStyle(element);
        const visible = element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
        value.visible = visible;
        if (visible !== check.visible) failures.push(`visible was ${visible}`);
      }
      if (check.style) {
        const style = getComputedStyle(element);
        const found: Record<string, string> = {};
        for (const [property, expected] of Object.entries(check.style)) {
          const actual = style.getPropertyValue(property).trim();
          found[property] = actual;
          if (actual !== expected) failures.push(`${property} was ${JSON.stringify(actual)}`);
        }
        value.style = found;
      }
      return { selector: check.selector, status: failures.length ? "fail" : "pass", value, ...(failures.length ? { error: failures.join("; ") } : {}) };
        }), checks);

        const consoleErrors = service.getConsoleMessages(contextId)
          .filter((item) => item.timestamp >= startedAt && item.level === "error")
          .map(({ level, text }) => ({ level, text }));
        const failedRequests = service.getNetworkEntries(contextId)
          .filter((item) => item.startedAt >= startedAt && (Boolean(item.failure) || (item.status ?? 0) >= 400));
        const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
        const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const path = await writeAgentScreenshot(screenshot, contextId);
        return {
          url: page.url(),
          title: await page.title().catch(() => ""),
          screenshot: { format: "jpeg", path, bytes: screenshot.length, viewport },
          consoleErrors,
          failedRequests,
          checks: results,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `browser_verify failed: ${msg}` };
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `browser_verify failed: ${msg}` };
  }
}
