/**
 * Token-careful, ref-based accessibility snapshot — Playwright `Page`-operating
 * half. The snapshot MODEL (the in-page `SNAPSHOT_FN`, the `serialize`/`diff`
 * text format and the shared types) lives in `shared/browser-snapshot-core.ts`
 * so BOTH the server (CDP/web Playwright paths) and the client (Tauri native
 * WKWebView executor) drive the browser with the IDENTICAL snapshot model.
 *
 * This file re-exports that core unchanged (so existing importers of
 * `./browser-snapshot` keep working) and adds the page-operating helpers
 * (`snapshotPage`, `actByRefOnPage`, `getTextOnPage`, `extractFieldsOnPage`,
 * `evalOnPage`) — plain `page.evaluate`/`page.locator` calls that work on ANY
 * Playwright `Page`: the server-launched one (web fallback) OR the
 * CDP-resolved WebContentsView (Electron native). One implementation, both
 * render paths.
 *
 * The marker attribute is `data-topics-ref` (distinct from the legacy
 * `data-topics-idx` used by browser-dom-walker.ts) so the two engines clean up
 * independently.
 */
import type { Page } from "playwright-core";
import {
  SNAPSHOT_FN,
  serialize,
  diff,
  type SnapElement,
  type Snapshot,
  type SnapshotDiff,
  type RefAction,
  type ExtractField,
  type ExtractFields,
} from "../shared/browser-snapshot-core";

// Single source of truth for the snapshot/serialize/diff format, shared with the
// Tauri native pane executor (client/src/lib/shell/tauriBrowserOps.ts).
export { SNAPSHOT_FN, serialize, diff };
export type {
  SnapElement,
  Snapshot,
  SnapshotDiff,
  RefAction,
  ExtractField,
  ExtractFields,
};

// ---------------------------------------------------------------------------
// Page-operating helpers — run on any Playwright Page (web or CDP-resolved).
// ---------------------------------------------------------------------------

const ACTION_TIMEOUT = 15_000;

/** Build the compact ref-based snapshot and stamp `data-topics-ref` on the page. */
export async function snapshotPage(
  page: Page,
  opts?: { max?: number },
): Promise<Snapshot> {
  return (await page.evaluate(SNAPSHOT_FN, {
    max: opts?.max ?? 200,
  })) as Snapshot;
}

/** Act on the element carrying `data-topics-ref="ref"` from the latest snapshot. */
export async function actByRefOnPage(
  page: Page,
  ref: number,
  action: RefAction,
  payload: { text?: string; value?: string; key?: string } = {},
): Promise<void> {
  const loc = page.locator(`[data-topics-ref="${ref}"]`).first();
  const timeout = ACTION_TIMEOUT;
  // Fail fast (and clearly) on a stale/unknown ref instead of waiting the full
  // action timeout for an element that will never appear.
  try {
    await loc.waitFor({ state: "attached", timeout: 3000 });
  } catch {
    throw new Error(
      `ref ${ref} not found on the page (stale snapshot? call browser_observe again, then act)`,
    );
  }
  switch (action) {
    case "click":
      await loc.click({ timeout });
      break;
    case "dblclick":
      await loc.dblclick({ timeout });
      break;
    case "hover":
      await loc.hover({ timeout });
      break;
    case "fill":
      await loc.fill(payload.text ?? "", { timeout });
      break;
    case "type":
      await loc.pressSequentially(payload.text ?? "", { delay: 10, timeout });
      break;
    case "select":
      await loc.selectOption(payload.value ?? payload.text ?? "", { timeout });
      break;
    case "check":
      await loc.check({ timeout });
      break;
    case "uncheck":
      await loc.uncheck({ timeout });
      break;
    case "press":
      await loc.press(payload.key ?? "Enter", { timeout });
      break;
    default: {
      const _exhaustive: never = action;
      throw new Error(`actByRef: unsupported action ${String(_exhaustive)}`);
    }
  }
}

/** Read readable text — a single element (by ref) or the whole page. */
export async function getTextOnPage(
  page: Page,
  ref?: number,
  max = 20_000,
): Promise<{ text: string; truncated: boolean; length: number }> {
  let text: string;
  if (ref != null) {
    text = await page
      .locator(`[data-topics-ref="${ref}"]`)
      .first()
      .innerText({ timeout: ACTION_TIMEOUT })
      .catch(() => "");
  } else {
    text = await page.evaluate(
      () => (document.body ? (document.body as any).innerText : "") as string,
    );
  }
  text = (text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > max;
  return {
    text: truncated ? text.slice(0, max) : text,
    truncated,
    length: text.length,
  };
}

/** Deterministic CSS-selector scrape (0 LLM tokens). */
export async function extractFieldsOnPage(
  page: Page,
  fields: ExtractFields,
): Promise<Record<string, unknown>> {
  return (await page.evaluate((spec: any) => {
    const read = (el: any, attr?: string): string | null => {
      if (!el) return null;
      if (attr) return el.getAttribute(attr);
      return ((el.innerText || el.value || "") as string).trim();
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec)) {
      if (typeof v === "string") {
        out[k] = read(document.querySelector(v));
      } else if (v && (v as any).all) {
        out[k] = Array.from(
          document.querySelectorAll((v as any).selector),
        ).map((e) => read(e, (v as any).attr));
      } else if (v) {
        out[k] = read(
          document.querySelector((v as any).selector),
          (v as any).attr,
        );
      } else {
        out[k] = null;
      }
    }
    return out;
  }, fields as any)) as Record<string, unknown>;
}

/**
 * Run JavaScript in the page sandbox (page context only — CANNOT reach the
 * Node host: the string is shipped over CDP and evaluated by the browser, not
 * by Node). This is the same trust boundary as Playwright's own string-eval
 * and the existing /interact evaluate route. Returns a JSON-serializable
 * result (truncated to 8000 chars). The agent-supplied expression is wrapped
 * in an async IIFE and evaluated via Playwright's native string form (no
 * `new Function` in Node).
 */
export async function evalOnPage(
  page: Page,
  expression: string,
): Promise<{ result: unknown }> {
  // Native pane (raw CDP) exposes replEvaluate → CONSOLE / executeJavaScript
  // semantics: the LAST expression's value is returned (a bare
  // `localStorage.getItem('t')` yields its value, not `{}`), with `const`,
  // multiple statements, and top-level `await` all supported. The old wrapper
  // `(async()=>{ … })()` discarded the value unless the caller wrote `return`.
  // Web/Playwright fallback keeps the async-IIFE wrap (value needs `return`).
  const repl = (page as unknown as { replEvaluate?: (e: string) => Promise<unknown> }).replEvaluate;
  let r: unknown;
  if (typeof repl === "function") {
    r = await repl.call(page, expression);
  } else {
    // Web / Playwright fallback (no replMode available). page.evaluate(string)
    // treats the string as an EXPRESSION, so a bare `document.title` already
    // returns its value — try that first. Only if it's a SyntaxError (the code
    // is statements, e.g. `const x = 1; x + 2`) wrap it in an async IIFE (which
    // discards the completion value unless the caller wrote `return`). This
    // keeps the {} → value fix even off the native CDP path.
    try {
      r = await page.evaluate(expression);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SyntaxError|Illegal return|Unexpected (token|identifier|end)/i.test(msg)) {
        r = await page.evaluate(`(async () => { ${expression} })()`);
      } else {
        throw err;
      }
    }
  }
  let result: unknown = r;
  if (typeof r === "string") {
    result = r.length > 8000 ? r.slice(0, 8000) + "…[truncated]" : r;
  } else {
    try {
      const s = JSON.stringify(r);
      if (s && s.length > 8000) result = s.slice(0, 8000) + "…[truncated]";
    } catch {
      result = String(r);
    }
  }
  return { result };
}
