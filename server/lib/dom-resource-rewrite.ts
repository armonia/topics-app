import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Resource URLs in the DOM co-browse mirror that the VIEWER cannot reach.
 *
 * The mirror rebuilds the page inside the viewer's browser, so every `<img src>`
 * is fetched by the viewer, not by the Mac. Measured 13/10 from the iPad on a
 * page at `http://localhost:3535`: the mirror showed no images, because
 * `localhost` on the iPad is the iPad, and the page's login cookies live in the
 * headless context anyway. Such URLs are rewritten to
 * `/api/browser/resource?ctx=<id>&u=<url>`, which the server fetches through the
 * context itself (same network, same cookies). Public URLs are left alone: the
 * viewer loads them directly, without routing every image through the Mac.
 *
 * Walks rrweb events in place: FullSnapshot (type 2) and the mutation /
 * attribute payloads of IncrementalSnapshot (type 3, source 0).
 */

/** Tags whose `src` the mirror really loads. Not `<script>`: the replayer never
 *  runs scripts, and routing them only made the viewer download ~450 KB of
 *  modules per page for nothing (measured on darkroom, 13/10). */
const SOURCE_TAGS = new Set(["img", "source", "video", "audio", "track", "input", "image"]);
/** `<link rel>` values the mirror loads: icons, and a stylesheet rrweb could not
 *  inline. `modulepreload` and `preload` of scripts stay out, as above. */
const LOADED_LINK_TYPES = /(^|\s)(icon|apple-touch-icon|stylesheet)(\s|$)/i;
const RESOURCE_TOKEN_KEY = randomBytes(32);

export function domResourceToken(ctxId: string): string {
  return createHmac("sha256", RESOURCE_TOKEN_KEY).update(ctxId).digest("base64url");
}

export function hasDomResourceToken(ctxId: string, token: string | null): boolean {
  if (!token) return false;
  const expected = Buffer.from(domResourceToken(ctxId));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True for hosts that only resolve on the Mac: loopback, private ranges, mDNS. */
export function isViewerUnreachableHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function routedResourceUrl(ctxId: string, url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!isViewerUnreachableHost(parsed.hostname)) return null;
  return `/api/browser/resource?ctx=${encodeURIComponent(ctxId)}&u=${encodeURIComponent(url)}&token=${encodeURIComponent(domResourceToken(ctxId))}`;
}

function rewriteOne(ctxId: string, url: string): string {
  return routedResourceUrl(ctxId, url.trim()) ?? url;
}

function rewriteSourceSet(ctxId: string, value: string): string {
  return value.split(",").map((part) => {
    const [u, ...rest] = part.trim().split(/\s+/);
    return u ? [rewriteOne(ctxId, u), ...rest].join(" ") : part;
  }).join(", ");
}

function rewriteCssUrls(ctxId: string, css: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q: string, u: string) => {
    const next = routedResourceUrl(ctxId, u);
    return next ? `url(${q}${next}${q})` : whole;
  });
}

function loadsUrl(tag: string | undefined, name: string, attrs: Record<string, unknown>): boolean {
  // An attribute mutation does not carry its tag: route what points at an
  // unreachable host, where following it from the viewer would fail anyway.
  if (tag === undefined) return name === "src" || name === "poster" || name === "href";
  if (name === "src") return SOURCE_TAGS.has(tag);
  if (name === "poster") return tag === "video";
  // `href` is navigation on <a>; a resource only on <link> and SVG <image>.
  if (name === "href") return tag === "image" || (tag === "link" && LOADED_LINK_TYPES.test(String(attrs.rel ?? "")));
  return false;
}

function rewriteAttributes(ctxId: string, tag: string | undefined, attrs: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    if (loadsUrl(tag, name, attrs)) {
      attrs[name] = rewriteOne(ctxId, value);
    } else if (name === "srcset") {
      attrs[name] = rewriteSourceSet(ctxId, value);
    } else if (name === "style" || name === "_cssText") {
      attrs[name] = rewriteCssUrls(ctxId, value);
    }
  }
}

type RrNode = { type?: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: RrNode[]; textContent?: string };

function walk(ctxId: string, node: RrNode | undefined, parentTag?: string): void {
  if (!node || typeof node !== "object") return;
  if (node.type === 2 && node.attributes) rewriteAttributes(ctxId, node.tagName, node.attributes);
  // Text inside <style>: rrweb keeps the stylesheet as the text node's content.
  if (node.type === 3 && parentTag === "style" && typeof node.textContent === "string") {
    node.textContent = rewriteCssUrls(ctxId, node.textContent);
  }
  for (const child of node.childNodes ?? []) walk(ctxId, child, node.tagName);
}

/** Rewrite one rrweb event in place. Returns the same object. */
type RrData = {
  node?: RrNode;
  source?: number;
  adds?: { node?: RrNode }[];
  attributes?: { attributes?: Record<string, unknown> }[];
};

export function rewriteDomEventResources<E extends { type?: number; data?: unknown }>(ctxId: string, event: E): E {
  const d = event.data as RrData | undefined;
  if (!d) return event;
  if (event.type === 2) walk(ctxId, d.node);
  else if (event.type === 3 && d.source === 0) {
    for (const add of d.adds ?? []) walk(ctxId, add.node);
    // An attribute mutation does not carry the tag: `href` is rewritten only when
    // it points at an unreachable host, where following it would fail anyway.
    for (const a of d.attributes ?? []) if (a.attributes) rewriteAttributes(ctxId, undefined, a.attributes);
  }
  return event;
}
