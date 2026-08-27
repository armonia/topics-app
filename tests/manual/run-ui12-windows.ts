/**
 * Driver: runs the 12 measurements INSIDE the Chrome running ON WINDOWS.
 *
 * Speaks CDP straight to the PAGE websocket rather than the browser one: the
 * "browser" endpoint refuses a handshake arriving through an ssh tunnel because
 * Chrome checks its `Origin`, while the per-page endpoint accepts it. It is
 * also all we need: navigate to a URL and evaluate a script in the page.
 *
 * The tool is not the point — WHERE the engine runs is. Measuring this same DOM
 * on the Mac would say nothing about Windows, where the modifier is Ctrl (whose
 * labels are wider than ⌘), the system fonts differ, and the scrollbar takes up
 * space instead of overlaying.
 *
 * Usage (see tests/manual/ui12-windows.js for the full setup):
 *   ssh -f -N -L 9555:127.0.0.1:9333 -L 8199:127.0.0.1:8199 zorah@<host>
 *   bun run tests/manual/run-ui12-windows.ts
 */
import { readFileSync } from "node:fs";

const CDP = process.env.TOPICS_WIN_CDP ?? "http://127.0.0.1:9555";
const APP = process.env.TOPICS_WIN_UI ?? "http://127.0.0.1:8199/";
const SCRIPT = process.argv[2] ?? "tests/manual/ui12-windows.js";

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t: { type: string }) => t.type === "page");
if (!page) throw new Error("no page open in the remote Chrome");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((ok, ko) => {
  ws.addEventListener("open", () => ok());
  ws.addEventListener("error", () => ko(new Error("CDP: handshake refused")));
});

let seq = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
});
/**
 * A CDP call that CANNOT hang forever.
 *
 * Without the deadline this returned a promise that only ever settled if the
 * answer came back - and when the page's main thread is stuck (a script that
 * loops, a renderer wedged by an earlier evaluation) the answer never comes.
 * Measured: a run sat there for ten minutes saying nothing, and the wedged
 * renderer then refused even `1+1`, so the next attempt looked like a broken
 * tunnel instead of a busy page. A timeout turns a hang into a sentence.
 */
const cdp = (method: string, params: Record<string, unknown> = {}, ms = 45_000) =>
  new Promise<{ result?: { result?: { value?: string }, exceptionDetails?: unknown } }>((ok, ko) => {
    const id = ++seq;
    const bell = setTimeout(() => {
      pending.delete(id);
      ko(new Error(`CDP: ${method} did not answer within ${ms}ms - the page is probably wedged. Restart the remote Chrome (schtasks /End then /Run on topics-ui176-chrome, and delete the profile dir: a locked one makes Chrome fail to start silently).`));
    }, ms);
    pending.set(id, ((v: unknown) => { clearTimeout(bell); ok(v as never); }) as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });

await cdp("Page.enable");
await cdp("Runtime.enable");

// TAURI DECLARED BEFORE THE BUNDLE LOADS, and this is not faking the result.
// `WindowControls` renders only when `isTauriWindows` is true, and that flag is
// computed ONCE at module load from `window.__TAURI_INTERNALS__` plus the
// platform string. In a plain browser it is false, so the window buttons are
// simply not in the DOM and any check on them measures nothing.
//
// The platform half stays REAL: `navigator.platform` is Win32 because this is
// Windows. Only the shell marker is declared, and it has to be declared through
// `addScriptToEvaluateOnNewDocument` — set it after navigation and the module
// has already read it.
//
// What this cannot do is prove the buttons drive the actual window (minimize,
// maximize, close call into Tauri, which is not there). It proves what the fix
// 4a206509d changed: that they APPEAR with the Topics menu and go
// non-clickable with it. The native side stays a manual check.
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || { invoke: () => Promise.resolve() };",
});
await cdp("Page.navigate", { url: APP });
await new Promise((r) => setTimeout(r, 6_000));

const res = await cdp("Runtime.evaluate", {
  expression: readFileSync(SCRIPT, "utf8"),
  awaitPromise: true,
  returnByValue: true,
});
if (res.result?.exceptionDetails) {
  console.error("evaluation failed:", JSON.stringify(res.result.exceptionDetails).slice(0, 400));
  process.exit(1);
}
console.log(res.result?.result?.value ?? "(no result)");
ws.close();
