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
 */
export function revalidatableJson(req: Request, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `"${Bun.hash(body).toString(36)}"`;
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ETag: etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
}
