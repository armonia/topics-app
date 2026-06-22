/**
 * Token-careful, ref-based accessibility snapshot — vendored from Jarvis
 * `jarvis-browser/lib/snapshot.mjs` so the Topics native pane drives the
 * browser with the SAME compact, incremental snapshot model Jarvis uses.
 *
 * `SNAPSHOT_FN` runs IN the page: it tags every visible interactive element
 * with a stable `data-topics-ref="N"` attribute and returns a compact
 * descriptor list — never the raw DOM/HTML. Actions then target
 * `[data-topics-ref="N"]`, so the agent drives deterministically from
 * `[N] role "name"` lines with no second LLM and no coordinate math.
 *
 * `serialize()` turns a snapshot into the minimal text the agent reads.
 * `diff()` returns only what changed since the previous snapshot (incremental
 * mode) so repeat steps cost ~0 perception tokens.
 *
 * The page-operating helpers (`snapshotPage`, `actByRefOnPage`,
 * `getTextOnPage`, `extractFieldsOnPage`, `evalOnPage`) are plain
 * `page.evaluate`/`page.locator` calls and work on ANY Playwright `Page` —
 * the server-launched one (web fallback) OR the CDP-resolved WebContentsView
 * (Electron native). One implementation, both render paths.
 *
 * The marker attribute is `data-topics-ref` (distinct from the legacy
 * `data-topics-idx` used by browser-dom-walker.ts) so the two engines clean up
 * independently.
 */
import type { Page } from "playwright-core";

export interface SnapElement {
  ref: number;
  role: string;
  name: string;
  value?: string;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  scrollY: number;
  scrollMaxY: number;
  elements: SnapElement[];
  truncated: boolean;
}

export interface SnapshotDiff {
  /** Minimal text the agent reads. */
  text: string;
  /** Count of added+removed elements (0 = stable structure). */
  changed: number;
  /** True when this is a full serialization (no previous snapshot). */
  full: boolean;
  /** True when the page URL changed since the previous snapshot. */
  navigated?: boolean;
}

export type RefAction =
  | "click"
  | "dblclick"
  | "hover"
  | "fill"
  | "type"
  | "select"
  | "check"
  | "uncheck"
  | "press";

export type ExtractField =
  | string
  | { selector: string; attr?: string; all?: boolean };
export type ExtractFields = Record<string, ExtractField>;

/**
 * In-page snapshot builder. MUST be fully self-contained — it is serialized and
 * executed in the browser page (DOM globals only, no outer-scope references).
 * Typed loosely (`any`) on DOM nodes because the server tsconfig has strict off
 * for these untyped DOM spots and the function never runs in Node.
 */
export const SNAPSHOT_FN = (opts?: { max?: number }): Snapshot => {
  const max = (opts && opts.max) || 200;
  const nameCap = 120;

  const visible = (el: any): boolean => {
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0")
      return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 || r.height >= 1;
  };

  const txt = (s: any): string => (s || "").replace(/\s+/g, " ").trim();

  const accName = (el: any): string => {
    let n = el.getAttribute("aria-label");
    if (!n) {
      const lb = el.getAttribute("aria-labelledby");
      if (lb)
        n = lb
          .split(/\s+/)
          .map((id: string) => {
            const e = document.getElementById(id);
            return e ? (e as any).innerText : "";
          })
          .join(" ");
    }
    if (!n) n = el.getAttribute("alt");
    if (!n) n = el.getAttribute("placeholder");
    if (!n && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"))
      n = el.getAttribute("name");
    if (!n) n = el.innerText;
    if (!n) n = el.getAttribute("title");
    if (!n) n = el.getAttribute("value");
    n = txt(n);
    if (n.length > nameCap) n = n.slice(0, nameCap - 1) + "…";
    return n;
  };

  const roleOf = (el: any): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      if (t === "hidden") return "hidden";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "disclosure";
    return tag;
  };

  const selector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[role]",
    '[contenteditable=""]',
    '[contenteditable="true"]',
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  document
    .querySelectorAll("[data-topics-ref]")
    .forEach((e) => e.removeAttribute("data-topics-ref"));

  const editable = new Set([
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "searchbox",
  ]);
  const out: SnapElement[] = [];
  const seen = new Set<any>();
  let truncated = false;

  for (const el of Array.from(document.querySelectorAll(selector)) as any[]) {
    if (out.length >= max) {
      truncated = true;
      break;
    }
    if (seen.has(el)) continue;
    seen.add(el);
    const role = roleOf(el);
    if (role === "hidden" || role === "generic") continue;
    if (!visible(el)) continue;
    const name = accName(el);
    if (!name && !editable.has(role)) continue;

    const ref = out.length + 1;
    el.setAttribute("data-topics-ref", String(ref));
    const item: SnapElement = { ref, role, name };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t !== "text") item.type = t;
      if (el.value) item.value = String(el.value).slice(0, 60);
      if (el.checked) item.checked = true;
    }
    if (el.disabled) item.disabled = true;
    out.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollMaxY: Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
    ),
    elements: out,
    truncated,
  };
};

const sig = (e: SnapElement): string =>
  `${e.role}|${e.name}|${e.value || ""}|${e.checked ? 1 : 0}|${e.disabled ? 1 : 0}`;

const line = (e: SnapElement): string => {
  let s = `[${e.ref}] ${e.role}`;
  if (e.name) s += ` "${e.name}"`;
  if (e.type) s += ` <${e.type}>`;
  if (e.value) s += ` =${JSON.stringify(e.value)}`;
  if (e.checked) s += " [checked]";
  if (e.disabled) s += " [disabled]";
  return s;
};

export function serialize(
  snap: Snapshot,
  { header = true }: { header?: boolean } = {},
): string {
  const lines: string[] = [];
  if (header) {
    lines.push(`url: ${snap.url}`);
    lines.push(`title: ${snap.title}`);
    if (snap.scrollMaxY > 0)
      lines.push(`scroll: ${snap.scrollY}/${snap.scrollMaxY}`);
    lines.push(
      `${snap.elements.length} interactive element(s)${snap.truncated ? " (truncated)" : ""}:`,
    );
  }
  for (const e of snap.elements) lines.push(line(e));
  return lines.join("\n");
}

/**
 * Incremental: describe what changed vs the previous snapshot, by accessible
 * signature (role+name+value+state), so unchanged structure costs ~0 tokens.
 */
export function diff(prev: Snapshot | undefined, next: Snapshot): SnapshotDiff {
  if (!prev)
    return { text: serialize(next), changed: next.elements.length, full: true };
  const navigated = prev.url !== next.url;
  const prevBySig = new Map(prev.elements.map((e) => [sig(e), e]));
  const nextBySig = new Map(next.elements.map((e) => [sig(e), e]));

  const added = next.elements.filter((e) => !prevBySig.has(sig(e)));
  const removed = prev.elements.filter((e) => !nextBySig.has(sig(e)));

  const lines: string[] = [];
  if (navigated) lines.push(`navigated -> ${next.url}`);
  else if (prev.title !== next.title) lines.push(`title -> ${next.title}`);
  if (next.scrollMaxY > 0 && next.scrollY !== prev.scrollY)
    lines.push(`scroll: ${next.scrollY}/${next.scrollMaxY}`);

  if (!added.length && !removed.length) {
    lines.push(
      navigated
        ? `${next.elements.length} element(s) (same structure)`
        : "no element changes",
    );
  } else {
    if (added.length) {
      lines.push(`+ ${added.length} new:`);
      added.forEach((e) => lines.push("  " + line(e)));
    }
    if (removed.length)
      lines.push(`- ${removed.length} removed (refs reassigned)`);
  }
  return {
    text: lines.join("\n"),
    changed: added.length + removed.length,
    full: false,
    navigated,
  };
}

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
    const wrapped = `(async () => { ${expression} })()`;
    r = await page.evaluate(wrapped);
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
