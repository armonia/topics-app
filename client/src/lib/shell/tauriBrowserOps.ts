/**
 * Native-pane agent op executor (Tauri).
 *
 * When the server-side agent's browser tool-call is delegated to this client
 * (the pane is a native WKWebView the server can't reach via CDP), the WS handler
 * in useTauriBrowser runs it through here: each supported op maps to a native
 * `browser_*` Tauri command. Ops that would duplicate the server's Playwright
 * stack (DOM observe/act with refs, vision read_screen/point, Playwright-only
 * save_state/import_chrome) return a structured error pointing at streaming mode,
 * rather than half-working — the agent gets a clear, actionable failure.
 *
 * `invoke` is injected so the mapping is unit-tested without a live Tauri runtime.
 */

export type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeOpOutcome {
  result?: unknown;
  error?: string;
}

const STREAMING_HINT =
  'enable "Browser pilotabile dall\'agente" (streaming) in Settings → Appearance for full agent control of this pane';

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
        return { result: { ok: true, url } };
      }
      case 'browser_eval': {
        const expression = typeof a.expression === 'string' ? a.expression : '';
        const r = await invoke<string>('browser_eval_js', { id, js: expression });
        return { result: r };
      }
      case 'browser_get_text': {
        const max = typeof a.max === 'number' && a.max > 0 ? Math.floor(a.max) : 50000;
        // ref-scoped get_text isn't supported without the observe ref map; read the
        // whole document text (the common case) and cap it.
        const js = `((document.body&&document.body.innerText)||document.documentElement.innerText||'').slice(0,${max})`;
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

/** The ops executeNativeBrowserOp actually runs (vs. routing to the streaming hint). */
export const NATIVE_SUPPORTED_OPS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_eval',
  'browser_get_text',
  'browser_console',
  'browser_screenshot',
]);
