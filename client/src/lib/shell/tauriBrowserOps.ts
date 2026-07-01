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
 * Ops still bound to the server's Playwright/CDP stack (vision read_screen/point,
 * cookie save_state/load_state/import_chrome) return a structured error pointing
 * at streaming mode, rather than half-working — the agent gets a clear, actionable
 * failure. (Those are closed in later phases.)
 *
 * `invoke` is injected so the mapping is unit-tested without a live Tauri runtime.
 */

import {
  SNAPSHOT_FN,
  ACT_FN,
  EXTRACT_FN,
  UPLOAD_FN,
  serialize,
  diff,
  REF_ACTIONS,
  ACT_ACTIONS,
  type Snapshot,
} from '../../../../shared/browser-snapshot-core';

export type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeOpOutcome {
  result?: unknown;
  error?: string;
}

const STREAMING_HINT =
  'enable "Browser pilotabile dall\'agente" (streaming) in Settings → Appearance for full agent control of this pane';

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
        const url = typeof a.url === 'string' ? a.url : 'about:blank';
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
        const actRaw = await invoke<string>('browser_eval_js', { id, js: actJs });
        let actRes: { ok: boolean; error?: string };
        try {
          actRes = JSON.parse(actRaw || '{"ok":false}');
        } catch {
          actRes = { ok: false, error: 'native act: malformed result' };
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
        return { result: { ok: true, action, ref, snapshot, untrusted } };
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
      case 'browser_screenshot': {
        // Native WKWebView snapshot → base64 PNG. The agent's screenshot tool
        // expects { data } base64; mirror that shape so the streaming and native
        // panes are interchangeable to the caller.
        const data = await invoke<string>('browser_screenshot', { id });
        return { result: { data, mime: 'image/png', encoding: 'base64' } };
      }
      default:
        return {
          error: `browser tool '${tool}' is not supported on the native Tauri pane yet — ${STREAMING_HINT}.`,
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
]);
