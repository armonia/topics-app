// SPA navigation fallback — the single, testable predicate deciding whether a
// request that fell through ALL api/asset/static routing should be served the
// app shell (public/index.html) instead of a 404.
//
// Client-side routes like `/task/<uuid>` (path-based board deep-links) have no
// file on disk; a full-page load (refresh / pasted link) must still boot the app
// so openTaskLink can read the path. But we must NOT mask real 404s: an unknown
// `/api/*` route or a missing asset (`/assets/foo.js`) has to stay a 404.
//
// This is called in server.ts AFTER every api/asset/static branch, so by the
// time we get here the request matched nothing on disk. The guard therefore only
// needs to recognize a NAVIGATION: a GET whose client wants HTML and whose path
// has no file extension (its last segment carries no '.'). `/api` and `/ws` are
// excluded defensively — an unmatched API call is a real 404, never the shell.

export interface SpaFallbackRequest {
  method: string;
  pathname: string;
  /** The request's `Accept` header (or null/empty if absent). */
  accept: string | null;
}

export function shouldServeSpaFallback({ method, pathname, accept }: SpaFallbackRequest): boolean {
  if (method !== "GET") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) return false;
  if (!(accept || "").includes("text/html")) return false;
  // Last path segment carries a file extension → it's an asset request that
  // already 404'd upstream; leave it 404 rather than serving HTML.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}
