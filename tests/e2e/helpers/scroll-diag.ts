// DIAG ONLY (branch diag/turn-end-quick-wheel): every write to the chat scroller, every scroll and
// wheel event, the socket frames, the scroll authority's decisions, and the geometry per frame
// when it changes. Not for main.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export function installScrollDiag(page: Page): Promise<void> {
  return page.addInitScript(() => {
    type Entry = Record<string, unknown>;
    const log: Entry[] = [];
    (Error as unknown as { stackTraceLimit: number }).stackTraceLimit = 40;
    const w = window as unknown as { __diag: { log: Entry[]; push: (e: Entry) => void } };
    const push = (e: Entry) => { if (log.length < 80_000) log.push({ t: performance.now(), ...e }); };
    w.__diag = { log, push };
    const isChat = (el: Element | null): el is HTMLElement =>
      !!el && (el as HTMLElement).dataset?.virtuosoScroller !== undefined && !!el.closest?.('[data-testid="chat-scroll-container"]');
    const geo = (el: HTMLElement) => ({ st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight });
    const stack = () => (new Error().stack ?? "").split("\n").slice(3, 16).map((l) => l.trim());
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get!.call(this); },
      set(v: number) {
        if (!isChat(this)) { desc.set!.call(this, v); return; }
        const before = geo(this);
        desc.set!.call(this, v);
        push({ k: "st=", v, before, after: geo(this), stack: stack() });
      },
    });
    for (const name of ["scrollTo", "scrollBy"] as const) {
      const native = Element.prototype[name];
      Element.prototype[name] = function (this: Element, ...args: unknown[]) {
        if (!isChat(this)) return (native as (...a: unknown[]) => void).apply(this, args);
        const before = geo(this as HTMLElement);
        (native as (...a: unknown[]) => void).apply(this, args);
        push({ k: name, v: args, before, after: geo(this as HTMLElement), stack: stack() });
      } as typeof native;
    }
    document.addEventListener("scroll", (e) => {
      const el = e.target as Element;
      if (isChat(el)) push({ k: "scroll", ...geo(el) });
    }, true);
    window.addEventListener("wheel", (e) => push({ k: "wheel", dy: e.deltaY, mode: e.deltaMode }), true);
    const NativeWS = window.WebSocket;
    const Wrapped = function (this: WebSocket, ...args: ConstructorParameters<typeof WebSocket>) {
      const ws = new NativeWS(...args);
      ws.addEventListener("message", (ev) => {
        let type = "?";
        if (typeof ev.data === "string") {
          const m = ev.data.match(/"type"\s*:\s*"([^"]+)"/);
          type = m ? m[1]! : ev.data.slice(0, 40);
        }
        push({ k: "ws", type, n: typeof ev.data === "string" ? ev.data.length : -1 });
      });
      return ws;
    } as unknown as typeof WebSocket;
    Wrapped.prototype = NativeWS.prototype;
    Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Wrapped;
    let prev = "";
    let lastFrame = 0;
    const frame = () => {
      const now = performance.now();
      if (lastFrame && now - lastFrame > 40) push({ k: "gap", ms: Math.round(now - lastFrame) });
      lastFrame = now;
      const el = document.querySelector('[data-testid="chat-scroll-container"] [data-virtuoso-scroller]') as HTMLElement | null;
      if (el) {
        const list = el.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement | null;
        const rows = list ? Array.from(list.children) as HTMLElement[] : [];
        const tail = rows.slice(-3).map((r) => `${r.dataset.index}:${r.dataset.knownSize}/${r.getBoundingClientRect().height.toFixed(2)}`);
        const bubbles = el.querySelectorAll('[data-message-id][data-role="assistant"]');
        const bubble = bubbles[bubbles.length - 1] as HTMLElement | undefined;
        const meta = bubble?.querySelector('[data-testid="message-meta-row"]') as HTMLElement | null;
        const row = bubble?.querySelector('[data-testid="reasoning-row"]') as HTMLElement | null;
        const s = {
          ...geo(el),
          lh: list ? +list.getBoundingClientRect().height.toFixed(2) : null,
          pt: list?.style.paddingTop ?? null,
          pb: list?.style.paddingBottom ?? null,
          tail: tail.join(" "),
          bid: bubble?.dataset.messageId?.slice(0, 12) ?? null,
          bh: bubble ? +bubble.getBoundingClientRect().height.toFixed(2) : null,
          bt: bubble ? +bubble.getBoundingClientRect().top.toFixed(2) : null,
          rt: row ? +row.getBoundingClientRect().top.toFixed(2) : null,
          rh: row ? +row.getBoundingClientRect().height.toFixed(2) : null,
          mt: meta ? +meta.getBoundingClientRect().top.toFixed(2) : null,
          ml: meta?.getAttribute("data-live") ?? null,
          loader: !!document.querySelector('[data-testid="chat-streaming-indicator"]'),
        };
        const key = JSON.stringify(s);
        if (key !== prev) { prev = key; push({ k: "frame", ...s }); }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

type Consumer = { originalPositionFor(p: { line: number; column: number }): { source: string | null; line: number | null; name: string | null } };
const consumers = new Map<string, Consumer | null>();
function mapFrame(line: string): string {
  const m = line.match(/(\/assets\/[^:\s)]+\.js):(\d+):(\d+)/);
  if (!m) return line;
  const file = join(process.cwd(), "public", m[1]!);
  let c = consumers.get(file);
  if (c === undefined) {
    try {
      const req = createRequire(join(process.cwd(), "client", "package.json"));
      const { SourceMapConsumer } = req("source-map-js") as { SourceMapConsumer: new (raw: unknown) => Consumer };
      c = new SourceMapConsumer(JSON.parse(readFileSync(`${file}.map`, "utf8")));
    } catch (err) {
      console.log(`DIAG map fail ${file}: ${String(err).slice(0, 120)}`);
      c = null;
    }
    consumers.set(file, c);
  }
  if (!c) return line;
  const p = c.originalPositionFor({ line: Number(m[2]), column: Number(m[3]) - 1 });
  const src = (p.source ?? "?").replace(/^.*node_modules\//, "nm/").replace(/^.*\/src\//, "src/");
  return `${src}:${p.line}${p.name ? `(${p.name})` : ""}`;
}

/** Prints the diag log of the page between `from` and `to` (page clock), writes with their stacks mapped to the sources. */
export async function dumpScrollDiag(page: Page, who: string, span?: { from?: number; to?: number; t0?: number }): Promise<void> {
  const log = await page.evaluate(() => (window as unknown as { __diag?: { log: Array<Record<string, unknown>> } }).__diag?.log ?? []);
  const t0 = span?.t0 ?? 0;
  const from = span?.from ?? -Infinity;
  const to = span?.to ?? Infinity;
  const picked = log.filter((e) => (e.t as number) >= from && (e.t as number) <= to);
  console.log(`DIAG ${who} entries=${log.length} picked=${picked.length} t0=${t0.toFixed(1)}`);
  for (const e of picked) {
    const t = ((e.t as number) - t0).toFixed(1);
    const { t: _t, k, stack, ...rest } = e;
    if (k === "st=" || k === "scrollTo" || k === "scrollBy") {
      const st = (stack as string[]).map(mapFrame).filter((l) => !l.includes("react-dom")).slice(0, 8).join(" < ");
      console.log(`DIAG ${who} ${t} W ${k} ${JSON.stringify(rest.v)} ${JSON.stringify(rest.before)} -> ${JSON.stringify(rest.after)} :: ${st}`);
    } else if (stack) {
      const st = (stack as string[]).map(mapFrame).filter((l) => !l.includes("react-dom")).slice(0, 4).join(" < ");
      console.log(`DIAG ${who} ${t} ${String(k)} ${JSON.stringify(rest)} :: ${st}`);
    } else {
      console.log(`DIAG ${who} ${t} ${String(k)} ${JSON.stringify(rest)}`);
    }
  }
}
