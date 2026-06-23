/**
 * Raw CDP page driver — a minimal, in-process Chrome DevTools Protocol client
 * that drives an Electron WebContentsView WITHOUT Playwright's `connectOverCDP`.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The topics-app server runs under Bun (`bun run server.ts`). Playwright-core's
 * `chromium.connectOverCDP()` HANGS under Bun (works fine under Node) — the WS
 * "open" never surfaces inside playwright's transport, so it times out after 30s.
 * The raw `ws` package + the native WebSocket BOTH connect to Electron's CDP
 * endpoint fine under Bun, so we talk CDP directly over `ws`.
 *
 * We connect to the PER-PAGE endpoint (`ws://127.0.0.1:19333/devtools/page/<id>`)
 * which gives a session scoped to exactly that target — no browser-level Target
 * enumeration (the part Electron implements incompletely and Playwright waits on).
 *
 * COMPATIBILITY
 * ─────────────
 * RawCdpPage implements the exact subset of the Playwright `Page`/`BrowserContext`
 * API that the (audited) helpers use — snapshotPage / actByRefOnPage /
 * getTextOnPage / extractFieldsOnPage / evalOnPage (browser-snapshot.ts),
 * extractIndexedElementsOnPage / captureAnnotatedScreenshotOnPage
 * (browser-dom-walker.ts), and exportStateFromContext / applyStateToPage
 * (browser-login-state.ts). Those files are NOT changed: only the transport is.
 * The dispatcher casts RawCdpPage to Playwright's `Page` type at the boundary.
 */
// Uses Bun's native global WebSocket (works for Electron CDP under Bun, unlike
// playwright-core's connectOverCDP). No `ws` package import — keeps types simple
// and the transport is the exact one validated to connect under Bun.

const CDP_PORT = 19333;
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;

type Json = Record<string, unknown>;

/** One CDP command/event multiplexer over a single page-scoped WebSocket. */
class CdpConnection {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: Json) => void>>();
  private closed = false;
  private readyPromise: Promise<void>;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onErr = () => reject(new Error("CDP WebSocket connection failed"));
      this.ws.addEventListener("open", () => { this.ws.removeEventListener("error", onErr); resolve(); }, { once: true });
      this.ws.addEventListener("error", onErr, { once: true });
    });
    this.ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  private onMessage(raw: string): void {
    let msg: Json;
    try { msg = JSON.parse(raw) as Json; } catch { return; }
    const id = msg.id as number | undefined;
    if (typeof id === "number" && this.pending.has(id)) {
      const { resolve, reject } = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve((msg.result as Json) ?? {});
      return;
    }
    const method = msg.method as string | undefined;
    if (method && this.listeners.has(method)) {
      for (const cb of this.listeners.get(method)!) {
        try { cb((msg.params as Json) ?? {}); } catch { /* listener error — ignore */ }
      }
    }
  }

  ready(): Promise<void> { return this.readyPromise; }
  isClosed(): boolean { return this.closed || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING; }

  on(method: string, cb: (params: Json) => void): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }

  send(method: string, params: Json = {}, timeoutMs = 30_000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.nextId;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } this.closed = true; }
}

/** Map "Enter"/"Tab"/… to the CDP key fields. Falls back to a single-char key. */
function keyDescriptor(key: string): { key: string; code: string; windowsVirtualKeyCode: number; text?: string } {
  const named: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Tab: { code: "Tab", vk: 9 },
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    Space: { code: "Space", vk: 32, text: " " },
  };
  if (named[key]) return { key, code: named[key].code, windowsVirtualKeyCode: named[key].vk, text: named[key].text };
  // Single printable char.
  const code = /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : (/^[0-9]$/.test(key) ? `Digit${key}` : "");
  return { key, code, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
}

/**
 * Playwright-`Page`-compatible shim over a raw CDP page session. Only the
 * methods the helpers actually call are implemented (see file header).
 */
/** A captured page console entry (for the browser_console agent tool). */
export interface ConsoleEntry { level: "log" | "info" | "warn" | "error" | "debug"; text: string; ts: number }
const CONSOLE_BUF_MAX = 200;

export class RawCdpPage {
  private conn: CdpConnection;
  private _url = "about:blank";
  private _closed = false;
  private consoleBuf: ConsoleEntry[] = [];

  private constructor(conn: CdpConnection, initialUrl: string) {
    this.conn = conn;
    this._url = initialUrl || "about:blank";
    // Capture page console + uncaught exceptions into a ring buffer so the
    // browser_console agent tool can report recent errors/logs. Runtime is
    // enabled in connect(); listeners registered here catch everything after.
    const pushConsole = (level: ConsoleEntry["level"], text: string) => {
      if (!text || text.includes("§§TOPICS_PAGE_CLOSE§§")) return; // skip the window.close sentinel
      this.consoleBuf.push({ level, text, ts: Date.now() });
      if (this.consoleBuf.length > CONSOLE_BUF_MAX) this.consoleBuf.shift();
    };
    this.conn.on("Runtime.consoleAPICalled", (p) => {
      const type = String((p as { type?: string }).type ?? "log");
      const level: ConsoleEntry["level"] =
        type === "error" || type === "assert" ? "error"
        : type === "warning" ? "warn"
        : type === "debug" ? "debug"
        : type === "info" ? "info" : "log";
      const args = ((p as { args?: unknown[] }).args ?? []) as Array<Record<string, unknown>>;
      const text = args.map((a) => {
        if (a == null) return "";
        if (typeof a.value === "string") return a.value;
        if (typeof a.value !== "undefined") { try { return JSON.stringify(a.value); } catch { return String(a.value); } }
        if (typeof a.description === "string") return a.description;
        if (typeof a.unserializableValue === "string") return a.unserializableValue;
        return a.type === "undefined" ? "undefined" : String(a.subtype ?? a.type ?? "");
      }).join(" ").trim();
      pushConsole(level, text);
    });
    this.conn.on("Runtime.exceptionThrown", (p) => {
      const d = (p as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
      pushConsole("error", d?.exception?.description ?? d?.text ?? "Uncaught exception");
    });
    // Keep _url current so url() can stay synchronous (Playwright's is sync).
    // Track BOTH full document navigations and SPA client-side route changes
    // (pushState/replaceState/hashchange fire navigatedWithinDocument, NOT
    // frameNavigated) — otherwise url() goes stale on single-page apps and the
    // navigate-idempotency check wrongly reloads.
    this.conn.on("Page.frameNavigated", (p) => {
      const frame = p.frame as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && typeof frame.url === "string") this._url = frame.url;
    });
    this.conn.on("Page.navigatedWithinDocument", (p) => {
      if (typeof p.url === "string") this._url = p.url as string;
    });
  }

  /** Connect to a target's per-page CDP endpoint and enable the domains we use. */
  static async connect(targetId: string): Promise<RawCdpPage> {
    const res = await fetch(`${CDP_HTTP}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = (await res.json()) as Array<{ id: string; type: string; url?: string; webSocketDebuggerUrl?: string }>;
    const t = targets.find((x) => x.id === targetId && x.type === "page");
    if (!t?.webSocketDebuggerUrl) {
      throw new Error(`RawCdpPage: no live page target for ${targetId} (stale — re-open the browser pane)`);
    }
    const conn = new CdpConnection(t.webSocketDebuggerUrl);
    await conn.ready();
    const page = new RawCdpPage(conn, t.url ?? "about:blank");
    // Enable the domains the ops rely on. Page+Runtime are required; DOM/Network
    // back screenshots/cookies. Best-effort: a domain that's already enabled is fine.
    await Promise.all([
      conn.send("Page.enable").catch(() => {}),
      conn.send("Runtime.enable").catch(() => {}),
      conn.send("DOM.enable").catch(() => {}),
      conn.send("Network.enable").catch(() => {}),
    ]);
    return page;
  }

  isClosed(): boolean { return this._closed || this.conn.isClosed(); }
  close(): void { this._closed = true; this.conn.close(); }
  url(): string { return this._url; }

  /** Recent captured console entries (newest last). Optionally filter by level
   *  and cap the count (most-recent kept). */
  getConsole(opts?: { level?: "all" | "errors" | "warnings"; limit?: number }): ConsoleEntry[] {
    let out = this.consoleBuf;
    if (opts?.level === "errors") out = out.filter((e) => e.level === "error");
    else if (opts?.level === "warnings") out = out.filter((e) => e.level === "error" || e.level === "warn");
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50;
    return out.slice(-limit);
  }

  async title(): Promise<string> {
    try { return (await this.evaluate("document.title")) as string; } catch { return ""; }
  }

  /**
   * Evaluate a function (with one JSON-serializable arg) OR a string expression
   * in the page, mirroring Playwright's `page.evaluate`. Returns the value
   * (returnByValue) and resolves awaited promises (awaitPromise).
   */
  async evaluate(pageFunction: unknown, arg?: unknown): Promise<unknown> {
    let expression: string;
    if (typeof pageFunction === "function") {
      const fnStr = (pageFunction as { toString(): string }).toString();
      const argStr = arg !== undefined ? JSON.stringify(arg) : "";
      expression = `(${fnStr})(${argStr})`;
    } else {
      // String form: evalOnPage wraps user code in an async IIFE; SNAPSHOT etc.
      // never reach here. Evaluate as a page expression (never in Node).
      expression = String(pageFunction);
    }
    const r = await this.conn.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    const exc = r.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    if (exc) throw new Error(exc.exception?.description || exc.text || "evaluate failed");
    const result = r.result as { value?: unknown } | undefined;
    return result?.value;
  }

  /**
   * Evaluate agent-supplied code with CONSOLE / executeJavaScript semantics:
   * `replMode` returns the completion value of the LAST expression (so a bare
   * `localStorage.getItem('t')` yields its value, not `{}`), and supports
   * `const`/`let`, multiple statements, and top-level `await`. This is what
   * browser_eval needs — the old `(async()=>{…})()` wrapper discarded the value.
   * Code runs in the page sandbox only (never in Node).
   */
  async replEvaluate(expression: string): Promise<unknown> {
    const r = await this.conn.send("Runtime.evaluate", {
      expression,
      replMode: true,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    const exc = r.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    if (exc) throw new Error(exc.exception?.description || exc.text || "eval failed");
    return (r.result as { value?: unknown } | undefined)?.value;
  }

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const timeout = opts?.timeout ?? 30_000;
    const loaded = this.waitForEvent("Page.loadEventFired", timeout).catch(() => {});
    const r = await this.conn.send("Page.navigate", { url }, timeout);
    if ((r as { errorText?: string }).errorText) {
      throw new Error(`navigate failed: ${(r as { errorText?: string }).errorText}`);
    }
    this._url = url;
    if (opts?.waitUntil !== "commit") await loaded;
  }

  async reload(_opts?: { waitUntil?: string }): Promise<void> {
    const loaded = this.waitForEvent("Page.loadEventFired", 20_000).catch(() => {});
    await this.conn.send("Page.reload", {});
    await loaded;
  }

  async waitForLoadState(_state?: string): Promise<void> {
    // The pane is interactive by the time agents call this; resolve fast.
    await this.waitForEvent("Page.loadEventFired", 5_000).catch(() => {});
  }

  async content(): Promise<string> {
    return (await this.evaluate("document.documentElement.outerHTML")) as string;
  }

  async screenshot(opts?: { type?: string; quality?: number; fullPage?: boolean }): Promise<Buffer> {
    const format = opts?.type === "png" ? "png" : "jpeg";
    const params: Json = { format, captureBeyondViewport: !!opts?.fullPage };
    if (format === "jpeg") params.quality = opts?.quality ?? 70;
    if (opts?.fullPage) {
      const m = await this.conn.send("Page.getLayoutMetrics").catch(() => ({} as Json));
      const css = (m as { cssContentSize?: { width: number; height: number } }).cssContentSize;
      if (css) params.clip = { x: 0, y: 0, width: css.width, height: css.height, scale: 1 };
    }
    const r = await this.conn.send("Page.captureScreenshot", params);
    return Buffer.from((r as { data: string }).data ?? "", "base64");
  }

  // ── Input (mouse / keyboard) — used by cdpOps.dispatchInput ───────────────
  mouse = {
    click: async (x: number, y: number, opts?: { clickCount?: number }) => this.clickAt(x, y, opts?.clickCount ?? 1),
    move: async (x: number, y: number) => { await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); },
    wheel: async (deltaX: number, deltaY: number) => {
      const at = await this.evaluate(() => ({ x: (window.innerWidth / 2) | 0, y: (window.innerHeight / 2) | 0 })) as { x: number; y: number };
      await this.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at?.x ?? 100, y: at?.y ?? 100, deltaX, deltaY });
    },
  };
  keyboard = {
    type: async (text: string) => { await this.conn.send("Input.insertText", { text }); },
    press: async (key: string) => this.pressKey(key),
  };

  private async clickAt(x: number, y: number, clickCount = 1): Promise<void> {
    const base = { x, y, button: "left" as const, clickCount };
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  private async pressKey(key: string): Promise<void> {
    const d = keyDescriptor(key);
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyDown", key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode, ...(d.text ? { text: d.text } : {}) });
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode });
  }

  /** Center of an element by CSS selector, after scrolling it into view. */
  private async centerOf(selector: string): Promise<{ x: number; y: number } | null> {
    return (await this.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, selector)) as { x: number; y: number } | null;
  }

  // ── Locator shim — actByRefOnPage / getTextOnPage drive elements by the
  //    `[data-topics-ref="N"]` attribute the snapshot injects. ───────────────
  locator(selector: string): CdpLocator { return new CdpLocator(this, selector); }

  // ── BrowserContext shim — login-state + import-chrome ─────────────────────
  context(): CdpContext { return new CdpContext(this); }
  /** Raw CDP escape hatch used by import-chrome (Network.setCookies, etc.). */
  newCDPSession(): { send: (m: string, p?: Json) => Promise<Json>; detach: () => Promise<void> } {
    return { send: (m, p) => this.conn.send(m, p ?? {}), detach: async () => {} };
  }

  /** @internal — Locator/Context reach through to the connection. */
  _send(method: string, params?: Json, timeoutMs?: number): Promise<Json> { return this.conn.send(method, params ?? {}, timeoutMs); }

  private waitForEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const off = this.conn.on(method, () => { clearTimeout(timer); off(); resolve(); });
    });
  }
}

const ACTION_DEFAULT_TIMEOUT = 15_000;

/** Minimal Playwright-Locator-compatible shim, scoped to a CSS selector. */
class CdpLocator {
  constructor(private page: RawCdpPage, private selector: string) {}
  first(): CdpLocator { return this; } // selector already targets a single ref

  async waitFor(opts?: { state?: string; timeout?: number }): Promise<void> {
    const deadline = Date.now() + (opts?.timeout ?? ACTION_DEFAULT_TIMEOUT);
    for (;;) {
      const present = await this.page.evaluate((sel: string) => !!document.querySelector(sel), this.selector);
      if (present) return;
      if (Date.now() > deadline) throw new Error(`locator.waitFor: ${this.selector} not found`);
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  private async requireCenter(): Promise<{ x: number; y: number }> {
    // @ts-expect-error — private reach within module is intentional for the shim.
    const c = await this.page.centerOf(this.selector);
    if (!c) throw new Error(`locator: ${this.selector} not visible/attached`);
    return c;
  }

  async click(_opts?: { timeout?: number }): Promise<void> {
    const c = await this.requireCenter();
    await this.page.mouse.move(c.x, c.y);
    await this.page.mouse.click(c.x, c.y, { clickCount: 1 });
  }
  async dblclick(_opts?: { timeout?: number }): Promise<void> {
    const c = await this.requireCenter();
    await this.page.mouse.click(c.x, c.y, { clickCount: 2 });
  }
  async hover(_opts?: { timeout?: number }): Promise<void> {
    const c = await this.requireCenter();
    await this.page.mouse.move(c.x, c.y);
  }
  async fill(text: string, _opts?: { timeout?: number }): Promise<void> {
    await this.page.evaluate((a: { sel: string; text: string }) => {
      const el = document.querySelector(a.sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) throw new Error("fill: element not found");
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, a.text); else (el as { value: string }).value = a.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { sel: this.selector, text });
  }
  async pressSequentially(text: string, _opts?: { delay?: number; timeout?: number }): Promise<void> {
    // Focus then insert the text as typed input (fires input events in-page).
    await this.requireCenter().then((c) => this.page.mouse.click(c.x, c.y)).catch(() => {});
    await this.page.keyboard.type(text);
  }
  async selectOption(value: string, _opts?: { timeout?: number }): Promise<void> {
    await this.page.evaluate((a: { sel: string; value: string }) => {
      const el = document.querySelector(a.sel) as HTMLSelectElement | null;
      if (!el) throw new Error("selectOption: element not found");
      let matched = false;
      for (const opt of Array.from(el.options)) {
        if (opt.value === a.value || opt.label === a.value || opt.text === a.value) { opt.selected = true; matched = true; }
      }
      if (!matched) el.value = a.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { sel: this.selector, value });
  }
  async check(_opts?: { timeout?: number }): Promise<void> { await this.setChecked(true); }
  async uncheck(_opts?: { timeout?: number }): Promise<void> { await this.setChecked(false); }
  private async setChecked(checked: boolean): Promise<void> {
    await this.page.evaluate((a: { sel: string; checked: boolean }) => {
      const el = document.querySelector(a.sel) as HTMLInputElement | null;
      if (!el) throw new Error("check: element not found");
      if (el.checked !== a.checked) { el.checked = a.checked; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }, { sel: this.selector, checked });
  }
  async press(key: string, _opts?: { timeout?: number }): Promise<void> {
    await this.requireCenter().then((c) => this.page.mouse.move(c.x, c.y)).catch(() => {});
    await this.page.evaluate((sel: string) => { (document.querySelector(sel) as HTMLElement | null)?.focus(); }, this.selector);
    await this.page.keyboard.press(key);
  }
  async innerText(_opts?: { timeout?: number }): Promise<string> {
    return (await this.page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? (el.innerText || "") : "";
    }, this.selector)) as string;
  }
  /** Best-effort ARIA outline (Playwright's ariaSnapshot is proprietary). */
  async ariaSnapshot(_opts?: { timeout?: number }): Promise<string> {
    return (await this.page.evaluate((sel: string) => {
      const root = document.querySelector(sel) || document.body;
      if (!root) return "";
      const lines: string[] = [];
      const walk = (el: Element, depth: number) => {
        if (depth > 12) return;
        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").trim().slice(0, 80).split("\n")[0];
        if (name) lines.push(`${"  ".repeat(depth)}- ${role} "${name}"`);
        for (const c of Array.from(el.children)) walk(c, depth + (name ? 1 : 0));
      };
      walk(root as Element, 0);
      return lines.slice(0, 400).join("\n");
    }, this.selector)) as string;
  }
}

interface StorageStateShape {
  cookies: unknown[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Minimal BrowserContext shim (cookies + storageState) over the page session. */
class CdpContext {
  constructor(private page: RawCdpPage) {}

  async addCookies(cookies: unknown[]): Promise<void> {
    await this.page._send("Network.setCookies", { cookies: cookies as never });
  }

  async storageState(): Promise<StorageStateShape> {
    const all = await this.page._send("Network.getAllCookies").catch(() => ({} as Json));
    const cookies = ((all as { cookies?: unknown[] }).cookies) ?? [];
    const origin = (() => { try { return new URL(this.page.url()).origin; } catch { return null; } })();
    const origins: StorageStateShape["origins"] = [];
    if (origin && origin !== "null") {
      const ls = await this.page.evaluate(() => {
        const out: Array<{ name: string; value: string }> = [];
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null) out.push({ name: k, value: localStorage.getItem(k) ?? "" }); } } catch { /* security */ }
        return out;
      }).catch(() => []) as Array<{ name: string; value: string }>;
      if (ls.length) origins.push({ origin, localStorage: ls });
    }
    return { cookies, origins };
  }

  /** import-chrome injects cookies via a CDP session on the page. */
  newCDPSession(): { send: (m: string, p?: Json) => Promise<Json>; detach: () => Promise<void> } {
    return this.page.newCDPSession();
  }
}
