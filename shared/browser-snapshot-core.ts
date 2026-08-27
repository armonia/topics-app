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
  | "triple_click"
  | "hover"
  | "fill"
  | "clear"
  | "type"
  | "select"
  | "check"
  | "uncheck"
  | "press";

/**
 * SINGLE source of truth for browser_act's action set — imported by BOTH the
 * native validator (client `tauriBrowserOps`) and the server validator
 * (`browser-tools-handler`) so the two can never drift. `REF_ACTIONS` need a ref
 * from the latest observe; `press`/`scroll`/`get_text` are ref-optional.
 */
export const REF_ACTIONS = [
  "click",
  "dblclick",
  "triple_click",
  "hover",
  "fill",
  "clear",
  "type",
  "select",
  "check",
  "uncheck",
] as const satisfies readonly RefAction[];

export const ACT_ACTIONS = [...REF_ACTIONS, "press", "scroll", "get_text"] as const;

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

/**
 * "The ref is not on the page any more" - said the same way by both actors: the
 * in-page ACT_FN above and the Playwright locator in server/browser-snapshot.ts.
 * One phrase, one test for it, so the recovery below cannot drift from either.
 */
export const STALE_REF_MARK = "not found on the page";

export function isStaleRefError(message: string | undefined): boolean {
  return !!message && message.includes(STALE_REF_MARK);
}

/**
 * Where the element that USED to carry `ref` lives in a fresher snapshot.
 *
 * A ref is a position in a listing, not an identity: a re-render renumbers in
 * DOM order, so the button the caller aimed at is often still on the page under
 * another number. Identity here is the diff's own signature (role, name, value,
 * checked, disabled) - the same one that decides what counts as "changed", so
 * an element the diff calls unchanged is an element this function can follow.
 *
 * Ambiguity is a NO: with two identical signatures (two "Delete" buttons in a
 * table) picking either one would be guessing, and guessing which row to delete
 * is exactly the click nobody wants retried. Returns undefined, and the caller
 * hands back the fresh snapshot instead.
 */
export function refAfterResnapshot(
  prev: Snapshot | undefined,
  next: Snapshot,
  ref: number,
): number | undefined {
  if (!prev || prev.url !== next.url) return undefined; // another page: no identity to follow
  const was = prev.elements.find((e) => e.ref === ref);
  if (!was) return undefined;
  const target = sig(was);
  const matches = next.elements.filter((e) => sig(e) === target);
  return matches.length === 1 ? matches[0].ref : undefined;
}

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
  { header = true, maxChars = 12000 }: { header?: boolean; maxChars?: number } = {},
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
  // Total-size budget: the element cap (200) bounds the COUNT, but a page of
  // long-named links can still serialize to ~28KB (~7-8k tokens). Stop emitting
  // once the budget is hit and note the remainder, so a content-heavy page can't
  // blow the agent's context. Normal pages sit far below and are unaffected.
  let chars = lines.reduce((n, l) => n + l.length + 1, 0);
  let emitted = 0;
  for (const e of snap.elements) {
    const l = line(e);
    if (chars + l.length + 1 > maxChars) break;
    lines.push(l);
    chars += l.length + 1;
    emitted++;
  }
  if (emitted < snap.elements.length) {
    lines.push(`… +${snap.elements.length - emitted} more element(s) omitted (size budget)`);
  }
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
  // React (and other controlled-input libs) install a value tracker on the
  // element; a plain `el.value = x` is reverted on the next render and the
  // framework's onChange never fires (→ submit buttons stay disabled). Writing
  // through the element's OWN prototype native setter bypasses the tracker so
  // onChange actually fires. MUST pick textarea-vs-input prototype or it no-ops.
  const nativeSet = (el: any, value: string): void => {
    try {
      const proto =
        typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
        return;
      }
    } catch {
      /* fall through to the plain assignment */
    }
    el.value = value;
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
      else nativeSet(el, v);
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    }
    case "clear": {
      el.focus();
      if (el.isContentEditable) el.textContent = "";
      else nativeSet(el, "");
      fireEvent(el, "input");
      fireEvent(el, "change");
      break;
    }
    case "triple_click": {
      // Select-all-in-field (the trusted-events-free way to clear/replace a value
      // without Meta+A): focus, native select(), and emit three click events with
      // a rising detail so listeners that gate on detail===3 also fire.
      el.focus();
      try {
        if (typeof el.select === "function") el.select();
      } catch {
        /* select is best-effort */
      }
      for (let i = 1; i <= 3; i++)
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: i }));
      break;
    }
    case "type": {
      const v = p.text || "";
      el.focus();
      let acc = "";
      if (el.isContentEditable) el.textContent = "";
      else nativeSet(el, "");
      for (const ch of v) {
        keyEvent(el, "keydown", ch);
        acc += ch;
        if (el.isContentEditable) el.textContent = acc;
        else nativeSet(el, acc);
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

/**
 * In-page file upload: set a base64-encoded file onto an `<input type=file>` and
 * fire input/change, exactly as if the OS file dialog had picked it. Self-contained
 * (stringified + run in the page) so it works on EVERY surface — server Playwright /
 * Electron CDP via `evalExpression`, and the Tauri WKWebView via `browser_eval_js`.
 * Assigns `input.files` through a DataTransfer (the one supported way to set a file
 * programmatically). Targets the element carrying `data-topics-ref` (from the latest
 * browser_observe) when `ref` is given, else the first file input; if the ref is a
 * wrapper (label/button), it looks for a file input inside. Returns a JSON string so
 * the eval bridges (which stringify results) round-trip a structured result.
 * NOTE: the change event is untrusted (isTrusted=false) — covers the vast majority
 * of upload widgets; a few that demand a trusted picker will differ.
 */
/**
 * In-page status probe: current url/title/viewport/loading as a JSON string.
 * Runs identically on every surface (server Playwright / Electron CDP via
 * evalExpression, Tauri WKWebView via browser_eval_js). Fixes the hardcoded
 * 1280×720 viewport stub — the agent gets the pane's REAL viewport.
 */
export const STATUS_JS =
  "JSON.stringify({url:location.href,title:document.title," +
  "viewport:{width:Math.round(innerWidth),height:Math.round(innerHeight)}," +
  "loading:document.readyState!=='complete'})";

export const UPLOAD_FN = (p: {
  ref?: number;
  dataB64: string;
  filename?: string;
  mime?: string;
}): string => {
  try {
    const q = (sel: string): any => document.querySelector(sel);
    let input: any =
      p.ref != null ? q('[data-topics-ref="' + p.ref + '"]') : q('input[type=file]');
    if (!input)
      return JSON.stringify({
        error: p.ref != null ? "no element with ref " + p.ref : "no <input type=file> found",
      });
    if (!(input.tagName === "INPUT" && input.type === "file")) {
      const inner = input.querySelector && input.querySelector('input[type=file]');
      if (inner) input = inner;
      else return JSON.stringify({ error: "ref " + p.ref + " is not a file input" });
    }
    const bin = atob(p.dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], p.filename || "upload", {
      type: p.mime || "application/octet-stream",
    });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, name: file.name, size: file.size, type: file.type });
  } catch (e: any) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
};
