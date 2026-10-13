/**
 * Point the DOM mirror's proxied resources at the data server.
 *
 * The server rewrites resources the viewer cannot reach to the relative path
 * `/api/browser/resource?…` (server/lib/dom-resource-rewrite.ts). Relative is
 * right on the web, where the page IS the server's origin. In the desktop shell
 * the page lives on `tauri://localhost`, so the same path resolved against it and
 * the Mac showed no images while the iPad, on the web, showed them all
 * (13/10). With a base, every occurrence (attributes, `srcset`, CSS `url()`)
 * gets it. The event is walked in place; an empty base leaves it untouched.
 */
const MARK = '/api/browser/resource?';

function fix(s: string, base: string): string {
  // Each event reaches this once, and the server only ever writes the bare path.
  return s.includes(MARK) ? s.split(MARK).join(`${base}${MARK}`) : s;
}

export function baseProxiedResources<T>(event: T, base: string): T {
  if (!base) return event;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fix(v, base);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = walk(o[k]);
    }
    return v;
  };
  return walk(event) as T;
}
