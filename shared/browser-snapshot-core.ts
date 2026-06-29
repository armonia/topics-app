/**
 * Shared, dependency-free core of the ref-based accessibility snapshot model.
 *
 * The SAME source of truth for BOTH halves:
 *   - server (`server/browser-snapshot.ts` re-exports from here and adds the
 *     Playwright `Page`-operating helpers for the CDP/web paths), and
 *   - client (`client/src/lib/shell/tauriBrowserOps.ts` injects `SNAPSHOT_FN`
 *     / `ACT_FN` / `EXTRACT_FN` into the native WKWebView via `browser_eval_js`
 *     and serializes with the SAME `serialize`/`diff`).
 *
 * Keeping the snapshot builder, the text serializer and the diff here — with NO
 * imports — guarantees the agent reads the IDENTICAL snapshot/diff format on the
 * Electron CDP pane and the Tauri native pane, so the two are interchangeable.
 *
 * The `*_FN` constants are fully self-contained (DOM globals only, no outer-scope
 * references) so they survive `Function.prototype.toString()` and run verbatim in
 * the page. Do NOT reference module-scope identifiers inside them.
 */

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
 * Typed loosely (`any`) on DOM nodes because it never runs in Node.
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

/**
 * In-page actor — resolves `[data-topics-ref="N"]` (stamped by SNAPSHOT_FN) and
 * performs the action with synthetic DOM events. MUST be self-contained (it is
 * stringified and run in the page). NOTE: events are NOT trusted (isTrusted=false),
 * unlike the Electron CDP path's `Input.dispatch*`. Covers the vast majority of
 * sites; a few inputs that require trusted events (native file pickers, some
 * frameworks) will differ — the user can fall back to streaming mode there.
 */
export const ACT_FN = (p: {
  ref?: number;
  action: string;
  text?: string;
  value?: string;
  key?: string;
  dy?: number;
}): { ok: boolean; error?: string } => {
  const action = p.action;
  const fireEvent = (el: any, type: string): void => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  };
  const keyEvent = (el: any, type: string, key: string): void => {
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
  };

  // Ref-less actions.
  if (action === "scroll") {
    window.scrollBy(0, typeof p.dy === "number" ? p.dy : 600);
    return { ok: true };
  }
  if (action === "press" && p.ref == null) {
    const el: any = document.activeElement || document.body;
    const key = p.key || "Enter";
    keyEvent(el, "keydown", key);
    keyEvent(el, "keyup", key);
    return { ok: true };
  }

  const el: any = document.querySelector(`[data-topics-ref="${p.ref}"]`);
  if (!el)
    return {
      ok: false,
      error: `ref ${p.ref} not found on the page (stale snapshot? call browser_observe again, then act)`,
    };
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {
    /* scrollIntoView is best-effort */
  }

  switch (action) {
    case "click":
      el.click();
      break;
    case "dblclick":
      el.click();
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      break;
    case "hover":
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      break;
    case "fill": {
      const v = p.text || "";
      el.focus();
      if (el.isContentEditable) el.textContent = v;
      else el.value = v;
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    }
    case "type": {
      const v = p.text || "";
      el.focus();
      if (el.isContentEditable) el.textContent = "";
      else el.value = "";
      for (const ch of v) {
        keyEvent(el, "keydown", ch);
        if (el.isContentEditable) el.textContent += ch;
        else el.value += ch;
        fireEvent(el, "input");
        keyEvent(el, "keyup", ch);
      }
      fireEvent(el, "change");
      break;
    }
    case "select": {
      const want = p.value != null ? p.value : p.text || "";
      let matched = false;
      const opts = el.options ? Array.from(el.options) : [];
      for (const o of opts as any[]) {
        if (o.value === want || (o.textContent || "").trim() === want) {
          el.value = o.value;
          matched = true;
          break;
        }
      }
      if (!matched) el.value = want;
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    }
    case "check":
      el.checked = true;
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    case "uncheck":
      el.checked = false;
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    case "press": {
      const key = p.key || "Enter";
      keyEvent(el, "keydown", key);
      keyEvent(el, "keyup", key);
      break;
    }
    default:
      return { ok: false, error: `unsupported action ${action}` };
  }
  return { ok: true };
};

/**
 * In-page deterministic CSS-selector scrape — same contract as the server's
 * `extractFieldsOnPage` inner function. Self-contained (stringified + run in
 * the page).
 */
export const EXTRACT_FN = (spec: Record<string, any>): Record<string, unknown> => {
  const read = (el: any, attr?: string): string | null => {
    if (!el) return null;
    if (attr) return el.getAttribute(attr);
    return ((el.innerText || el.value || "") as string).trim();
  };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(spec)) {
    const v = spec[k];
    if (typeof v === "string") {
      out[k] = read(document.querySelector(v));
    } else if (v && v.all) {
      out[k] = Array.from(document.querySelectorAll(v.selector)).map((e) =>
        read(e, v.attr),
      );
    } else if (v) {
      out[k] = read(document.querySelector(v.selector), v.attr);
    } else {
      out[k] = null;
    }
  }
  return out;
};
