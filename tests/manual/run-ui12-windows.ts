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
const cdp = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<{ result?: { result?: { value?: string }, exceptionDetails?: unknown } }>((ok) => {
    const id = ++seq;
    pending.set(id, ok as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });

await cdp("Page.enable");
await cdp("Runtime.enable");
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
