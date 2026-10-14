/**
 * A JSON response the client can revalidate: it carries an ETag (a hash of the
 * body), and a request that sends the same value back in `If-None-Match` gets
 * a 304 with no body.
 *
 * WHY. The global board feed (`GET /api/all-boards/tasks`, ~155 KB) was read by
 * the desktop app every 5 s for days with nothing changing: 720 reads an hour,
 * measured 13-14/10 in the server log, each one parsed and diffed by the
 * webview to arrive at the same rows. The server still builds the feed to hash
 * it, but an unchanged answer no longer crosses the socket nor gets parsed.
 *
 * `no-store` stays, as in `json()`: the client sends `If-None-Match` itself, and
 * a conditional request set by the page bypasses the HTTP cache, so the 304
 * reaches the code that asked instead of being answered from a stale copy.
 *
 * THE ETAG MUST BE EXPOSED. The desktop shell reads the API cross-origin, from
 * `tauri://localhost`, and `ETag` is not a CORS-safelisted response header:
 * without `Access-Control-Expose-Headers` its fetch reads `ETag` as null, never
 * sends it back, and the shell (the client that re-read every 5 s) keeps paying
 * full bodies while every web test stays green. Harmless elsewhere: a foreign
 * origin gets no `Access-Control-Allow-Origin` (server.ts) and reads nothing.
 */
export function conditionalJson(req: Request, data: unknown): Response {
  const body = JSON.stringify(data);
  const tag = `"${Bun.hash(body).toString(36)}"`;
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ETag: tag,
    "Access-Control-Expose-Headers": "ETag",
  };
  if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
