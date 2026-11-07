// DIAG ONLY (branch diag/turn-end-manytool): every write to the chat scroller, every scroll event,
// and the geometry per frame when it changes. Not for main.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export function installScrollDiag(page: Page): Promise<void> {
  return page.addInitScript(() => {
    type Entry = Record<string, unknown>;
    const log: Entry[] = [];
    (Error as unknown as { stackTraceLimit: number }).stackTraceLimit = 40;
    // DIAG2: the browser's own scroll anchoring off on the chat scroller.
    const style = document.createElement("style");
    style.textContent = "[data-virtuoso-scroller] { overflow-anchor: none !important; }";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
    const w = window as unknown as { __diag: { log: Entry[] } };
    w.__diag = { log };
    const push = (e: Entry) => { if (log.length < 60_000) log.push(e); };
    const isChat = (el: Element | null): el is HTMLElement =>
      !!el && (el as HTMLElement).dataset?.virtuosoScroller !== undefined && !!el.closest?.('[data-testid="chat-scroll-container"]');
    const geo = (el: HTMLElement) => ({ st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight });
    const stack = () => (new Error().stack ?? "").split("\n").slice(3, 30).map((l) => l.trim());
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get!.call(this); },
      set(v: number) {
        if (!isChat(this)) { desc.set!.call(this, v); return; }
        const before = geo(this);
        desc.set!.call(this, v);
        push({ t: performance.now(), k: "st=", v, before, after: geo(this), stack: stack() });
      },
    });
    for (const name of ["scrollTo", "scrollBy"] as const) {
      const native = Element.prototype[name];
      Element.prototype[name] = function (this: Element, ...args: unknown[]) {
        if (!isChat(this)) return (native as (...a: unknown[]) => void).apply(this, args);
        const before = geo(this as HTMLElement);
        (native as (...a: unknown[]) => void).apply(this, args);
        push({ t: performance.now(), k: name, v: args, before, after: geo(this as HTMLElement), stack: stack() });
      } as typeof native;
    }
    document.addEventListener("scroll", (e) => {
      const el = e.target as Element;
      if (isChat(el)) push({ t: performance.now(), k: "scroll", ...geo(el) });
    }, true);
    let prev = "";
    const frame = () => {
      const el = document.querySelector('[data-testid="chat-scroll-container"] [data-virtuoso-scroller]') as HTMLElement | null;
      if (el) {
        const list = el.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement | null;
        const rows = list ? Array.from(list.children) as HTMLElement[] : [];
        const tail = rows.slice(-3).map((r) => `${r.dataset.index}:${r.dataset.knownSize}/${r.getBoundingClientRect().height.toFixed(3)}`);
        const group = el.querySelector('[data-testid="tool-group-row"]') as HTMLElement | null;
        const bubbles = el.querySelectorAll('[data-message-id][data-role="assistant"]');
        const bubble = bubbles[bubbles.length - 1] as HTMLElement | undefined;
        const meta = bubble?.querySelector('[data-testid="message-meta-row"]') as HTMLElement | null;
        const s = {
          ...geo(el),
          lh: list ? +list.getBoundingClientRect().height.toFixed(3) : null,
          pt: list?.style.paddingTop ?? null,
          pb: list?.style.paddingBottom ?? null,
          tail: tail.join(" "),
          g: group ? +group.getBoundingClientRect().height.toFixed(3) : null,
          bid: bubble?.dataset.messageId?.slice(0, 12) ?? null,
          bh: bubble ? +bubble.getBoundingClientRect().height.toFixed(3) : null,
          bt: bubble ? +bubble.getBoundingClientRect().top.toFixed(3) : null,
          mt: meta ? +meta.getBoundingClientRect().top.toFixed(3) : null,
          mh: meta ? +meta.getBoundingClientRect().height.toFixed(3) : null,
          ml: meta?.getAttribute("data-live") ?? null,
          loader: !!document.querySelector('[data-testid="chat-streaming-indicator"]'),
        };
        const key = JSON.stringify(s);
        if (key !== prev) { prev = key; push({ t: performance.now(), k: "frame", ...s }); }
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

/** Prints the diag log of the page, writes with their stacks mapped to the sources. */
export async function dumpScrollDiag(page: Page, who: string): Promise<void> {
  const log = await page.evaluate(() => (window as unknown as { __diag?: { log: Array<Record<string, unknown>> } }).__diag?.log ?? []);
  const t0 = (log.find((e) => e.k === "frame" && e.g !== null)?.t as number | undefined) ?? 0;
  console.log(`DIAG ${who} entries=${log.length} t0=${t0.toFixed(1)}`);
  for (const e of log) {
    const t = ((e.t as number) - t0).toFixed(1);
    if (e.k === "frame") {
      const { t: _t, k: _k, ...rest } = e;
      console.log(`DIAG ${who} ${t} F ${JSON.stringify(rest)}`);
    } else if (e.k === "scroll") {
      console.log(`DIAG ${who} ${t} S st=${e.st} sh=${e.sh} ch=${e.ch}`);
    } else {
      const st = (e.stack as string[]).map(mapFrame).join(" < ");
      console.log(`DIAG ${who} ${t} W ${e.k} ${JSON.stringify(e.v)} ${JSON.stringify(e.before)} -> ${JSON.stringify(e.after)} :: ${st}`);
    }
  }
}
