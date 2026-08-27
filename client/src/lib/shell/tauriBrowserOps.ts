/**
 * Native-pane agent op executor (Tauri).
 *
 * When the server-side agent's browser tool-call is delegated to this client
 * (the pane is a native WKWebView the server can't reach via CDP), the WS handler
 * in useTauriBrowser runs it through here: each supported op maps to native
 * `browser_*` Tauri commands.
 *
 * The DOM-interaction ops (observe / act / extract / ref-scoped get_text) run by
 * INJECTING the SAME page-context functions the server uses (`SNAPSHOT_FN`,
 * `ACT_FN`, `EXTRACT_FN` from `shared/browser-snapshot-core`) via `browser_eval_js`,
 * and serialize with the SAME `serialize`/`diff` — so the agent reads the IDENTICAL
 * ref-based snapshot/diff format on the native pane and the Electron CDP pane.
 * One source of truth, no format drift.
 *
 * The login-state ops (save_state / load_state / import_chrome) split across the
 * delegation seam like browser_upload: the SERVER keeps everything that needs its
 * stack (handle persistence in the Topics + external stores, Chrome-cookie Keychain
 * decryption — see server/browser-native-state.ts) and delegates only the
 * pane-local legs here: the cookie store via the native `browser_pane_get_cookies`
 * / `browser_pane_set_cookies` commands (which speak the SAME Playwright
 * storageState cookie shape as the server store — get returns a JSON string of
 * them, set takes them directly and reports `{"set":n,"skipped":m}`; only
 * import_chrome's CDP-shape cookies get normalized, via browserLoginState.ts) and
 * localStorage via `browser_eval_js`. Vision (read_screen/point) is likewise server-orchestrated
 * (Moondream over a delegated native screenshot), so only genuinely unknown ops
 * fall through to the streaming-mode hint.
 *
 * `invoke` is injected so the mapping is unit-tested without a live Tauri runtime.
 */

import {
  SNAPSHOT_FN,
  ACT_FN,
  EXTRACT_FN,
  UPLOAD_FN,
  STATUS_JS,
  serialize,
  diff,
  REF_ACTIONS,
  ACT_ACTIONS,
  isStaleRefError,
  refAfterResnapshot,
  type Snapshot,
} from '../../../../shared/browser-snapshot-core';
import {
  toCookieJson,
  isHttpUrl,
  setLocalStorageJs,
  CAPTURE_LOCAL_STORAGE_JS,
  type StorageCookie,
  type StorageOrigin,
  type StorageState,
} from './browserLoginState';

export type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeOpOutcome {
  result?: unknown;
  error?: string;
}

// The native WKWebView pane is ALWAYS agent-drivable (no setting gates it). Only
// tools with NO native mapping at all reach this hint now — vision runs
// server-orchestrated (dispatcher nativeVisionOp) and the login-state ops run
// through server/browser-native-state.ts + the cases below, so in practice this
// is the "unknown/new tool" fallback.
const STREAMING_HINT =
  'this action needs the server browser stack, which the native pane can\'t run in-page yet. Use it on a streaming/CDP browser pane instead';

/**
 * Per-pane previous snapshot, so `browser_observe`/`browser_act` can return an
 * incremental diff (the client mirror of the server's `prevSnapshotCache`).
 */
const prevSnapshot = new Map<string, Snapshot>();

/** Drop a pane's cached snapshot (on navigate / close) so a later act can't
 *  resolve a stale ref. Exported for tests and the navigation path. */
export function clearNativeSnapshotCache(id?: string): void {
  if (id) prevSnapshot.delete(id);
  else prevSnapshot.clear();
}

/** Inject SNAPSHOT_FN into the page and parse the ref-based snapshot it returns. */
async function takeSnapshot(id: string, invoke: Invoke, max: number): Promise<Snapshot> {
  const js = `JSON.stringify((${SNAPSHOT_FN.toString()})(${JSON.stringify({ max })}))`;
  const raw = await invoke<string>('browser_eval_js', { id, js });
  return JSON.parse(raw) as Snapshot;
}

/** Ref-targeting act actions (require a ref) — the SHARED set, so this native
 *  validator can never drift from the server one. */
const REF_ACTION_SET = new Set<string>(REF_ACTIONS);

/**
 * Un file locale non arriva mai come `file://` — arriva come `/api/media?path=…`,
 * cioè un riferimento da risolvere sulla NOSTRA origine (server/browser-local-file-url.ts).
 *
 * Risolverlo qui e non sul server è il punto: la stessa app si serve su porte
 * diverse a seconda di chi guarda — il proxy in chiaro del guscio desktop, il
 * server in TLS, l'host che vede un telefono in LAN. `window.location.origin` è
 * l'unica risposta giusta per QUESTO client, e la sa solo lui.
 */
function absolutizeMediaRef(url: string): string {
  if (!url.startsWith('/api/media?path=')) return url;
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

/**
 * Poll until the pane's document is at `origin` (when given) and past 'loading' —
 * the native stand-in for Playwright's goto(waitUntil:'domcontentloaded'), since
 * `browser_navigate` returns before WKWebView finishes the load. Checks first,
 * then sleeps, so an already-settled page returns immediately; a mid-navigation
 * eval failure just retries. Best-effort: on timeout the caller proceeds anyway
 * (mirrors the server's catch-and-continue around goto).
 */
async function waitForPaneLoad(
  id: string,
  invoke: Invoke,
  origin: string | null,
  timeoutMs: number,
): Promise<void> {
  const probeJs = 'JSON.stringify({origin:location.origin,ready:document.readyState})';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = await invoke<string>('browser_eval_js', { id, js: probeJs });
      const s = JSON.parse(raw || '{}') as { origin?: string; ready?: string };
      if ((!origin || s.origin === origin) && s.ready && s.ready !== 'loading') return;
    } catch {
      /* execution context mid-swap — retry */
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Parse the Rust `browser_pane_set_cookies` reply (`{"set":n,"skipped":m}`) to
 *  the count that actually landed. A non-JSON/legacy reply falls back to the
 *  batch size so a successful set is never reported as zero. */
function parseSetCount(raw: unknown, batchSize: number): number {
  if (typeof raw === 'string') {
    try {
      const r = JSON.parse(raw) as { set?: unknown };
      if (typeof r.set === 'number') return r.set;
    } catch {
      /* legacy/void reply — fall through */
    }
  }
  return batchSize;
}

/** Batch cookie-set with per-cookie fallback (one bad cookie must not drop the
 *  rest) — mirror of the server applyStateToPage's addCookies strategy. The Rust
 *  command already skips individual cookies it rejects and reports the real
 *  `set` count, so the batch path is honest on its own; the per-cookie retry
 *  covers only a whole-batch throw (e.g. the pane vanished mid-call). Returns
 *  how many actually landed. */
async function setPaneCookies(id: string, invoke: Invoke, cookies: StorageCookie[]): Promise<number> {
  if (!cookies.length) return 0;
  try {
    const raw = await invoke('browser_pane_set_cookies', { id, cookies });
    return parseSetCount(raw, cookies.length);
  } catch {
    let n = 0;
    for (const c of cookies) {
      try {
        const raw = await invoke('browser_pane_set_cookies', { id, cookies: [c] });
        n += parseSetCount(raw, 1);
      } catch {
        /* skip the offending cookie */
      }
    }
    return n;
  }
}

export async function executeNativeBrowserOp(
  id: string,
  tool: string,
  args: unknown,
  invoke: Invoke,
): Promise<NativeOpOutcome> {
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (tool) {
      case 'browser_open': {
        const url = absolutizeMediaRef(typeof a.url === 'string' ? a.url : 'about:blank');
        await invoke('browser_navigate', { id, url });
        // Page navigated → any cached refs are stale.
        clearNativeSnapshotCache(id);
        return { result: { ok: true, url } };
      }
      case 'browser_observe': {
        const max =
          typeof a.max === 'number' ? a.max : typeof a.max_elements === 'number' ? a.max_elements : 200;
        const next = await takeSnapshot(id, invoke, max);
        const prev = prevSnapshot.get(id);
        prevSnapshot.set(id, next);
        let snapshot: string;
        let full: boolean;
        if (a.full || !prev) {
          snapshot = serialize(next);
          full = true;
        } else {
          const d = diff(prev, next);
          snapshot = d.text;
          full = d.full;
        }
        return { result: { url: next.url, title: next.title, count: next.elements.length, snapshot, full } };
      }
      case 'browser_act': {
        const ref =
          typeof a.ref === 'number' && Number.isFinite(a.ref)
            ? (a.ref as number)
            : typeof a.element_id === 'number' && Number.isFinite(a.element_id)
              ? (a.element_id as number)
              : undefined;
        const action = typeof a.action === 'string' ? a.action : '';
        if (!(ACT_ACTIONS as readonly string[]).includes(action)) {
          return { error: `browser_act: 'action' must be one of ${ACT_ACTIONS.join(', ')}` };
        }
        if (REF_ACTION_SET.has(action) && ref == null) {
          return { error: `browser_act: '${action}' requires 'ref' (number) from the latest browser_observe` };
        }
        if ((action === 'fill' || action === 'type') && typeof a.text !== 'string') {
          return { error: `browser_act ${action}: 'text' (string) is required` };
        }
        if (action === 'select' && typeof a.value !== 'string' && typeof a.text !== 'string') {
          return { error: "browser_act select: 'value' or 'text' (string) is required" };
        }

        // get_text reads — no mutation, no diff.
        if (action === 'get_text') {
          const max = typeof a.max === 'number' && a.max > 0 ? Math.floor(a.max) : 20000;
          const js =
            ref != null
              ? `((document.querySelector('[data-topics-ref="${ref}"]')||{}).innerText||'')`
              : `((document.body&&document.body.innerText)||'')`;
          const raw = await invoke<string>('browser_eval_js', { id, js });
          const text = (raw || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
          const truncated = text.length > max;
          return { result: { ok: true, action, ref, text: truncated ? text.slice(0, max) : text, truncated } };
        }

        const payload = { ref, action, text: a.text, value: a.value, key: a.key, dy: a.dy };
        const actJs = `JSON.stringify((${ACT_FN.toString()})(${JSON.stringify(payload)}))`;
        // preserveFocus: ACT_FN calls el.focus() on the target field (fill/type/press),
        // which would make this pane's WKWebView the OS key view and steal focus off
        // wherever the user is typing (e.g. another chat). The native eval saves and
        // restores the window's first-responder around the action so an agent act
        // never yanks the user's focus.
        const actRaw = await invoke<string>('browser_eval_js', { id, js: actJs, preserveFocus: true });
        let actRes: { ok: boolean; error?: string };
        try {
          actRes = JSON.parse(actRaw || '{"ok":false}');
        } catch {
          actRes = { ok: false, error: 'native act: malformed result' };
        }
        // THE REF IS GONE: same recovery as the server path (one shared rule in
        // browser-snapshot-core). Re-snapshot here instead of telling the caller
        // to observe: if the element is still on the page under another number,
        // act there once; if it is not, the error carries the fresh listing, so
        // the next call can be the action rather than an observe.
        let actedRef = ref;
        let staleNote = '';
        if (!actRes.ok && isStaleRefError(actRes.error) && ref != null) {
          const fresh = await takeSnapshot(id, invoke, 200);
          const again = refAfterResnapshot(prevSnapshot.get(id), fresh, ref);
          prevSnapshot.set(id, fresh);
          if (again == null) {
            return { error: `${actRes.error}\nFresh snapshot (already taken for you):\n${serialize(fresh)}` };
          }
          const retryJs = `JSON.stringify((${ACT_FN.toString()})(${JSON.stringify({ ...payload, ref: again })}))`;
          const retryRaw = await invoke<string>('browser_eval_js', { id, js: retryJs, preserveFocus: true });
          try {
            actRes = JSON.parse(retryRaw || '{"ok":false}');
          } catch {
            actRes = { ok: false, error: 'native act: malformed result' };
          }
          actedRef = again;
          staleNote = `(ref ${ref} was stale; re-snapshotted and acted on [${again}], same element.)`;
        }
        if (!actRes.ok) return { error: actRes.error || `browser_act ${action} failed` };

        // Return what changed so the agent doesn't need a separate observe.
        let snapshot: string | undefined;
        try {
          const prev = prevSnapshot.get(id);
          const next = await takeSnapshot(id, invoke, 200);
          prevSnapshot.set(id, next);
          snapshot = diff(prev, next).text;
        } catch {
          /* diff is best-effort */
        }
        // `untrusted`: the native pane drives ACT_FN's synthetic DOM events
        // (isTrusted=false), unlike the Electron CDP path's trusted Input.dispatch.
        // Surfaced so a caller whose action seemingly "did nothing" knows a site
        // that gates on trusted events (native pickers, some frameworks) is the
        // cause — fall back to streaming mode there. (Mutation/read ops only;
        // navigations and scrolls don't depend on trust.)
        const untrusted = action === 'scroll' ? undefined : true;
        if (staleNote) snapshot = snapshot ? `${staleNote}\n${snapshot}` : staleNote;
        return { result: { ok: true, action, ref: actedRef, snapshot, untrusted } };
      }
      case 'browser_upload': {
        // The server (dispatcher.readUploadFile) already read + base64'd the file
        // and delegated { ref, dataB64, filename, mime } — the WKWebView can't read
        // local disk. Run the SAME shared UPLOAD_FN the CDP/Playwright path uses to
        // set it on the <input type=file>. UPLOAD_FN returns a JSON string.
        const payload = {
          ref: typeof a.ref === 'number' ? (a.ref as number) : undefined,
          dataB64: typeof a.dataB64 === 'string' ? (a.dataB64 as string) : '',
          filename: typeof a.filename === 'string' ? (a.filename as string) : 'upload',
          mime: typeof a.mime === 'string' ? (a.mime as string) : 'application/octet-stream',
        };
        if (!payload.dataB64) return { error: 'browser_upload: missing file data' };
        const upJs = `(${UPLOAD_FN.toString()})(${JSON.stringify(payload)})`;
        const raw = await invoke<string>('browser_eval_js', { id, js: upJs });
        try {
          const res = JSON.parse(raw || '{"error":"native upload: no result"}') as { ok?: boolean; error?: string };
          return res.error ? { error: res.error } : { result: res };
        } catch {
          return { error: 'native upload: malformed result' };
        }
      }
      case 'browser_status': {
        // Real url/title/viewport/loading from the pane (fixes the 1280×720 stub).
        const raw = await invoke<string>('browser_eval_js', { id, js: STATUS_JS });
        try {
          return { result: JSON.parse(raw || '{}') };
        } catch {
          return { error: 'native status: malformed result' };
        }
      }
      case 'browser_extract': {
        const fields = coerceExtractFields(a);
        if (!Object.keys(fields).length) {
          return { error: 'browser_extract: \'fields\' (CSS-selector map) is required, e.g. {"title":"h1"}' };
        }
        const js = `JSON.stringify((${EXTRACT_FN.toString()})(${JSON.stringify(fields)}))`;
        const raw = await invoke<string>('browser_eval_js', { id, js });
        let extracted: Record<string, unknown> = {};
        try {
          extracted = JSON.parse(raw || '{}');
        } catch {
          extracted = {};
        }
        return { result: { extracted } };
      }
      case 'browser_eval': {
        const expression = typeof a.expression === 'string' ? a.expression : '';
        const r = await invoke<string>('browser_eval_js', { id, js: expression });
        return { result: r };
      }
      case 'browser_get_text': {
        const max = typeof a.max === 'number' && a.max > 0 ? Math.floor(a.max) : 50000;
        const ref = typeof a.ref === 'number' ? a.ref : undefined;
        // ref-scoped reads the observed element; otherwise the whole document.
        const js =
          ref != null
            ? `((document.querySelector('[data-topics-ref="${ref}"]')||{}).innerText||'').slice(0,${max})`
            : `((document.body&&document.body.innerText)||document.documentElement.innerText||'').slice(0,${max})`;
        const r = await invoke<string>('browser_eval_js', { id, js });
        return { result: r };
      }
      case 'browser_console': {
        const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 50;
        const level = a.level === 'errors' ? 'error' : a.level === 'warnings' ? 'warn' : 'all';
        const js =
          `JSON.stringify((window.__topicsConsole||[])` +
          (level === 'all' ? '' : `.filter(function(e){return e.level===${JSON.stringify(level)}})`) +
          `.slice(-${limit}))`;
        const raw = await invoke<string>('browser_eval_js', { id, js });
        let entries: unknown = [];
        try { entries = JSON.parse(raw || '[]'); } catch { entries = []; }
        return { result: entries };
      }
      case 'browser_save_state': {
        // EXPORT leg only: cookies from the pane's real cookie store (already
        // storageState-shaped — the Rust command speaks StorageCookie) + the
        // CURRENT origin's localStorage via eval (a WKWebView can only execute in
        // the loaded page — same practical scope as the other surfaces, hence the
        // shared "save while ON the site" guidance). The server persists the
        // returned StorageState under the handle in the Topics + external stores
        // (browser-native-state.ts): the pane has no disk access.
        const raw = await invoke<string>('browser_pane_get_cookies', { id });
        let cookies: StorageCookie[] = [];
        try {
          const parsed = JSON.parse(raw || '[]');
          if (Array.isArray(parsed)) cookies = parsed as StorageCookie[];
        } catch {
          /* malformed jar dump → no cookies (localStorage may still export) */
        }
        const origins: StorageOrigin[] = [];
        try {
          const lsRaw = await invoke<string>('browser_eval_js', { id, js: CAPTURE_LOCAL_STORAGE_JS });
          const parsed = JSON.parse(lsRaw || 'null') as StorageOrigin | null;
          if (parsed?.origin && Array.isArray(parsed.localStorage) && parsed.localStorage.length) {
            origins.push(parsed);
          }
        } catch {
          /* localStorage best-effort — cookies still exported */
        }
        return { result: { cookies, origins } satisfies StorageState };
      }
      case 'browser_load_state': {
        // APPLY leg only: the server already resolved the handle (Topics →
        // external fallback) and delegated with the state inlined. Mirror of the
        // server's applyStateToPage: cookies (batch → per-cookie fallback), then
        // per-http(s)-origin localStorage (requires visiting the origin), then
        // back to the original page — now authenticated.
        const state = (a.state ?? null) as StorageState | null;
        if (!state || !Array.isArray(state.cookies)) {
          return {
            error:
              "browser_load_state: missing resolved 'state'. The server resolves the handle before delegating to the native pane.",
          };
        }
        let origUrl = '';
        try {
          origUrl = await invoke<string>('browser_eval_js', { id, js: 'location.href' });
        } catch {
          /* blank pane */
        }

        const cookieCount = await setPaneCookies(
          id,
          invoke,
          state.cookies.map(toCookieJson).filter((c): c is StorageCookie => c != null),
        );

        let originCount = 0;
        for (const o of Array.isArray(state.origins) ? state.origins : []) {
          if (!o?.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
          // A state file is agent/peer-supplied data: never auto-navigate to a
          // non-web origin (e.g. a planted file:///) just to seed localStorage.
          if (!isHttpUrl(o.origin)) continue;
          try {
            await invoke('browser_navigate', { id, url: o.origin });
            await waitForPaneLoad(id, invoke, new URL(o.origin).origin, 8_000);
            await invoke<string>('browser_eval_js', { id, js: setLocalStorageJs(o.localStorage) });
            originCount++;
          } catch {
            /* origin unreachable — cookies still applied */
          }
        }

        // Return to where the pane was (now logged in), or reload if it was blank.
        try {
          if (origUrl && isHttpUrl(origUrl)) {
            await invoke('browser_navigate', { id, url: origUrl });
            await waitForPaneLoad(id, invoke, new URL(origUrl).origin, 8_000);
          } else {
            await invoke<string>('browser_eval_js', { id, js: 'location.reload()' });
          }
        } catch {
          /* navigation best-effort */
        }
        clearNativeSnapshotCache(id); // page navigated/reloaded → refs stale
        return { result: { ok: true, cookies: cookieCount, origins: originCount } };
      }
      case 'browser_import_chrome': {
        // INJECT leg only: dry_run and the Keychain decryption run SERVER-side
        // (browser-native-state.ts → integrations/chrome-cookies.ts); this leg
        // receives the already-decrypted CDP-shape cookies, normalizes them to
        // the storageState CookieJson shape the Rust jar takes (host-only `url`
        // cookies get a derived domain), lands them in the pane's cookie store,
        // and reloads — mirror of the CDP path's Network.setCookies + reload.
        const list = Array.isArray(a.cookies) ? (a.cookies as unknown[]) : [];
        if (!list.length) {
          return {
            error:
              "browser_import_chrome: missing decrypted 'cookies'. The server reads the Chrome store before delegating to the native pane.",
          };
        }
        const imported = await setPaneCookies(
          id,
          invoke,
          list.map(toCookieJson).filter((c): c is StorageCookie => c != null),
        );
        try {
          await invoke<string>('browser_eval_js', { id, js: 'location.reload()' });
        } catch {
          /* harmless if on about:blank */
        }
        clearNativeSnapshotCache(id); // page reloaded → refs stale
        return { result: { ok: true, imported } };
      }
      case 'browser_screenshot': {
        // Native WKWebView snapshot → base64 PNG. The agent's screenshot tool
        // expects { data } base64; mirror that shape so the streaming and native
        // panes are interchangeable to the caller.
        const data = await invoke<string>('browser_screenshot', { id });
        return { result: { data, mime: 'image/png', encoding: 'base64' } };
      }
      default:
        return {
          error: `browser tool '${tool}' is not supported on the native Tauri pane yet. ${STREAMING_HINT}.`,
        };
    }
  } catch (e) {
    return { error: `native op '${tool}' failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Coerce the legacy `{schema:{properties:{...}}}` shape into the CSS-selector
 * `fields` map (each property name treated as a selector) so old callers degrade
 * gracefully. Mirrors the server's coerceExtractFields.
 */
function coerceExtractFields(a: Record<string, unknown>): Record<string, unknown> {
  if (a.fields && typeof a.fields === 'object') {
    return a.fields as Record<string, unknown>;
  }
  const schema = a.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(schema.properties)) out[k] = k;
    return out;
  }
  return {};
}

/** The ops executeNativeBrowserOp actually runs (vs. routing to the streaming hint). */
export const NATIVE_SUPPORTED_OPS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_extract',
  'browser_eval',
  'browser_get_text',
  'browser_console',
  'browser_screenshot',
  'browser_upload',
  'browser_status',
  // Login-state legs (the server-side halves live in server/browser-native-state.ts).
  'browser_save_state',
  'browser_load_state',
  'browser_import_chrome',
]);
